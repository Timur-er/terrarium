/**
 * World fork: copy the state, run branches with different interventions on the same dice,
 * and compare what happened after N days. The main world is never touched.
 */
import type { World, WorldStats, LogKind } from './types'
import { tick, runTimers, playCard, whisper, mulberry32 } from './engine'
import { getBrain, setBrain, HeuristicBrain } from './brain'
import { dayOf } from './text'

export interface Intervention { kind: 'card' | 'whisper'; id: string; charId?: string; targetId?: string; atDay?: number }
export interface BranchSpec { name: string; interventions: Intervention[] }
export interface ExperimentSpec { days: number; branches: BranchSpec[]; seed?: number }

export interface PersonOutcome { name: string; alive: boolean; left: boolean; money: number; joy: number; anger: number; home: string; goals: string[]; friends: number; enemies: number; family: number }
export interface BranchResult {
  name: string
  stats: WorldStats
  population: number
  buildings: number
  headlines: { day: number; text: string; kind: LogKind }[]
  chronicle: { day: number; title: string }[]
  people: Record<string, PersonOutcome>
}
export interface ExperimentResult { days: number; fromDay: number; branches: BranchResult[]; ms: number }

/** Deep copy without functions; the copy gets its own dice. */
export function cloneWorld(w: World, seed: number): World {
  const { rng: _r, brainQueue: _q, ...rest } = w
  const copy = JSON.parse(JSON.stringify(rest)) as World
  copy.rng = mulberry32(seed)
  copy.brainQueue = []
  copy.dirty = []
  return copy
}

function outcome(w: World): Record<string, PersonOutcome> {
  const out: Record<string, PersonOutcome> = {}
  for (const c of w.chars) {
    const rels = Object.values(c.relations)
    out[c.id] = {
      name: c.name.nom, alive: c.alive, left: c.left, money: c.money, joy: c.mood.joy, anger: c.mood.anger, home: c.home,
      goals: c.goals.map(g => g.text), friends: rels.filter(r => r.liking > 0.5).length, enemies: rels.filter(r => r.liking < -0.4).length, family: rels.filter(r => r.family).length,
    }
  }
  return out
}

export function runExperiment(base: World, spec: ExperimentSpec): ExperimentResult {
  const t0 = performance.now()
  const seed = spec.seed ?? Math.floor(Math.random() * 1e9)
  const previous = getBrain()
  setBrain(new HeuristicBrain()) // forks must run synchronously; the fast brain stands in for the slow one
  const fromDay = dayOf(base.t)
  const branches: BranchResult[] = []
  try {
    for (const b of spec.branches) {
      const w = cloneWorld(base, seed)
      const startT = w.t
      const pending = b.interventions.slice()
      const fire = (atT: number) => {
        for (let i = pending.length - 1; i >= 0; i--) {
          const iv = pending[i]
          if (startT + (iv.atDay ?? 0) * 1440 > atT) continue
          if (iv.kind === 'card') { delete w.cooldowns[iv.id]; playCard(w, iv.id, iv.targetId) }
          else if (iv.charId) whisper(w, iv.charId, iv.id, iv.targetId)
          pending.splice(i, 1)
        }
      }
      fire(w.t)
      for (let i = 0; i < spec.days * 1440; i++) { tick(w); runTimers(w); if (pending.length) fire(w.t) }
      const headlines = w.log.filter(e => e.t >= startT && e.weight >= 0.6).sort((x, y) => y.weight - x.weight).slice(0, 14).sort((x, y) => x.t - y.t).map(e => ({ day: dayOf(e.t), text: e.text, kind: e.kind }))
      branches.push({
        name: b.name, stats: w.stats, population: w.chars.filter(c => c.alive && !c.left).length, buildings: w.buildings.filter(x => x.type === 'house' && !x.site).length,
        headlines, chronicle: w.chronicle.filter(c => c.day >= fromDay).map(c => ({ day: c.day, title: c.title })), people: outcome(w),
      })
    }
  } finally {
    setBrain(previous)
  }
  return { days: spec.days, fromDay, branches, ms: Math.round(performance.now() - t0) }
}

/** Human-readable differences between two branches. */
export function diffBranches(a: BranchResult, b: BranchResult): string[] {
  const lines: string[] = []
  const s = (k: keyof WorldStats, label: string) => { const d = b.stats[k] - a.stats[k]; if (d !== 0) lines.push(`${label}: ${d > 0 ? '+' : ''}${d}`) }
  s('conflicts', 'quarrels'); s('kindness', 'good deeds'); s('rumors', 'rumors'); s('thefts', 'thefts'); s('weddings', 'weddings'); s('built', 'modules built')
  if (b.population !== a.population) lines.push(`population: ${b.population - a.population > 0 ? '+' : ''}${b.population - a.population}`)
  return lines
}

export function diffPeople(a: BranchResult, b: BranchResult): { id: string; name: string; text: string; weight: number }[] {
  const out: { id: string; name: string; text: string; weight: number }[] = []
  for (const id of Object.keys(a.people)) {
    const pa = a.people[id], pb = b.people[id]
    if (!pb) continue
    const parts: string[] = []
    let weight = 0
    if (pa.alive !== pb.alive) { parts.push(pb.alive ? 'survives in the second branch' : 'dies in the second branch'); weight += 3 }
    if (pa.left !== pb.left) { parts.push(pb.left ? 'leaves the colony in the second branch' : 'stays in the second branch'); weight += 2.5 }
    if (pa.home !== pb.home) { parts.push('lives in a different module'); weight += 1.5 }
    if (pb.family !== pa.family) { parts.push(pb.family > pa.family ? 'gains a family' : 'loses kin'); weight += 2 }
    const dm = pb.money - pa.money
    if (Math.abs(dm) >= 12) { parts.push(`${dm > 0 ? '+' : ''}${dm} credits`); weight += Math.min(1.5, Math.abs(dm) / 20) }
    if (pb.anger - pa.anger >= 0.3) { parts.push('far angrier'); weight += 1 }
    if (pa.anger - pb.anger >= 0.3) { parts.push('far calmer'); weight += 1 }
    if (pb.joy - pa.joy >= 0.3) { parts.push('noticeably happier'); weight += 1 }
    if (pa.joy - pb.joy >= 0.3) { parts.push('noticeably unhappier'); weight += 1 }
    if (pb.enemies - pa.enemies >= 1) { parts.push(`enemies made: +${pb.enemies - pa.enemies}`); weight += 0.8 }
    if (pb.friends - pa.friends >= 1) { parts.push(`new friends: +${pb.friends - pa.friends}`); weight += 0.8 }
    if (pa.friends - pb.friends >= 1) { parts.push(`friends lost: ${pb.friends - pa.friends}`); weight += 0.8 }
    const newGoals = pb.goals.filter(g => !pa.goals.includes(g))
    if (newGoals.length) { parts.push(`new goal: ${newGoals[0]}`); weight += 0.6 }
    if (parts.length) out.push({ id, name: pa.name, text: parts.join(', '), weight })
  }
  return out.sort((x, y) => y.weight - x.weight)
}
