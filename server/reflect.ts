/**
 * System Two: the slow LLM that never sits in the hot path.
 * Once a game day per character it writes a diary entry and nudges goals, relations, traits and beliefs.
 * Once a day per world it writes the chronicle. On demand it answers "why did you do that?" in character.
 */
import Anthropic from '@anthropic-ai/sdk'
import { buildState } from '../client/src/sim/state.ts'
import { dayOf, clock } from '../client/src/sim/text.ts'
import type { World, Character } from '../client/src/sim/types.ts'
import type { ServerMsg } from '../client/src/sim/protocol.ts'

const MODEL = process.env.SYSTEM_TWO_MODEL ?? 'claude-opus-5'
const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v))

const REFLECT_SYSTEM = `You are the inner voice of one colonist in a simulated colony under a dome. Once a day, at night, they
go over what they lived through. You write their diary in the first person and decide what changed in them. Do not soften
anything: people hold grudges, are unfair, sometimes generous. Do not invent events that are not in the memory. Write in
English. Reply with JSON only:
{"diary": "2–3 sentences in the first person, lively language, no pathos",
 "goal_updates": [{"add": "a goal in words", "priority": 0.0-1.0} | {"drop": "exact text of an existing goal"}],
 "relation_updates": [{"who": "Name", "trust": -1..1, "liking": -1..1, "why": "briefly"}],
 "trait_nudges": [{"trait": "trust|generosity|temper|honesty|sociability|courage", "delta": -0.05..0.05}],
 "belief_updates": [{"claim": "a statement", "confidence": 0.0-1.0, "about": "Name or empty"}]}
Lists may be empty. No more than two goal changes, three relations, one trait, two beliefs.`

const CHRONICLE_SYSTEM = `You are the chronicler of a colony under a dome. From the day's log write the chronicle: 3–5 story lines, coherent, like a
short third-person story, 120–200 words, no lists or headings inside the text. Names as in the log. Do not invent events
that did not happen. Write in English. Reply with JSON only: {"title": "a 3–6 word title for the day", "text": "the text"}`

const ASK_SYSTEM = `You are a colonist in a simulated colony under a dome. An observer is asking you a question. Answer in the first person,
2–4 sentences, lively language, based only on your state, memory and recent decisions. You may dodge, lie or take
offence if that is in character. Answer in English. No JSON, no explanations.`

interface ReflectOut {
  diary?: string
  goal_updates?: ({ add: string; priority?: number } | { drop: string })[]
  relation_updates?: { who: string; trust?: number; liking?: number; why?: string }[]
  trait_nudges?: { trait: string; delta: number }[]
  belief_updates?: { claim: string; confidence?: number; about?: string }[]
}

function extractJson<T>(text: string): T | null {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = m ? m[1] : text
  const s = body.indexOf('{'), e = body.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try { return JSON.parse(body.slice(s, e + 1)) as T } catch { return null }
}

export class SystemTwo {
  client: Anthropic | null = null
  enabled = false
  queue: (() => Promise<void>)[] = []
  running = false
  calls = 0

  constructor() {
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
      try { this.client = new Anthropic({ timeout: 60_000, maxRetries: 1 }); this.enabled = true } catch { this.enabled = false }
    }
  }

  private async call(system: string, user: string, maxTokens = 1200): Promise<string> {
    if (!this.client) throw new Error('System Two is off')
    this.calls++
    const res = await this.client.messages.create({
      model: MODEL, max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    })
    if (res.stop_reason === 'refusal') throw new Error('model refused')
    return res.content.filter(b => b.type === 'text').map(b => b.text).join('')
  }

  /** Queue the night's reflections and the day's chronicle; they run one at a time, spaced out. */
  scheduleDay(world: World, day: number, emit: (m: ServerMsg) => void) {
    if (!this.enabled) return
    for (const c of world.chars) if (c.alive && !c.left) this.queue.push(() => this.reflect(world, c, day, emit))
    this.queue.push(() => this.chronicle(world, day, emit))
    void this.drain()
  }

  /** Resolves when the reflection queue is empty (used by headless runs). */
  async idle() { while (this.running || this.queue.length) await new Promise(r => setTimeout(r, 200)) }

  private async drain() {
    if (this.running) return
    this.running = true
    while (this.queue.length) {
      const job = this.queue.shift()!
      try { await job() } catch (e) { console.warn('System Two:', String(e)) }
      await new Promise(r => setTimeout(r, 1500))
    }
    this.running = false
  }

  async reflect(world: World, c: Character, day: number, emit: (m: ServerMsg) => void) {
    const dayMems = c.memory.filter(m => dayOf(m.t) === day).map(m => `${clock(m.t)} ${m.text}${m.source === 'told' ? ' (hearsay)' : ''}`)
    const decisions = world.decisions.filter(d => d.charId === c.id && dayOf(d.t) === day).slice(-6).map(d => `${clock(d.t)} decided: ${d.chosen}`)
    const user = `${buildState(world, c)}\n\nWhat happened on sol ${day}:\n${dayMems.join('\n') || 'nothing special'}\n\nDecisions of the day:\n${decisions.join('\n') || 'the usual'}\n\nCurrent goals: ${c.goals.map(g => `«${g.text}»`).join(', ') || 'none'}.`
    const text = await this.call(REFLECT_SYSTEM, user)
    const out = extractJson<ReflectOut>(text)
    if (!out) return
    if (out.diary) {
      const entry = c.diary.find(d => d.day === day)
      if (entry) entry.text = out.diary; else c.diary.push({ day, text: out.diary })
      if (c.diary.length > 7) c.diary.shift()
    }
    const byName = (name: string) => world.chars.find(x => Object.values(x.name).includes(name))
    for (const g of (out.goal_updates ?? []).slice(0, 2)) {
      if ('drop' in g) c.goals = c.goals.filter(x => x.text !== g.drop)
      else if (g.add && c.goals.length < 6) c.goals.push({ id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text: g.add, priority: clamp(g.priority ?? 0.6, 0, 1), source: 'LLM' })
    }
    for (const r of (out.relation_updates ?? []).slice(0, 3)) {
      const o = byName(r.who); if (!o || o === c) continue
      const rel = c.relations[o.id]; if (!rel) continue
      rel.trust = clamp(rel.trust + clamp(r.trust ?? 0, -0.3, 0.3)); rel.liking = clamp(rel.liking + clamp(r.liking ?? 0, -0.3, 0.3))
    }
    for (const t of (out.trait_nudges ?? []).slice(0, 1)) {
      const k = t.trait as keyof Character['traits']
      if (k in c.traits) c.traits[k] = clamp(c.traits[k] + clamp(t.delta, -0.05, 0.05))
    }
    for (const b of (out.belief_updates ?? []).slice(0, 2)) {
      if (!b.claim) continue
      const about = b.about ? byName(b.about)?.id : undefined
      const ex = c.beliefs.find(x => x.claim === b.claim)
      if (ex) ex.confidence = clamp(b.confidence ?? ex.confidence, 0, 1); else c.beliefs.push({ claim: b.claim, confidence: clamp(b.confidence ?? 0.5, 0, 1), about })
      if (c.beliefs.length > 8) c.beliefs.shift()
    }
    emit({ type: 'toast', text: `${c.name.nom} wrote in the diary`, icon: '📓' })
  }

  async chronicle(world: World, day: number, emit: (m: ServerMsg) => void) {
    const lines = world.log.filter(e => dayOf(e.t) === day && e.weight >= 0.4).map(e => `${clock(e.t)} [${e.kind}] ${e.text}`)
    if (!lines.length) return
    const text = await this.call(CHRONICLE_SYSTEM, `Sol ${day}. Log:\n${lines.slice(0, 80).join('\n')}`, 900)
    const out = extractJson<{ title: string; text: string }>(text)
    if (!out?.text) return
    const entry = world.chronicle.find(ch => ch.day === day)
    if (entry) { entry.title = out.title || entry.title; entry.text = out.text } else world.chronicle.push({ day, title: out.title, text: out.text })
    emit({ type: 'toast', text: `the chronicle of sol ${day} is written`, icon: '📜' })
  }

  async ask(world: World, c: Character, question?: string): Promise<string> {
    if (!this.enabled) return `${c.name.nom} stays silent: System Two is off, set ANTHROPIC_API_KEY on the server.`
    const decisions = world.decisions.filter(d => d.charId === c.id).slice(-4).map(d => `${clock(d.t)} decided: ${d.chosen}`)
    const user = `${buildState(world, c)}\n\nRecent decisions:\n${decisions.join('\n') || 'the usual'}\n\nThe observer asks: ${question || 'Why did you do that?'}`
    return (await this.call(ASK_SYSTEM, user, 400)).trim()
  }
}
