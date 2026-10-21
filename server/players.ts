/**
 * Multiplayer on top of the authoritative world:
 *  - players with a name and influence — cards and whispers cost it, presence earns it;
 *  - wards: each player may lead one colonist, whispers to the ward are free and land harder;
 *  - prediction markets: every morning the server asks a couple of questions about the day, players bet influence.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { World, Character } from '../client/src/sim/types.ts'

/** Looks a character up anywhere in the region (wards may live in any dome). */
export type CharFinder = (id: string | null) => Character | undefined
import type { PlayerPublic, Market } from '../client/src/sim/protocol.ts'
import { dayOf, hourOf } from '../client/src/sim/text.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const FILE = path.join(here, 'data', 'players.json')

export interface Player { id: string; token: string; name: string; influence: number; ward: string | null; correct: number; bets: number; online: boolean; lastSeen: number }

export const START_INFLUENCE = 20

export class Players {
  players = new Map<string, Player>()
  markets: Market[] = []
  private seq = 1

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { players: Player[]; markets: Market[]; seq: number }
      for (const p of raw.players) this.players.set(p.token, { ...p, online: false })
      this.markets = raw.markets ?? []
      this.seq = raw.seq ?? 1
    } catch { /* fresh */ }
  }

  save() {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify({ players: [...this.players.values()], markets: this.markets.slice(-40), seq: this.seq }))
  }

  hello(token: string, name: string): Player {
    let p = this.players.get(token)
    if (!p) {
      p = { id: `p${this.seq++}`, token, name: name || `observer-${this.seq}`, influence: START_INFLUENCE, ward: null, correct: 0, bets: 0, online: true, lastSeen: Date.now() }
      this.players.set(token, p)
    } else { p.online = true; p.lastSeen = Date.now(); if (name) p.name = name }
    return p
  }

  byId(id: string) { return [...this.players.values()].find(p => p.id === id) }

  /** Standing of a ward: friends, money, respect — the shared goal players compete on. */
  standing(find: CharFinder, charId: string | null): number {
    const c = find(charId)
    if (!c || !c.alive || c.left) return 0
    const rels = Object.values(c.relations)
    const friends = rels.filter(r => r.liking > 0.5).length, enemies = rels.filter(r => r.liking < -0.4).length
    const owed = rels.reduce((s, r) => s + Math.max(0, r.debt), 0)
    const trusted = Object.keys(c.relations).map(id => find(id)).filter(o => o && o !== c && o.alive && (o.relations[c.id]?.trust ?? 0) > 0.4).length
    return Math.round(friends * 2 - enemies * 2 + trusted * 1.5 + Math.min(20, c.money / 4) + owed / 5 + (c.role === 'elder' ? 12 : 0) + (c.home !== 'none' ? 2 : 0))
  }

  publicOf(find: CharFinder, p: Player): PlayerPublic {
    return { id: p.id, name: p.name, influence: p.influence, ward: p.ward, correct: p.correct, bets: p.bets, online: p.online, standing: this.standing(find, p.ward) }
  }

  list(find: CharFinder): PlayerPublic[] { return [...this.players.values()].filter(p => p.online || p.ward || p.bets > 0).map(p => this.publicOf(find, p)) }

  wardOwner(charId: string): Player | undefined { return [...this.players.values()].find(p => p.ward === charId) }

  /** Presence pays one influence per game hour to everyone online. */
  onTick(w: World) {
    if (w.t % 60 === 0) for (const p of this.players.values()) if (p.online) p.influence = Math.min(99, p.influence + 1)
  }

  // ───────────────────────── markets ─────────────────────────

  /** Two questions each morning at 06:00, resolving at 22:00 or as soon as the answer is known. */
  createMorningMarkets(w: World): Market[] {
    const day = dayOf(w.t)
    if (this.markets.some(m => m.day === day && m.dome === w.domeId) || hourOf(w.t) >= 20) return []
    const people = w.chars.filter(c => c.alive && !c.left && c.role !== 'child')
    const pick = (n: number, key: (c: Character) => number) => people.slice().sort((a, b) => key(b) - key(a)).slice(0, n)
    const thieves = pick(4, c => (1 - c.traits.honesty) + c.needs.hunger - c.money / 40 + w.rng() * 0.3)
    const hotheads = pick(4, c => c.traits.temper + c.mood.anger + w.rng() * 0.3)
    const t22 = w.t - (w.t % 1440) + 22 * 60
    const created: Market[] = [
      { id: `m${this.seq++}`, day, dome: w.domeId, question: 'Who gets caught stealing first today?', options: [...thieves.map(c => c.name.nom), 'nobody'], optionIds: [...thieves.map(c => c.id), null], createdT: w.t, resolveT: t22, odds: 3, bets: [] },
      { id: `m${this.seq++}`, day, dome: w.domeId, question: 'Who throws the first punch today?', options: [...hotheads.map(c => c.name.nom), 'nobody'], optionIds: [...hotheads.map(c => c.id), null], createdT: w.t, resolveT: t22, odds: 3, bets: [] },
      { id: `m${this.seq++}`, day, dome: w.domeId, question: 'How many rumors spread by evening?', options: ['fewer than 10', '10 to 25', 'more than 25'], createdT: w.t, resolveT: t22, odds: 2.5, bets: [], optionIds: undefined },
    ]
    ;(created[2] as Market & { base?: number }).base = w.stats.rumors
    this.markets.push(...created)
    return created
  }

  bet(p: Player, marketId: string, option: number, stake: number): string {
    const m = this.markets.find(x => x.id === marketId)
    if (!m || m.resolved) return 'betting is closed'
    if (option < 0 || option >= m.options.length) return 'no such option'
    stake = Math.max(1, Math.min(5, Math.floor(stake)))
    if (p.influence < stake) return 'not enough influence'
    if (m.bets.some(b => b.playerId === p.id)) return 'you already placed a bet'
    p.influence -= stake
    p.bets++
    m.bets.push({ playerId: p.id, option, stake })
    return ''
  }

  /** Resolve markets whose answer is known; returns human-readable results for toasts. */
  resolve(w: World): string[] {
    const out: string[] = []
    for (const m of this.markets) {
      if (m.resolved || (m.dome && m.dome !== w.domeId)) continue
      let answer: number | null = null
      const since = w.log.filter(e => e.t >= m.createdT)
      if (m.question.includes('stealing')) {
        // engine.ts resolveTheft: "{guard} caught {thief} red-handed"
        const hit = since.find(e => /caught .+ red-handed/.test(e.text))
        if (hit) { const idx = (m.optionIds ?? []).findIndex(id => id && hit.actors.includes(id) && hit.actors.indexOf(id) > 0); answer = idx >= 0 ? idx : m.options.length - 1 }
        else if (w.t >= m.resolveT) answer = m.options.length - 1
      } else if (m.question.includes('punch')) {
        // engine.ts fight: the line starts with the attacker's name followed by " hit "
        const hit = since.find(e => /^\S+ hit /.test(e.text))
        if (hit) { const idx = (m.optionIds ?? []).findIndex(id => id && hit.actors[0] === id); answer = idx >= 0 ? idx : m.options.length - 1 }
        else if (w.t >= m.resolveT) answer = m.options.length - 1
      } else if (m.question.includes('rumors')) {
        if (w.t >= m.resolveT) { const n = w.stats.rumors - ((m as Market & { base?: number }).base ?? 0); answer = n < 10 ? 0 : n <= 25 ? 1 : 2 }
      }
      if (answer === null) continue
      m.resolved = { answer, text: m.options[answer] }
      const winners: string[] = []
      for (const b of m.bets) {
        const p = this.byId(b.playerId)
        if (!p) continue
        if (b.option === answer) { p.influence = Math.min(99, p.influence + Math.round(b.stake * m.odds)); p.correct++; winners.push(p.name) }
      }
      out.push(`«${m.question}» — ${m.resolved.text}.${winners.length ? ' Called it: ' + winners.join(', ') : m.bets.length ? ' Nobody called it.' : ''}`)
    }
    return out
  }

  openMarkets(): Market[] { return this.markets.slice(-27) }

  /** Every morning at 06:00 spawn markets; returns them if created. */
  maybeMorning(w: World): Market[] {
    return hourOf(w.t) === 6 && w.t % 60 === 0 ? this.createMorningMarkets(w) : []
  }
}
