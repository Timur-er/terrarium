import type { Character, World, Relation, LogEntry } from './types'
import { ROLES } from './names'

export const g = (c: Character, m: string, f: string) => (c.name.sex === 'm' ? m : f)
export const roleLabel = (c: Character) => (c.name.sex === 'm' ? ROLES[c.role].m : ROLES[c.role].f)
export const dayOf = (t: number) => Math.floor(t / 1440) + 1
export const hourOf = (t: number) => Math.floor((t % 1440) / 60)
export const minuteOf = (t: number) => t % 60
export const clock = (t: number) => `${String(hourOf(t)).padStart(2, '0')}:${String(minuteOf(t)).padStart(2, '0')}`

export function timeOfDayWord(t: number) {
  const h = hourOf(t)
  if (h < 5) return 'dead of night'
  if (h < 8) return 'early morning'
  if (h < 12) return 'morning'
  if (h < 17) return 'afternoon'
  if (h < 21) return 'evening'
  return 'night'
}

export function needWords(c: Character): string[] {
  const out: string[] = []
  const n = c.needs
  if (n.hunger > 0.85) out.push('starving')
  else if (n.hunger > 0.6) out.push('hungry')
  if (n.sleep > 0.85) out.push('exhausted')
  else if (n.sleep > 0.6) out.push('sleepy')
  if (c.money < 3) out.push('broke')
  else if (c.money < 10) out.push('short on credits')
  if (n.social > 0.75) out.push('lonely')
  if (n.safety > 0.6) out.push('uneasy')
  if (c.sick) out.push('aching all over')
  if (c.drunk > 0.5) out.push('tipsy')
  return out
}

export function moodWords(c: Character): string[] {
  const out: string[] = []
  const m = c.mood
  if (m.anger > 0.7) out.push('furious')
  else if (m.anger > 0.4) out.push('angry')
  if (m.fear > 0.6) out.push('scared')
  else if (m.fear > 0.35) out.push('anxious')
  if (m.shame > 0.5) out.push('ashamed')
  else if (m.shame > 0.25) out.push('awkward')
  if (m.joy > 0.6) out.push('joyful')
  else if (m.joy > 0.35) out.push('cheerful')
  if (out.length === 0) out.push('even')
  return out
}

export function traitWords(c: Character): string[] {
  const t = c.traits
  const out: string[] = []
  if (t.temper > 0.45) out.push('hot-tempered')
  else if (t.temper < -0.45) out.push('calm')
  if (t.honesty > 0.45) out.push('honest')
  else if (t.honesty < -0.35) out.push('sly')
  if (t.generosity > 0.45) out.push('generous')
  else if (t.generosity < -0.45) out.push('stingy')
  if (t.sociability > 0.45) out.push('outgoing')
  else if (t.sociability < -0.45) out.push('withdrawn')
  if (t.courage > 0.5) out.push('brave')
  else if (t.courage < -0.5) out.push('timid')
  if (t.trust > 0.5) out.push('trusting')
  else if (t.trust < -0.5) out.push('suspicious')
  if (out.length === 0) out.push('ordinary')
  return out
}

export function relationWord(r: Relation, _other: Character): string {
  if (r.family) return 'family'
  if (r.debt > 0) return `owes me ${r.debt}`
  if (r.debt < 0) return `I owe ${-r.debt}`
  if (r.fear > 0.5) return 'feared'
  if (r.liking > 0.6 && r.trust > 0.4) return 'close friend'
  if (r.liking > 0.55) return 'friend'
  if (r.liking > 0.25) return 'friendly'
  if (r.liking < -0.5) return 'enemy'
  if (r.liking < -0.2) return 'grudge'
  if (r.trust < -0.3) return 'distrusted'
  return 'acquaintance'
}

export function relationTone(r: Relation): 'warm' | 'cold' | 'neutral' | 'family' {
  if (r.family) return 'family'
  if (r.liking > 0.3) return 'warm'
  if (r.liking < -0.25 || r.trust < -0.3) return 'cold'
  return 'neutral'
}

export function thoughts(w: World, c: Character): string[] {
  const out: string[] = []
  const nw = needWords(c)
  if (nw.length) out.push(cap(nw.join(', ')) + '.')
  const mw = moodWords(c)
  if (mw[0] !== 'even') out.push(cap(mw.join(', ')) + '.')
  // strongest relations
  const rel = Object.entries(c.relations)
    .map(([id, r]) => ({ id, r, ch: w.chars.find(x => x.id === id)! }))
    .filter(x => x.ch && x.ch.alive)
  const worst = rel.filter(x => !x.r.family).sort((a, b) => a.r.liking - b.r.liking)[0]
  if (worst && worst.r.liking < -0.3) {
    const mem = [...c.longMemory, ...c.memory].filter(m => m.culprit === worst.id).sort((a, b) => b.weight - a.weight)[0]
    out.push(`${worst.ch.name.nom} — ${worst.r.liking < -0.6 ? 'enemy' : 'not my kind'}${mem ? ': ' + low(w, mem.text) : ''}.`)
  }
  const debtor = rel.find(x => x.r.debt > 0)
  if (debtor) out.push(`${debtor.ch.name.nom} owes me ${debtor.r.debt} credits and keeps stalling.`)
  const creditor = rel.find(x => x.r.debt < 0)
  if (creditor) out.push(`I should pay ${creditor.ch.name.nom} back the ${-creditor.r.debt} credits${c.money < -creditor.r.debt ? ', but there is nothing to pay with' : ''}.`)
  const best = rel.filter(x => !x.r.family).sort((a, b) => b.r.liking - a.r.liking)[0]
  if (best && best.r.liking > 0.5) out.push(`${best.ch.name.nom} — ${best.r.trust > 0.4 ? 'a friend, one I can trust' : 'a good person'}.`)
  const goal = c.goals.slice().sort((a, b) => b.priority - a.priority)[0]
  if (goal) out.push(`I want to ${goal.text}.`)
  const lastMem = [...c.memory].sort((a, b) => b.weight - a.weight)[0]
  if (lastMem && lastMem.weight > 0.45) out.push(`I remember: ${low(w, lastMem.text)}.`)
  const belief = c.beliefs.sort((a, b) => b.confidence - a.confidence)[0]
  if (belief) out.push(`${cap(belief.claim)}. ${belief.confidence > 0.7 ? 'No doubt about it' : 'So they say'}.`)
  if (out.length < 2) {
    const h = hourOf(w.t)
    const flavor = ROLE_THOUGHTS[c.role]
    if (flavor) out.push(flavor[h < 12 ? 0 : h < 18 ? 1 : 2])
    const fam = rel.filter(x => x.r.family && x.ch.id !== c.id).map(x => x.ch.name.nom)
    if (fam.length && out.length < 3) out.push(fam.length === 1 ? `At home there is ${fam[0]} — that is all the family I have.` : `At home there are ${fam.slice(0, 3).join(', ')} — they are what I live for.`)
    if (c.money > 30 && out.length < 3) out.push('There are credits put by, but the neighbours need not know.')
    if (c.traits.trust < -0.4 && out.length < 3) out.push('Trusting people costs more than it is worth.')
    if (out.length < 2) out.push(h < 12 ? 'The day is only starting — we will see what it brings.' : h < 18 ? 'Same as always. Same as always is good.' : 'The day is over and nothing went wrong. Thank goodness.')
  }
  return out
}

const ROLE_THOUGHTS: Partial<Record<Character['role'], [string, string, string]>> = {
  smith: ['The compressor is wheezing again. A week of work orders.', 'The wrench knows the way itself. The hands remember.', 'Shoulders humming. Honestly earned.'],
  baker: ['The press is warm. The rations will be gone by noon.', 'The canteen smell carries across the whole plaza — let them envy.', 'The line is cooling down. Tomorrow it all starts over.'],
  merchant: ['Who has credits today? I will keep an eye out.', 'Depot stock never sits long if you talk it up right.', 'Balance the ledger. Show nobody more than they need.'],
  guard: ['A round of the plaza. Eyes open.', 'Someone is hiding something. Someone always is.', 'Night under the dome is prime time for those on bad terms with their conscience.'],
  teacher: ['The kids are noisy, but they listen. Sometimes.', 'Teaching them is like carrying water in a sieve. And yet.', 'Tomorrow I will check who remembers the formulas.'],
  priest: ['Morning service in the chapel. Whoever comes, comes.', 'More sins in this colony than lamps.', 'Pray for everyone, even those who never ask.'],
  farmer: ['To the hydroponics at dawn, or there is no keeping up.', 'Hydroponics never lie, unlike people.', 'My back aches. But there will be rations.'],
  innkeeper: ['Tank full, counter wiped. Let them come.', 'By evening the crowd drifts in. And tongues loosen.', 'Whoever drinks, talks. I know how to listen.'],
  miller: ['The reactor hums steady — a quiet day ahead.', 'Every watt counts. Every one.', 'Shift handed over, gauges nominal.'],
  elder: ['The colony holds as long as I hold it.', 'Settling disputes is like bailing water with a sieve.', 'Who is unhappy with the administrator today? I will find out tomorrow.'],
  healer: ['Check the filters and the stimulant stock.', 'They come to me when it is already too late.', 'The test results will be in by morning.'],
  carpenter: ['Welder charged, panels stacked.', 'The neighbours have a sealant leak — they will call on their own.', 'Hands full of burns, but the job is done.'],
  hunter: ['Quieter outside the dome than inside. And more honest.', 'Fresh tracks at the airlock. Someone went out at night.', 'Sample taken — so there is a report.'],
  weaver: ['The signal from Earth runs a day late. Patience.', 'The antenna needs tuning before the storm hits.', 'Fingers tired from the keys, but the link is clean.'],
  child: ['Can we go to the plaza already?', 'Who is it today?', 'Do not want to go home, but they are calling.'],
  old: ['Joints aching — pressure is about to drop.', 'The young understand nothing. Just like we did once.', 'Sit by the fountain, remember Earth.'],
  vagrant: ['Somewhere to eat where nobody chases me off.', 'People here give me looks. Used to it.', 'Sleeping by the bar again.'],
  stranger: ['Tell nobody where I came from.', 'A fresh start is possible here. If nobody asks.', 'They stare. Let them.'],
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/** Lowercase the first letter unless the text starts with a character's name (or the pronoun "I"). */
function low(w: World, s: string) {
  const first = s.split(/[\s,.:—']/)[0]
  if (first === 'I' || w.chars.some(c => Object.values(c.name).includes(first))) return s
  return s.charAt(0).toLowerCase() + s.slice(1)
}

export function statusEmoji(c: Character): string {
  if (!c.alive) return '✝'
  const a = c.activity.kind
  if (a === 'sleep') return '💤'
  if (a === 'fight') return '👊'
  if (a === 'quarrel') return '💢'
  if (a === 'steal') return '🤫'
  if (a === 'court') return '❤️'
  if (a === 'eat') return '🍞'
  if (a === 'drink') return '🍺'
  if (a === 'help') return '🤝'
  if (a === 'build') return '🪵'
  if (a === 'talk') return '💬'
  if (a === 'pray') return '🕯️'
  if (a === 'think') return '💭'
  if (a === 'leave') return '🧳'
  if (c.sick) return '🤒'
  if (c.mood.anger > 0.6) return '😠'
  if (c.mood.fear > 0.55) return '😨'
  if (c.mood.shame > 0.5) return '😳'
  if (a === 'work') return ROLES[c.role].icon
  if (a === 'play') return '🪁'
  if (c.needs.hunger > 0.85) return '🍽️'
  if (c.mood.joy > 0.65) return '🙂'
  return ''
}

export function diaryFor(_w: World, c: Character, day: number): string {
  const mems = [...c.memory].filter(m => dayOf(m.t) === day).sort((a, b) => b.weight - a.weight)
  const parts: string[] = []
  const mood = moodWords(c)
  if (mems[0]) parts.push(cap(mems[0].text) + '.')
  if (mems[1]) parts.push(cap(mems[1].text) + '.')
  if (parts.length === 0) parts.push('Worked, quarrelled with no one.')
  parts.push(mood[0] === 'even' ? 'A day like any other.' : `By night — ${mood.join(', ')}.`)
  const goal = c.goals.sort((a, b) => b.priority - a.priority)[0]
  if (goal) parts.push(`Not to forget: ${goal.text}.`)
  return parts.join(' ')
}

export const KIND_LABEL: Record<LogEntry['kind'], string> = {
  conflict: 'quarrels', kindness: 'kindness', rumor: 'rumors', trade: 'trade', life: 'life', player: 'player', world: 'world', love: 'hearts',
}
