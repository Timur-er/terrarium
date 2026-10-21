/**
 * Audience votes: a few times a day the watchers of a dome choose which event card hits it next.
 * Voting is free; the winning side earns a point of influence. The card is paid by the crowd, not by anyone.
 */
import { DECK } from '../client/src/sim/cards.ts'
import { playCard } from '../client/src/sim/engine.ts'
import type { World } from '../client/src/sim/types.ts'
import type { Vote } from '../client/src/sim/protocol.ts'
import { hourOf } from '../client/src/sim/text.ts'

export const VOTE_HOURS = [10, 14, 18]
export const VOTE_SECONDS = Number(process.env.VOTE_SECONDS ?? 75)

export class Votes {
  open = new Map<string, Vote & { ballots: Map<string, number>; playerIds: Set<string> }>() // by dome
  private seq = 1
  lastHour = new Map<string, number>()

  /** Opens a vote for a dome at the set hours if none is running; returns it when opened. */
  maybeOpen(w: World, watchers: number): Vote | null {
    const h = hourOf(w.t)
    if (w.t % 60 !== 0 || !VOTE_HOURS.includes(h) || watchers === 0 || this.open.has(w.domeId)) return null
    if (this.lastHour.get(w.domeId) === w.t) return null
    this.lastHour.set(w.domeId, w.t)
    const adults = w.chars.filter(c => c.alive && !c.left && !c.ghost && c.role !== 'child')
    const pool = DECK.filter(c => !w.cooldowns[c.id])
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(w.rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]] }
    const cards = pool.slice(0, 3)
    if (cards.length < 2 || !adults.length) return null
    const options = cards.map(c => {
      const target = c.needsTarget ? adults[Math.floor(w.rng() * adults.length)] : undefined
      return { id: c.id, icon: c.icon, label: target ? `${c.name} → ${target.name.nom}` : c.name, targetId: target?.id, votes: 0 }
    })
    options.push({ id: 'none', icon: '🫙', label: 'nothing, let them be', targetId: undefined, votes: 0 })
    const vote: Vote & { ballots: Map<string, number>; playerIds: Set<string> } = {
      id: `v${this.seq++}`, dome: w.domeId, question: `Viewers of ${w.domeName}: what happens today?`, options,
      endsAt: Date.now() + VOTE_SECONDS * 1000, ballots: new Map(), playerIds: new Set(),
    }
    this.open.set(w.domeId, vote)
    return this.publicOf(vote)
  }

  cast(dome: string, playerId: string, option: number): string {
    const v = this.open.get(dome)
    if (!v) return 'no vote is running'
    if (Date.now() > v.endsAt) return 'the vote is closed'
    if (option < 0 || option >= v.options.length) return 'no such option'
    const prev = v.ballots.get(playerId)
    if (prev !== undefined) v.options[prev].votes--
    v.ballots.set(playerId, option)
    v.options[option].votes++
    return ''
  }

  /** Closes votes whose time ran out, plays the winner; returns the closed votes with their result text. */
  resolve(worlds: World[], reward: (playerId: string) => void): (Vote & { text: string })[] {
    const out: (Vote & { text: string })[] = []
    for (const [dome, v] of this.open) {
      if (Date.now() < v.endsAt) continue
      this.open.delete(dome)
      const w = worlds.find(x => x.domeId === dome)
      const total = v.options.reduce((s, o) => s + o.votes, 0)
      let text: string
      let winner = -1
      if (!w || total === 0) text = 'nobody voted, no event was played'
      else {
        winner = v.options.map((o, i) => [o.votes, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])[0][1]
        const o = v.options[winner]
        if (o.id === 'none') text = `the viewers left ${w.domeName} alone (${o.votes} of ${total})`
        else {
          delete w.cooldowns[o.id]
          w.log.push({ id: w.logSeq++, t: w.t, text: `The audience in orbit has spoken: ${o.votes} of ${total} votes for «${o.label}»`, weight: 0.6, actors: o.targetId ? [o.targetId] : [], kind: 'player' })
          const res = playCard(w, o.id, o.targetId)
          text = `${o.icon} ${o.label}: ${res}`
        }
        for (const [pid, opt] of v.ballots) if (opt === winner) reward(pid)
      }
      out.push({ ...this.publicOf(v), result: { winner, text }, text })
    }
    return out
  }

  publicOf(v: Vote & { ballots?: Map<string, number> }): Vote {
    return { id: v.id, dome: v.dome, question: v.question, options: v.options.map(o => ({ ...o })), endsAt: v.endsAt, result: v.result }
  }
  current(dome: string): Vote | null { const v = this.open.get(dome); return v ? this.publicOf(v) : null }
  myVote(dome: string, playerId: string): number | null { const v = this.open.get(dome); const b = v?.ballots.get(playerId); return b === undefined ? null : b }
}
