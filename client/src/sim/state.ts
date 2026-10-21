import type { World, Character } from './types'
import { g, roleLabel, traitWords, needWords, moodWords, dayOf, hourOf, timeOfDayWord, cap } from './text'
import { wherePhrase } from './engine'

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

/** Relative time in words for a memory timestamp. */
function when(w: World, t: number): string {
  const d = dayOf(w.t) - dayOf(t)
  if (t < 0) return 'long ago'
  if (d <= 0) return 'today'
  if (d === 1) return 'yesterday'
  if (d === 2) return 'two sols ago'
  return `${d} sols ago`
}

/**
 * The state a System One brain reads: only what the character could know
 * and might be thinking about right now, in words, never in numbers.
 */
export function buildState(w: World, c: Character): string {
  const lines: string[] = []
  const role = roleLabel(c)
  const article = /^[aeiou]/i.test(role) ? 'an' : 'a'
  lines.push(`You are ${c.name.nom}, ${c.age}, ${article} ${role}${c.familyName ? ` of the ${c.familyName} family` : ''}. Character: ${traitWords(c).join(', ')}.`)

  const needs = needWords(c)
  const mood = moodWords(c)
  lines.push(`Now: ${needs.length ? needs.join(', ') : 'fed and rested'}. Mood: ${mood.join(', ')}.`)

  const h = hourOf(w.t)
  const open: string[] = []
  for (const b of w.buildings) {
    if (!b.open) continue
    const [a, z] = b.open
    const isOpen = a < z ? h >= a && h < z : h >= a || h < z
    const closingSoon = a < z && z - h === 1
    if (b.type === 'house') continue
    open.push(`the ${b.name.toLowerCase()} is ${closingSoon ? 'closing soon' : isOpen ? 'open' : 'closed'}`)
  }
  lines.push(`Time: ${timeOfDayWord(w.t)}, sol ${dayOf(w.t)}. ${cap(open.slice(0, 3).join(', '))}.`)

  // surroundings
  const here = wherePhrase(w, c.pos)
  const near = w.chars
    .filter(o => o !== c && o.alive && !o.left && dist(o.pos, c.pos) <= 6)
    .sort((a, b) => dist(a.pos, c.pos) - dist(b.pos, c.pos))
    .slice(0, 4)
  const nearText = near.length
    ? near.map(o => `${o.name.nom} (${roleLabel(o)}, ${o.activity.label})`).join('; ')
    : 'no one'
  lines.push(`You are ${here}. Nearby: ${nearText}.`)

  // relations that matter
  const rel = Object.entries(c.relations)
    .map(([id, r]) => ({ r, o: w.chars.find(x => x.id === id)! }))
    .filter(x => x.o && x.o.alive && !x.o.left)
    .map(x => ({ ...x, salience: Math.abs(x.r.liking) + Math.abs(x.r.trust) * 0.5 + (x.r.debt ? 1 : 0) + x.r.fear + (x.r.family ? 0.3 : 0) }))
    .sort((a, b) => b.salience - a.salience)
    .slice(0, 5)
  const relText = rel.map(({ r, o }) => {
    const parts: string[] = []
    if (r.family) parts.push('family')
    if (r.debt > 0) parts.push(`owes you ${r.debt} credits`)
    if (r.debt < 0) parts.push(`you owe ${g(o, 'him', 'her')} ${-r.debt} credits`)
    if (r.liking > 0.5) parts.push(r.trust > 0.4 ? 'friend, trusted' : 'close friend')
    else if (r.liking > 0.2) parts.push('acquaintance')
    else if (r.liking < -0.5) parts.push('enemy')
    else if (r.liking < -0.2) parts.push('grudge')
    if (r.trust < -0.3 && r.liking >= -0.5) parts.push('not trusted')
    if (r.fear > 0.4) parts.push('feared')
    return `${o.name.nom} — ${parts.join(', ') || 'acquaintance'}`
  })
  if (relText.length) lines.push(`Relations: ${relText.join('. ')}.`)

  // memories
  const seen = new Set<string>()
  const mems = [...c.longMemory, ...c.memory]
    .filter(m => { if (seen.has(m.text)) return false; seen.add(m.text); return true })
    .sort((a, b) => (b.weight + (b.t > w.t - 1440 ? 0.3 : 0)) - (a.weight + (a.t > w.t - 1440 ? 0.3 : 0)))
    .slice(0, 4)
  if (mems.length) lines.push(`Memories: ${mems.map(m => `${when(w, m.t)} ${m.text}${m.source === 'told' ? ' (so you were told)' : ''}${m.weight > 0.75 ? ' (it cut deep)' : ''}`).join('. ')}.`)

  // beliefs
  const beliefs = c.beliefs.slice().sort((a, b) => b.confidence - a.confidence).slice(0, 3)
  if (beliefs.length) lines.push(`Beliefs: ${beliefs.map(b => `${b.claim} (${b.confidence > 0.7 ? 'certain' : b.confidence > 0.45 ? 'seems true' : 'heard it somewhere'})`).join('. ')}.`)

  // goals
  const goals = c.goals.slice().sort((a, b) => b.priority - a.priority).slice(0, 3)
  if (goals.length) lines.push(`Goals: ${goals.map(gl => `${gl.text}${gl.source === 'player' ? ' (a nagging thought)' : ''}`).join('. ')}.`)
  if (c.needs.hunger > 0.5) lines.push('You feel like eating.')

  return lines.join('\n')
}
