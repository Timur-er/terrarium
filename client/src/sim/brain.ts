/**
 * System One brain: reads a verbal state and answers a small set of typed questions.
 * The format mirrors the TypeSafe-style API from the plan (choice / score / noul,
 * probabilities, confidence) so the backend is swappable with one config line.
 */

export type QuestionType = 'choice' | 'score' | 'noul'

export interface Question {
  id: string
  type: QuestionType
  text: string
  options?: string[]
  /** engine prior over options (normalised), local brains may use it */
  prior?: number[]
  range?: [number, number]
}

export interface Answer {
  id: string
  probabilities?: number[]
  score?: number
  /** noul: probability of "yes" */
  value?: number
  confidence?: number
}

export interface Brain {
  readonly kind: string
  /** Sync answers when the brain is local, a promise when it needs a network round-trip. */
  decide(state: string, questions: Question[]): Answer[] | Promise<Answer[]>
}

const norm = (a: number[]) => { const s = a.reduce((x, y) => x + y, 0) || 1; return a.map(x => x / s) }

/** The engine's own weights, packaged as a brain. This is the behaviour the mock had. */
export class HeuristicBrain implements Brain {
  readonly kind = 'heuristic'
  decide(_state: string, questions: Question[]): Answer[] {
    return questions.map(q => {
      if (q.type === 'choice') return { id: q.id, probabilities: q.prior ? norm(q.prior) : norm(q.options!.map(() => 1)), confidence: 0.6 }
      if (q.type === 'score') return { id: q.id, score: q.prior?.[0] ?? 0, confidence: 0.6 }
      return { id: q.id, value: q.prior?.[0] ?? 0.2, confidence: 0.6 }
    })
  }
}

/** Uniform dice: for debugging the engine without any brain. */
export class RandomBrain implements Brain {
  readonly kind = 'random'
  rng: () => number
  constructor(rng: () => number = Math.random) { this.rng = rng }
  decide(_state: string, questions: Question[]): Answer[] {
    return questions.map(q => {
      if (q.type === 'choice') return { id: q.id, probabilities: norm(q.options!.map(() => 0.2 + this.rng())), confidence: 0.3 }
      if (q.type === 'score') return { id: q.id, score: Math.floor(this.rng() * ((q.range?.[1] ?? 3) + 1)), confidence: 0.3 }
      return { id: q.id, value: this.rng(), confidence: 0.3 }
    })
  }
}

/**
 * Remote brain: POSTs {state, questions} to a service and expects {answers}.
 * The service can be so1 + vLLM, TypeSafe, or anything speaking this shape.
 * Model probabilities are blended with the engine prior so a bad answer never breaks the menu.
 */
/** Requests to the remote brain currently in flight (headless runs wait on it). */
export let remoteInFlight = 0

export class RemoteBrain implements Brain {
  readonly kind = 'remote'
  url: string
  priorBlend: number
  timeoutMs: number
  constructor(url: string, priorBlend = 0.35, timeoutMs = 2500) { this.url = url; this.priorBlend = priorBlend; this.timeoutMs = timeoutMs }
  async decide(state: string, questions: Question[]): Promise<Answer[]> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    remoteInFlight++
    try {
      const res = await fetch(this.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ state, questions: questions.map(q => ({ id: q.id, type: q.type, text: q.text, options: q.options, range: q.range })) }),
      })
      if (!res.ok) throw new Error(`brain ${res.status}`)
      const data = (await res.json()) as { answers: Answer[] }
      return questions.map(q => {
        const a = data.answers.find(x => x.id === q.id)
        if (!a) return new HeuristicBrain().decide(state, [q])[0]
        if (q.type === 'choice' && a.probabilities && q.prior) {
          const p = norm(a.probabilities.slice(0, q.options!.length)), pr = norm(q.prior)
          return { ...a, probabilities: norm(p.map((x, i) => x * (1 - this.priorBlend) + pr[i] * this.priorBlend)) }
        }
        return a
      })
    } finally { clearTimeout(timer); remoteInFlight-- }
  }
}

// ───────────────────────── current brain ─────────────────────────

let current: Brain = new HeuristicBrain()
export function setBrain(b: Brain) { current = b }
export function getBrain(): Brain { return current }

// ───────────────────────── decision protocol ─────────────────────────

export interface MenuOption { name: string; group: string; label: string; weight: number; risky?: boolean }

export const GROUP_LABEL: Record<string, string> = {
  need: 'look after yourself', eat: 'eat', work: 'work', social: 'be with people', goal: 'pursue your own business', rest: 'rest',
}

/** Two-stage menu: strategy over groups, then specifics inside each group, plus inner questions. */
export function buildQuestions(opts: MenuOption[], inner: { desperate: number; important: number; fear: number }): Question[] {
  const groups = Array.from(new Set(opts.map(o => o.group)))
  const qs: Question[] = []
  const groupWeight = (gname: string) => opts.filter(o => o.group === gname).reduce((s, o) => s + o.weight, 0)
  qs.push({ id: 'strategy', type: 'choice', text: 'What do you do now?', options: groups.map(gname => GROUP_LABEL[gname] ?? gname), prior: groups.map(groupWeight) })
  for (const gname of groups) {
    const os = opts.filter(o => o.group === gname)
    if (os.length < 2) continue
    qs.push({ id: `how:${gname}`, type: 'choice', text: `If you decide to «${GROUP_LABEL[gname] ?? gname}» — how exactly?`, options: os.map(o => o.label), prior: os.map(o => o.weight) })
  }
  qs.push({ id: 'desperate', type: 'score', text: 'How desperate are you?', range: [0, 3], prior: [inner.desperate] })
  qs.push({ id: 'important', type: 'noul', text: 'Is this moment important in your life?', prior: [inner.important] })
  qs.push({ id: 'fear', type: 'noul', text: 'Are you afraid of the consequences if you act dishonestly?', prior: [inner.fear] })
  return qs
}

export interface DecisionResult { option: MenuOption; probs: { label: string; p: number }[]; desperate: number; important: number; fear: number }

/** Turn answers into a sampled option: p(option) = p(group) · p(option | group), tempered by desperation. */
export function resolveDecision(opts: MenuOption[], answers: Answer[], rng: () => number, baseTemperature: number): DecisionResult {
  const groups = Array.from(new Set(opts.map(o => o.group)))
  const get = (id: string) => answers.find(a => a.id === id)
  const strat = get('strategy')?.probabilities ?? groups.map(() => 1 / groups.length)
  const desperate = Math.max(0, Math.min(3, get('desperate')?.score ?? 0))
  const important = get('important')?.value ?? 0
  const fear = get('fear')?.value ?? 0
  const probs = opts.map(o => {
    const gi = groups.indexOf(o.group)
    const pg = strat[gi] ?? 0
    const os = opts.filter(x => x.group === o.group)
    const how = get(`how:${o.group}`)?.probabilities
    const pi = os.length < 2 ? 1 : (how?.[os.indexOf(o)] ?? 1 / os.length)
    let p = pg * pi
    if (o.risky) p *= 1 - fear * 0.6
    return Math.max(1e-6, p)
  })
  const T = baseTemperature + desperate * 0.25
  const tempered = probs.map(p => Math.pow(p, 1 / T))
  const sum = tempered.reduce((a, b) => a + b, 0)
  let r = rng() * sum
  let chosen = opts[opts.length - 1]
  for (let i = 0; i < opts.length; i++) { r -= tempered[i]; if (r <= 0) { chosen = opts[i]; break } }
  const shown = opts.map((o, i) => ({ label: o.label, p: tempered[i] / sum })).sort((a, b) => b.p - a.p)
  return { option: chosen, probs: shown, desperate, important, fear }
}
