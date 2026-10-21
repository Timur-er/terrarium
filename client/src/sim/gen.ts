import type { Character, Relation, World, Building } from './types'
import { MALE, FEMALE, FAMILIES, ROLES, type RoleId, type NameForms } from './names'

const shuffle = <T,>(arr: T[], rng: () => number) => {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}
const gauss = (rng: () => number) => (rng() + rng() + rng()) / 1.5 - 1 // -1..1, centered

export function newRelation(family = false): Relation {
  return { trust: family ? 0.7 : 0.1, liking: family ? 0.7 : 0.05, fear: 0, debt: 0, lastContact: -9999, family }
}

function makeChar(w: World, name: NameForms, age: number, role: RoleId, home: Building | null, family: string, familyName: string): Character {
  const rng = w.rng
  const id = `${w.domeId ?? ''}c${w.nextId++}`
  const traits = {
    trust: gauss(rng), generosity: gauss(rng), temper: gauss(rng),
    honesty: gauss(rng) * 0.8 + 0.15, sociability: gauss(rng), courage: gauss(rng),
  }
  if (role === 'child') { traits.sociability += 0.4; traits.temper += 0.2 }
  if (role === 'guard') { traits.courage += 0.4 }
  if (role === 'priest') { traits.honesty += 0.3; traits.generosity += 0.3 }
  if (role === 'merchant') { traits.honesty -= 0.2; traits.sociability += 0.3 }
  if (role === 'vagrant') { traits.honesty -= 0.4; traits.trust -= 0.3 }
  const clamp = (v: number) => Math.max(-1, Math.min(1, v))
  for (const k of Object.keys(traits) as (keyof typeof traits)[]) traits[k] = clamp(traits[k])
  const door = home ? home.door : { x: 24, y: 18 }
  const start = { x: door.x, y: door.y }
  const hueSeed = rng()
  return {
    id, name, age, role, home: home?.id ?? 'none', family, familyName,
    traits,
    mood: { joy: rng() * 0.4, anger: rng() * 0.2, fear: rng() * 0.1, shame: 0 },
    needs: { hunger: rng() * 0.5, sleep: rng() * 0.3, money: 0.5, safety: 0.2, social: rng() * 0.6, esteem: 0.4 },
    money: role === 'child' ? 0 : role === 'vagrant' ? 1 : 5 + Math.floor(rng() * 35),
    food: Math.floor(rng() * 4),
    pos: start, prev: { ...start }, path: [],
    activity: { kind: 'idle', label: 'looking around', until: 0, place: null },
    memory: [], longMemory: [], relations: {}, goals: [], beliefs: [], diary: [],
    alive: true, sick: false, drunk: 0,
    color: ROLES[role].color, seed: hueSeed, arrivedDay: 1, intent: null, left: false, starving: 0,
  }
}

export function generateCharacters(w: World) {
  const rng = w.rng
  const houses = w.buildings.filter(b => b.type === 'house')
  const males = shuffle(MALE, rng)
  const females = shuffle(FEMALE, rng)
  const families = shuffle(FAMILIES, rng)
  let mi = 0, fi = 0
  const nextM = () => males[mi++ % males.length]
  const nextF = () => females[fi++ % females.length]

  const maleRoles: RoleId[] = shuffle(['smith', 'merchant', 'guard', 'guard', 'priest', 'innkeeper', 'miller', 'elder', 'carpenter', 'hunter', 'farmer', 'farmer', 'farmer', 'farmer'], rng)
  const femaleRoles: RoleId[] = shuffle(['baker', 'teacher', 'healer', 'weaver', 'weaver', 'merchant', 'farmer', 'farmer', 'farmer', 'innkeeper', 'farmer', 'weaver', 'farmer', 'farmer'], rng)

  const chars: Character[] = []
  houses.forEach((house, i) => {
    const fam = families[i]
    house.family = fam.name
    house.name = `${fam.gen} Module`
    const single = i % 4 === 3 // every fourth house — a single adult
    const members: Character[] = []
    const father = makeChar(w, nextM(), 24 + Math.floor(rng() * 34), maleRoles[i % maleRoles.length], house, house.id, fam.name)
    members.push(father)
    if (!single) {
      const mother = makeChar(w, nextF(), 22 + Math.floor(rng() * 32), femaleRoles[i % femaleRoles.length], house, house.id, fam.name)
      members.push(mother)
      const nKids = rng() < 0.25 ? 0 : rng() < 0.6 ? 1 : 2
      for (let k = 0; k < nKids; k++) {
        const sexM = rng() < 0.5
        const nm = sexM ? nextM() : nextF()
        members.push(makeChar(w, nm, 6 + Math.floor(rng() * 9), 'child', house, house.id, fam.name))
      }
      if (rng() < 0.3) {
        const sexM = rng() < 0.5
        const nm = sexM ? nextM() : nextF()
        members.push(makeChar(w, nm, 60 + Math.floor(rng() * 18), 'old', house, house.id, fam.name))
      }
    } else if (i % 8 === 3) {
      // single with a kid — a widow(er)
      members.push(makeChar(w, nextF(), 7 + Math.floor(rng() * 7), 'child', house, house.id, fam.name))
    }
    for (const c of members) house.owners.push(c.id)
    chars.push(...members)
  })
  // vagrant
  chars.push(makeChar(w, nextM(), 30 + Math.floor(rng() * 20), 'vagrant', null, 'none', ''))

  // relations
  for (const a of chars) for (const b of chars) {
    if (a === b) continue
    const fam = a.family !== 'none' && a.family === b.family
    const r = newRelation(fam)
    if (!fam) {
      r.trust = 0.05 + gauss(rng) * 0.25
      r.liking = gauss(rng) * 0.3
      if (a.role === 'child' && b.role === 'child') r.liking += 0.2
    }
    a.relations[b.id] = r
  }

  const adults = chars.filter(c => c.role !== 'child')
  const pick = (pred: (c: Character) => boolean) => { const arr = shuffle(adults.filter(pred), rng); return arr[0] }

  // old grudges
  const grudges = [
    (a: Character, b: Character) => `last autumn ${a.name.nom} cheated ${b.name.acc} on the sale of a suit`,
    (a: Character, b: Character) => `${a.name.nom} mocked ${b.name.acc} at the festival in front of everyone`,
    (a: Character, b: Character) => `${a.name.nom} poached ${b.name.gen}'s customer; that winter ${b.name.nom} nearly went broke`,
    (a: Character, b: Character) => `${a.name.nom} reported ${b.name.acc} to the administrator over a missing oxygen tank`,
  ]
  for (let i = 0; i < 4; i++) {
    const a = pick(() => true)
    const b = pick(c => c.family !== a.family && c.id !== a.id)
    const text = grudges[i](a, b)
    b.relations[a.id].liking = -0.65; b.relations[a.id].trust = -0.5
    a.relations[b.id].liking = -0.3
    b.longMemory.push({ t: -1440 * 40, text, weight: 0.85, source: 'seen', about: [a.id, b.id], culprit: a.id })
    a.longMemory.push({ t: -1440 * 40, text, weight: 0.5, source: 'seen', about: [a.id, b.id], culprit: a.id })
    b.beliefs.push({ claim: `${a.name.nom} is a dishonest person`, confidence: 0.75, about: a.id })
  }
  // debts
  for (let i = 0; i < 3; i++) {
    const debtor = pick(c => c.money < 20)
    const creditor = pick(c => c.family !== debtor.family && c.money > 15)
    const n = 8 + Math.floor(rng() * 14)
    creditor.relations[debtor.id].debt = n
    debtor.relations[creditor.id].debt = -n
    creditor.relations[debtor.id].trust -= 0.2
    const text = `${debtor.name.nom} borrowed ${n} credits from ${creditor.name.nom} and still has not paid them back`
    creditor.longMemory.push({ t: -1440 * 9, text, weight: 0.6, source: 'seen', about: [debtor.id, creditor.id], culprit: debtor.id })
    debtor.longMemory.push({ t: -1440 * 9, text, weight: 0.4, source: 'seen', about: [debtor.id, creditor.id] })
    creditor.goals.push({ id: `debt-${debtor.id}`, text: `collect the debt from ${debtor.name.nom}`, priority: 0.6, source: 'self', target: debtor.id })
  }
  // sympathies among singles
  const singles = adults.filter(c => w.buildings.find(b => b.id === c.home)?.owners.filter(o => chars.find(x => x.id === o)!.role !== 'child').length === 1)
  const singleM = singles.filter(c => c.name.sex === 'm'), singleF = singles.filter(c => c.name.sex === 'f')
  for (let i = 0; i < Math.min(2, singleM.length, singleF.length); i++) {
    const a = singleM[i], b = singleF[i]
    a.relations[b.id].liking = 0.6; b.relations[a.id].liking = 0.35 + rng() * 0.4
    a.memory.push({ t: -60, text: `${b.name.nom} smiled at me by the fountain`, weight: 0.5, source: 'seen', about: [a.id, b.id] })
  }
  // beliefs about the world
  const guard = adults.find(c => c.role === 'guard')
  if (guard) for (const c of shuffle(adults, rng).slice(0, 5)) c.beliefs.push({ claim: `patrol officer ${guard.name.nom} takes bribes`, confidence: 0.5, about: guard.id })
  const merchant = adults.find(c => c.role === 'merchant')
  if (merchant) for (const c of shuffle(adults, rng).slice(0, 4)) c.beliefs.push({ claim: `${merchant.name.nom} shortchanges people at the depot`, confidence: 0.55, about: merchant.id })

  // goals
  for (const c of chars) {
    if (c.role === 'child') c.goals.push({ id: 'play', text: 'find someone to play with', priority: 0.5, source: 'self' })
    else if (c.money < 10) c.goals.push({ id: 'money', text: 'get hold of some credits', priority: 0.7, source: 'self' })
    else if (rng() < 0.3) c.goals.push({ id: 'respect', text: 'earn the colony\'s respect', priority: 0.4, source: 'self' })
  }
  w.chars = chars
}
