/**
 * A region: several domes on one planet, roads between them, people on the roads.
 * Each dome is a full World ticked by the same engine. Travellers carry their memory with them,
 * so rumours cross domes; traders visit neighbours for a day and come home.
 */
import type { World, Character } from './types'
import { createWorld, tick, runTimers, log, mulberry32 } from './engine'
import { g, dayOf, hourOf } from './text'
import { FAMILIES } from './names'

export interface DomeInfo { id: string; name: string; x: number; y: number; seed: number; /** planned by an expedition, world not built yet */ site?: boolean; origin?: string; founder?: string }
export const MAX_DOMES = 8
export interface Traveler {
  char: Character
  from: string
  to: string
  departT: number
  arriveT: number
  reason: 'leave' | 'trade' | 'return' | 'found'
  homeDome?: string
  homeBuilding?: string
  returnAt?: number
  /** what a trader carries: sold on arrival, bought goods come back home */
  cargo?: { food: number; parts: number }
}
export interface Region {
  domes: World[]
  info: DomeInfo[]
  links: { a: string; b: string; hours: number }[]
  travelers: Traveler[]
  t: number
  rng: () => number
  lastTrade: number
  /** things worth a toast, addressed to the watchers of one dome; drained by the host */
  news: { dome: string; text: string; icon: string }[]
}

export const DOME_NAMES = ['Aurora', 'Meridian', 'Cassiopeia', 'Helios', 'Triton', 'Vega', 'Arcadia', 'Polaris', 'Selene', 'Zircon', 'Orion', 'Lacerta']
/** Domes closer than this would touch; further than the max they would be out of sight from each other. */
const MIN_GAP = 88, MAX_GAP = 132
const DOME_R = 34

type P = { x: number; y: number }
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y)
/** Does segment ab cross segment cd (sharing an endpoint does not count)? */
function crosses(a: P, b: P, c: P, d: P) {
  if (a === c || a === d || b === c || b === d) return false
  const o = (p: P, q: P, r: P) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b)
}
/** Distance from point p to segment ab. */
function segDist(p: P, a: P, b: P) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/** Scatter domes on the plain: each new one settles near an existing one, never too close to any other. */
export function layoutDomes(rng: () => number, count: number): P[] {
  const pts: P[] = [{ x: 0, y: 0 }]
  let guard = 0
  while (pts.length < count && guard++ < 500) {
    const anchor = pts[Math.floor(rng() * pts.length)]
    const a = rng() * Math.PI * 2, d = MIN_GAP + rng() * (MAX_GAP - MIN_GAP)
    const p = { x: Math.round(anchor.x + Math.cos(a) * d), y: Math.round(anchor.y + Math.sin(a) * d) }
    if (pts.every(q => dist(p, q) >= MIN_GAP)) pts.push(p)
  }
  return pts
}

/** Roads: nearest neighbours first, no crossings, none passing through a third dome, always connected. */
export function layoutRoads(pts: P[]): { a: number; b: number }[] {
  const pairs: { a: number; b: number; d: number }[] = []
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) pairs.push({ a: i, b: j, d: dist(pts[i], pts[j]) })
  pairs.sort((x, y) => x.d - y.d)
  const parent = pts.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const roads: { a: number; b: number }[] = []
  const degree = pts.map(() => 0)
  for (const p of pairs) {
    const A = pts[p.a], B = pts[p.b]
    if (roads.some(r => crosses(A, B, pts[r.a], pts[r.b]))) continue
    if (pts.some((q, k) => k !== p.a && k !== p.b && segDist(q, A, B) < DOME_R + 10)) continue
    const joins = find(p.a) !== find(p.b)
    const wanted = (degree[p.a] < 2 || degree[p.b] < 2) && degree[p.a] < 3 && degree[p.b] < 3
    if (!joins && (!wanted || p.d > MAX_GAP * 1.2)) continue
    roads.push({ a: p.a, b: p.b }); degree[p.a]++; degree[p.b]++
    parent[find(p.a)] = find(p.b)
  }
  return roads
}

/** A region of `count` domes (3–5 by default, from the seed): names, places and roads are all procedural. */
export function createRegion(seed = 7, count?: number): Region {
  const rng = mulberry32(seed * 31 + 7)
  const n = count ?? 3 + Math.floor(rng() * 3)
  const names = DOME_NAMES.slice()
  for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [names[i], names[j]] = [names[j], names[i]] }
  const pts = layoutDomes(rng, n)
  const info: DomeInfo[] = []
  const domes: World[] = []
  for (let i = 0; i < pts.length; i++) {
    const id = String.fromCharCode(97 + i) // a, b, c …
    const name = names[i] ?? `Dome-${i + 1}`
    info.push({ id, name, x: pts[i].x, y: pts[i].y, seed: seed + i * 1013 })
    domes.push(createWorld(seed + i * 1013, id, name))
  }
  const links: Region['links'] = layoutRoads(pts).map(r => ({ a: info[r.a].id, b: info[r.b].id, hours: Math.max(3, Math.round(dist(pts[r.a], pts[r.b]) / 14)) }))
  return { domes, info, links, travelers: [], t: domes[0].t, rng, lastTrade: -9999, news: [] }
}

export const domeOf = (r: Region, id: string) => r.domes.find(w => w.domeId === id)!
const say = (r: Region, dome: string, text: string, icon = '◍') => r.news.push({ dome, text, icon })
export const domeName = (r: Region, id: string) => r.info.find(d => d.id === id)?.name ?? id
export const linkHours = (r: Region, a: string, b: string) => r.links.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a))?.hours ?? 6
export const neighbours = (r: Region, id: string) => r.links.filter(l => l.a === id || l.b === id).map(l => (l.a === id ? l.b : l.a))

function depart(r: Region, w: World, c: Character, to: string, reason: Traveler['reason'], extra: Partial<Traveler> = {}) {
  // a ghost stays behind so that rumours, relations and the chronicle can still name the person
  const ghost: Character = { ...c, left: true, ghost: true, memory: [], longMemory: [], goals: [], path: [], intent: null, beliefs: [], diary: [], lastDecision: undefined, visit: undefined }
  const i = w.chars.indexOf(c)
  if (i >= 0) w.chars[i] = ghost; else w.chars.push(ghost)
  c.left = false; c.path = []; c.intent = null
  r.travelers.push({ char: c, from: w.domeId, to, departT: r.t, arriveT: r.t + linkHours(r, w.domeId, to) * 60, reason, ...extra })
}

// ───────── new domes founded by settlers ─────────

/** Pick a spot for a new dome next to `origin`: far enough from everyone, reachable by a road that crosses nothing. */
function planSite(r: Region, origin: DomeInfo): { x: number; y: number; links: { a: string; b: string; hours: number }[] } | null {
  const pts = r.info.map(d => ({ x: d.x, y: d.y }))
  for (let i = 0; i < 60; i++) {
    const a = r.rng() * Math.PI * 2, d = MIN_GAP + r.rng() * (MAX_GAP - MIN_GAP)
    const p = { x: Math.round(origin.x + Math.cos(a) * d), y: Math.round(origin.y + Math.sin(a) * d) }
    if (!pts.every(q => dist(p, q) >= MIN_GAP)) continue
    const ok = (from: DomeInfo) => {
      const A = { x: from.x, y: from.y }
      if (r.links.some(l => { if (l.a === from.id || l.b === from.id) return false; const la = r.info.find(x => x.id === l.a)!, lb = r.info.find(x => x.id === l.b)!; return crosses(A, p, la, lb) })) return false
      return !r.info.some(q => q !== from && segDist(q, A, p) < DOME_R + 10)
    }
    if (!ok(origin)) continue
    const links = [{ a: origin.id, b: '', hours: Math.max(3, Math.round(d / 14)) }]
    // one more road to the nearest other dome, if it fits
    const others = r.info.filter(q => q !== origin && !q.site && dist(q, p) <= MAX_GAP * 1.2 && ok(q)).sort((x, y) => dist(x, p) - dist(y, p))
    if (others[0]) links.push({ a: others[0].id, b: '', hours: Math.max(3, Math.round(dist(others[0], p) / 14)) })
    return { x: p.x, y: p.y, links }
  }
  return null
}

/** Who would follow the founder: unhappy or homeless adults who like them, plus family. */
function followers(w: World, founder: Character): Character[] {
  const liking = (c: Character) => c.relations[founder.id]?.liking ?? 0
  const family = (c: Character) => c.relations[founder.id]?.family ?? false
  return w.chars
    .filter(c => c !== founder && c.alive && !c.left && c.role !== 'child' && !c.visit)
    .filter(c => family(c) || (liking(c) >= 0 && (c.mood.joy < 0.45 || c.mood.anger > 0.3 || c.home === 'none' || c.goals.some(gl => gl.id === 'leave'))) || liking(c) > 0.35)
    .sort((a, b) => (family(b) ? 1 : 0) - (family(a) ? 1 : 0) || liking(b) - liking(a))
    .slice(0, 7)
}

/** The founder gathers a party and they set out for a site nobody has settled yet. Returns false if it fell through. */
export function formExpedition(r: Region, w: World, founder: Character, source: 'self' | 'player'): boolean {
  founder.goals = founder.goals.filter(gl => gl.id !== 'found')
  if (r.info.length >= MAX_DOMES) { log(w, `${founder.name.nom} dreamed of a dome of ${g(founder, 'his', 'her')} own, but the administration issues no more building permits`, 'life', 0.45, [founder.id]); return false }
  const party = followers(w, founder)
  if (party.length < 4) { log(w, `${founder.name.nom} called on people to found a new dome, but nobody went with ${g(founder, 'him', 'her')}`, source === 'player' ? 'player' : 'life', 0.5, [founder.id]); return false }
  const origin = r.info.find(d => d.id === w.domeId)!
  const site = planSite(r, origin)
  if (!site) { log(w, `${founder.name.nom} looked for a site for a new dome, but the scouts found no level ground`, 'life', 0.45, [founder.id]); return false }
  const id = String.fromCharCode(97 + r.info.length)
  const name = DOME_NAMES.find(n => !r.info.some(d => d.name === n)) ?? `Dome-${r.info.length + 1}`
  const info: DomeInfo = { id, name, x: site.x, y: site.y, seed: (w.seed * 7 + r.info.length * 1013) % 1000003, site: true, origin: origin.id, founder: founder.id }
  r.info.push(info)
  for (const l of site.links) r.links.push({ a: l.a, b: id, hours: l.hours })
  const hours = r.links.find(l => l.a === origin.id && l.b === id)!.hours
  const all = [founder, ...party]
  log(w, `${founder.name.nom} gathered ${party.length} people — ${party.map(c => c.name.acc).join(', ')} — and they set out through the airlock to found a new dome. They named the site «${name}», ${hours} hours away`, source === 'player' ? 'player' : 'world', 1, all.map(c => c.id))
  w.chronicle.push({ day: dayOf(w.t), title: `Exodus: ${name}`, text: `${founder.name.nom} led ${party.length} people away to found the ${name} dome.` })
  for (const o of w.chars) if (!all.includes(o) && o.alive && !o.left) { const gone = all.filter(c => (o.relations[c.id]?.liking ?? 0) > 0.4 || o.relations[c.id]?.family); if (gone.length) { o.memory.push({ t: w.t, text: `${gone.map(c => c.name.nom).join(' and ')} left with the expedition to found the ${name} dome`, weight: 0.7, source: 'seen', about: gone.map(c => c.id) }); o.mood.joy = Math.max(0, o.mood.joy - 0.2) } }
  for (const c of all) {
    c.memory.push({ t: w.t, text: c === founder ? `I led people out of the ${w.domeName} dome to found ${name}` : `followed ${founder.name.ins} out of the ${w.domeName} dome to found ${name}`, weight: 0.9, source: 'seen', about: [founder.id] })
    depart(r, w, c, id, 'found', { homeDome: w.domeId })
  }
  say(r, w.domeId, `${founder.name.nom} and ${party.length} others left to found the ${name} dome`, '◍')
  return true
}

/** Build the world for a planned site the moment the first settler arrives: a bare outpost, most modules yet unbuilt. */
function foundDome(r: Region, info: DomeInfo): World {
  const w = createWorld(info.seed, info.id, info.name)
  w.t = r.domes[0].t
  w.chars = []
  w.log = []; w.logSeq = 0
  const keepTypes = new Set(['market', 'bakery', 'forge', 'mill'])
  let houses = 0
  for (const b of w.buildings.slice()) {
    const keep = keepTypes.has(b.type) || (b.type === 'house' && houses++ < 3)
    if (keep) { b.owners = []; b.family = undefined; continue }
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) w.tiles[y * w.w + x] = 0
    w.buildings = w.buildings.filter(x => x !== b)
    delete w.places[b.id]
  }
  w.stock = { food: 24, parts: 10 }
  w.mapVersion++
  w.dirty = [0]
  info.site = false
  r.domes.push(w)
  log(w, `The ${info.name} dome was founded by settlers from the ${domeName(r, info.origin ?? '')} dome. For now there is a depot, a canteen, a workshop, a reactor and three living modules`, 'world', 1, [])
  w.chronicle.push({ day: dayOf(w.t), title: `Founding`, text: `Settlers from the ${domeName(r, info.origin ?? '')} dome raised the ${info.name} dome.` })
  return w
}

function settle(w: World, c: Character, founder: boolean) {
  // families share a module; whoever comes later takes the emptiest one, or none if all full
  const houses = w.buildings.filter(b => b.type === 'house' && !b.burned)
  let home = houses.find(b => b.owners.some(id => c.relations[id]?.family))
  if (!home) home = houses.filter(b => b.owners.length < 2).sort((a, b) => a.owners.length - b.owners.length)[0]
  if (home) {
    home.owners.push(c.id); c.home = home.id
    if (!home.family) { home.family = c.family !== 'none' ? c.familyName : c.name.nom; home.name = `${c.family !== 'none' ? (FAMILIES.find(f => f.name === c.familyName)?.gen ?? c.familyName) : c.name.gen} Module` }
  } else c.home = 'none'
  c.goals = [{ id: 'build', text: 'settle in the new dome', priority: 0.5, source: 'self' }]
  if (c.home === 'none') c.goals.push({ id: 'savehouse', text: 'build your own module', priority: 0.7, source: 'self' })
  if (founder && !w.chars.some(o => o.role === 'elder')) c.role = 'elder'
  c.money += 10
  c.food = Math.max(c.food, 4)
}

function arrive(r: Region, tr: Traveler) {
  const w = domeOf(r, tr.to) ?? (() => { const info = r.info.find(d => d.id === tr.to)!; return foundDome(r, info) })()
  const c = tr.char
  const exit = w.places.exit[0]
  c.pos = { x: exit.x, y: exit.y }; c.prev = { ...c.pos }; c.path = []; c.intent = null
  c.left = false; c.alive = true; delete c.ghost
  c.activity = { kind: 'idle', label: 'looking around at the airlock', until: w.t, place: null }
  c.goals = c.goals.filter(gl => gl.id !== 'leave')
  const fromName = domeName(r, tr.from)
  if (tr.reason === 'found') {
    const info = r.info.find(d => d.id === tr.to)!
    settle(w, c, info.founder === c.id)
    c.arrivedDay = dayOf(w.t)
    log(w, `${c.name.nom} entered the new dome${c.home !== 'none' ? ` and moved into the ${(w.buildings.find(b => b.id === c.home)?.name ?? 'Module').replace(/Module$/, 'module')}` : ''}`, 'life', 0.6, [c.id])
    if (info.founder === c.id) say(r, tr.from, `${c.name.gen}'s expedition made it: the ${w.domeName} dome is founded`, '◍')
  } else if (tr.reason === 'return' && tr.homeBuilding) {
    c.home = tr.homeBuilding
    c.goals = c.goals.filter(gl => gl.id !== 'trade')
    const cargo = tr.cargo ?? { food: 0, parts: 0 }
    w.stock.food += cargo.food; w.stock.parts += cargo.parts
    c.money += Math.round((cargo.food * w.foodPrice + cargo.parts * w.partsPrice) * 0.3)
    repriceFood(w)
    const brought = goods(cargo)
    log(w, `${c.name.nom} came back from the ${fromName} dome ${brought ? `with cargo: ${brought} for the depot` : 'with an empty rover'} and fresh rumors`, 'trade', 0.5, [c.id])
    for (const o of w.chars) if (o !== c && (o.relations[c.id]?.liking ?? 0) > 0.3) o.memory.push({ t: w.t, text: `${c.name.nom} came back from the ${fromName} dome`, weight: 0.35, source: 'seen', about: [c.id] })
  } else if (tr.reason === 'trade') {
    c.home = 'none'
    c.goals.push({ id: 'trade', text: `trade in the ${w.domeName} dome and come home`, priority: 0.7, source: 'self' })
    const cargo = tr.cargo ?? { food: 0, parts: 0 }
    const foodBefore = w.foodPrice
    c.money += Math.round((cargo.food * w.foodPrice + cargo.parts * w.partsPrice) * 0.4)
    w.stock.food += cargo.food; w.stock.parts += cargo.parts
    repriceFood(w)
    const sold = goods(cargo)
    log(w, `${c.name.nom} arrived from the ${fromName} dome and unloaded ${sold || 'an empty rover'} at the depot${w.foodPrice < foodBefore ? `. Rations are down to ${w.foodPrice}` : ''}. Staying for a day`, 'trade', sold ? 0.6 : 0.4, [c.id])
    if (sold) say(r, w.domeId, `${c.name.nom} from the ${fromName} dome brought ${sold}`, '📦')
    // buys what this dome can spare, to sell back home
    const back = surplus(w)
    w.stock.food -= back.food; w.stock.parts -= back.parts
    if (c.visit) c.visit.cargo = back
  } else {
    c.home = 'none'
    c.family = 'none'
    c.arrivedDay = dayOf(w.t)
    c.goals.push({ id: 'settle', text: `settle down in the ${w.domeName} dome`, priority: 0.8, source: 'self' })
    c.memory.push({ t: w.t, text: `left the ${fromName} dome and made it here by the road`, weight: 0.8, source: 'seen', about: [c.id] })
    log(w, `${c.name.nom} came in through the airlock from the ${fromName} dome. Says there was no living there for ${g(c, 'him', 'her')}`, 'world', 0.75, [c.id])
  }
  for (const o of w.chars) if (o !== c && !o.relations[c.id]) o.relations[c.id] = { trust: -0.1 + o.traits.trust * 0.2, liking: 0, fear: 0, debt: 0, lastContact: -9999, family: false }
  w.chars = w.chars.filter(x => x.id !== c.id) // drop the ghost if this is a homecoming
  w.chars.push(c)
  c.seed = c.seed || w.rng()
}

/** One region tick: every dome ticks, people on the roads move, traders set out and come home. */
export function tickRegion(r: Region) {
  r.t++
  for (const w of r.domes) {
    tick(w)
    runTimers(w)
    // anyone who walked out through the airlock is now on the road to a neighbour
    for (const c of w.chars.slice()) {
      if (!c.left || c.ghost || !c.alive) continue
      const ns = neighbours(r, w.domeId)
      if (!ns.length) continue
      const to = ns[Math.floor(r.rng() * ns.length)]
      depart(r, w, c, to, 'leave')
    }
    // traders: every other day at 08:00 one merchant per dome goes to sell in a neighbouring dome
    if (w.t % 1440 === 8 * 60 && dayOf(w.t) % 2 === 0) {
      const trader = w.chars.find(c => c.alive && !c.left && c.role === 'merchant' && c.home !== 'none' && !c.goals.some(gl => gl.id === 'trade'))
      const ns = neighbours(r, w.domeId).filter(id => domeOf(r, id))
      if (trader && ns.length && r.rng() < 0.85) {
        // the neighbour where the price gap is widest, in either direction
        const to = ns.map(id => ({ id, gain: tradeGain(w, domeOf(r, id)) })).sort((a, b) => b.gain - a.gain)[0]
        if (to.gain > 0 || r.rng() < 0.5) sendTrader(r, w, trader, to.id, 'self')
      }
    }
    // expeditions: a whispered founder sets out by day; a crowded dome breeds one on its own now and then
    const hour = hourOf(w.t)
    if (w.t % 60 === 0 && hour >= 8 && hour < 18) {
      const whispered = w.chars.find(c => c.alive && !c.left && !c.ghost && c.goals.some(gl => gl.id === 'found'))
      if (whispered) formExpedition(r, w, whispered, whispered.goals.find(gl => gl.id === 'found')?.source === 'player' ? 'player' : 'self')
      else if (hour === 9 && r.info.length < MAX_DOMES) {
        const people = w.chars.filter(c => c.alive && !c.left && !c.ghost)
        const restless = people.filter(c => c.role !== 'child' && (c.mood.joy < 0.45 || c.mood.anger > 0.3 || c.home === 'none'))
        if (people.length >= 44 && restless.length >= 6 && r.rng() < 0.12) {
          const founder = restless.filter(c => c.role !== 'old').sort((a, b) => (b.traits.sociability + b.traits.courage) - (a.traits.sociability + a.traits.courage))[0]
          if (founder) { log(w, `The dome is crowded and cheerless. ${founder.name.nom} started talking about leaving to raise a dome of ${g(founder, 'his', 'her')} own`, 'life', 0.6, [founder.id]); formExpedition(r, w, founder, 'self') }
        }
      }
    }
    // visiting traders go home after a day
    for (const c of w.chars.slice()) {
      const tg = c.goals.find(gl => gl.id === 'trade')
      if (!tg || !c.alive) continue
      const tr = r.travelers.find(x => x.char === c)
      if (tr) continue
      const v = c.visit
      if (v && r.t >= v.returnAt && hourOf(w.t) >= 7 && hourOf(w.t) < 20) {
        log(w, `${c.name.nom} sold out and drove home to the ${domeName(r, v.home)} dome`, 'trade', 0.45, [c.id])
        c.money += 8
        delete c.visit
        depart(r, w, c, v.home, 'return', { homeBuilding: v.building, cargo: v.cargo })
      }
    }
  }
  for (let i = r.travelers.length - 1; i >= 0; i--) {
    const tr = r.travelers[i]
    if (r.t < tr.arriveT) continue
    r.travelers.splice(i, 1)
    if (tr.reason === 'trade') tr.char.visit = { home: tr.homeDome!, building: tr.homeBuilding!, returnAt: tr.returnAt! }
    arrive(r, tr)
  }
}

// ───────── trade in goods ─────────

/** Surplus a dome can spare: rations above a two-day reserve, parts above a small stock. */
const surplus = (w: World) => ({ food: Math.max(0, Math.min(18, w.stock.food - 30)), parts: Math.max(0, Math.min(10, w.stock.parts - 20)) })
/** How much a trip from `home` to `there` is worth: price gaps on what each side can spare. */
function tradeGain(home: World, there: World) {
  const sh = surplus(home), st = surplus(there)
  return sh.food * (there.foodPrice - home.foodPrice) + sh.parts * (there.partsPrice - home.partsPrice) + st.food * (home.foodPrice - there.foodPrice) + st.parts * (home.partsPrice - there.partsPrice)
}
const repriceFood = (w: World) => { if (!w.timers.some(tm => tm.action === 'foodPrice')) w.foodPrice = w.stock.food >= 60 ? 1 : w.stock.food >= 25 ? 2 : w.stock.food >= 10 ? 3 : 4; w.partsPrice = w.stock.parts >= 40 ? 2 : w.stock.parts >= 15 ? 3 : 5 }
const goods = (c: { food: number; parts: number }) => [c.food ? `${c.food} rations` : '', c.parts ? `${c.parts} parts` : ''].filter(Boolean).join(' and ')

function sendTrader(r: Region, w: World, trader: Character, to: string, source: 'self' | 'player') {
  const cargo = surplus(w)
  w.stock.food -= cargo.food; w.stock.parts -= cargo.parts
  trader.money += 4
  log(w, `${trader.name.nom} loaded the rover with ${goods(cargo) || 'whatever was at hand'} and set off to trade in the ${domeName(r, to)} dome${source === 'player' ? ' on an order from orbit' : ''}`, source === 'player' ? 'player' : 'trade', 0.5, [trader.id])
  depart(r, w, trader, to, 'trade', { homeDome: w.domeId, homeBuilding: trader.home, returnAt: r.t + linkHours(r, w.domeId, to) * 60 + 1440, cargo })
}

/** A caravan the player asks for: `from` sends its merchant with surplus to `to`. Returns an error text or ''. */
export function sendCaravan(r: Region, from: string, to: string): string {
  const w = domeOf(r, from) as World | undefined, dest = domeOf(r, to) as World | undefined
  if (!w || !dest) return 'that dome does not exist yet'
  if (!r.links.some(l => (l.a === from && l.b === to) || (l.a === to && l.b === from))) return `there is no road between ${w.domeName} and ${dest.domeName}`
  const hour = hourOf(w.t)
  if (hour < 6 || hour >= 19) return 'rovers do not go out at night: wait for morning'
  const trader = w.chars.find(c => c.alive && !c.left && !c.ghost && c.role === 'merchant' && c.home !== 'none' && !c.visit)
  if (!trader) return `the ${w.domeName} dome has no quartermaster available right now`
  const s = surplus(w)
  if (!s.food && !s.parts) return `the ${w.domeName} depot has nothing to spare`
  sendTrader(r, w, trader, to, 'player')
  say(r, to, `${trader.name.nom} is bringing ${goods(s)} from the ${w.domeName} dome`, '📦')
  return ''
}

/** Find a character anywhere in the region: in a dome or on the road. */
export function findChar(r: Region, id: string): { char: Character; dome: string | null } | null {
  for (const w of r.domes) { const c = w.chars.find(x => x.id === id && !x.left); if (c) return { char: c, dome: w.domeId } }
  const tr = r.travelers.find(t => t.char.id === id)
  return tr ? { char: tr.char, dome: null } : null
}

/** Plain-data form for saving and loading (functions stripped, rngs rebuilt). */
export interface RegionSave { info: DomeInfo[]; links: Region['links']; travelers: Traveler[]; t: number; lastTrade: number; domes: Omit<World, 'rng' | 'brainQueue'>[] }
export function serializeRegion(r: Region): RegionSave {
  return { info: r.info, links: r.links, travelers: r.travelers, t: r.t, lastTrade: r.lastTrade, domes: r.domes.map(w => { const { rng: _r, brainQueue: _q, ...rest } = w; return rest }) }
}
export function deserializeRegion(s: RegionSave): Region {
  const domes = s.domes.map(d => ({ ...d, stock: d.stock ?? { food: 40, parts: 20 }, partsPrice: d.partsPrice ?? 3, rng: mulberry32(Math.floor(Math.random() * 1e9)), brainQueue: [], dirty: [] }) as World)
  return { domes, info: s.info, links: s.links, travelers: s.travelers ?? [], t: s.t ?? domes[0].t, rng: mulberry32(Math.floor(Math.random() * 1e9)), lastTrade: s.lastTrade ?? -9999, news: [] }
}

/** Compact overview for the UI and the renderer. */
export interface RegionView {
  active: string
  domes: { id: string; name: string; x: number; y: number; population: number; conflicts: number; site?: boolean; founder?: string; stock?: { food: number; parts: number }; prices?: { food: number; parts: number }; surplus?: { food: number; parts: number } }[]
  travelers: { name: string; from: string; to: string; progress: number; reason: Traveler['reason'] }[]
  links: { a: string; b: string; hours: number }[]
}
export function regionView(r: Region, active: string): RegionView {
  return {
    active,
    domes: r.info.map(d => { const w = domeOf(r, d.id) as World | undefined; return w ? { id: d.id, name: d.name, x: d.x, y: d.y, population: w.chars.filter(c => c.alive && !c.left).length, conflicts: w.stats.conflicts, stock: { ...w.stock }, prices: { food: w.foodPrice, parts: w.partsPrice }, surplus: surplus(w) } : { id: d.id, name: d.name, x: d.x, y: d.y, population: 0, conflicts: 0, site: true, founder: r.travelers.find(t => t.char.id === d.founder)?.char.name.nom } }),
    travelers: r.travelers.map(t => ({ name: t.char.name.nom, from: t.from, to: t.to, progress: Math.max(0, Math.min(1, (r.t - t.departT) / Math.max(1, t.arriveT - t.departT))), reason: t.reason })),
    links: r.links,
  }
}
