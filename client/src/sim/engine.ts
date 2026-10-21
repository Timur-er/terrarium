import type { World, Character, Vec, LogKind, Building, ActivityKind, Memory } from './types'
import { buildMap, MAP_W, MAP_H, findPlot, placeBuilding } from './map'
import { generateCharacters, newRelation } from './gen'
import { findPath, walkable } from './path'
import { g, dayOf, hourOf, diaryFor, cap } from './text'
import { DECK, WHISPERS, RUMOR_TEMPLATES } from './cards'
import { MALE, FEMALE, FAMILIES } from './names'
import { getBrain, buildQuestions, resolveDecision, HeuristicBrain, type MenuOption, type Answer } from './brain'
import { buildState } from './state'

export function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v))
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y)

export function createWorld(seed = 7, domeId = '', domeName = 'Dome'): World {
  const rng = mulberry32(seed)
  const { tiles, buildings, places } = buildMap(rng)
  const w: World = {
    seed, w: MAP_W, h: MAP_H, tiles, buildings, places, chars: [],
    t: 7 * 60 + 30, log: [], logSeq: 0, events: [], cooldowns: {}, foodPrice: 2, stock: { food: 40 + Math.floor(rng() * 20), parts: 20 + Math.floor(rng() * 10) }, partsPrice: 3,
    stats: { conflicts: 0, kindness: 0, rumors: 0, thefts: 0, built: 0, weddings: 0 }, chronicle: [], rng, nextId: 1, mapVersion: 0, dirty: [], domeId, domeName, brainQueue: [], timers: [], decisions: [],
  }
  generateCharacters(w)
  log(w, 'Early morning. The dome brightens, the colony wakes up.', 'world', 0.3, [])
  return w
}

// ───────────────────────── helpers ─────────────────────────

export function log(w: World, text: string, kind: LogKind, weight: number, actors: string[], place?: string) {
  w.log.push({ id: w.logSeq++, t: w.t, text: cap(text), weight, actors, kind, place })
  if (w.log.length > 800) w.log.splice(0, 200)
}

function remember(c: Character, w: World, text: string, weight: number, about: string[], culprit?: string, source: Memory['source'] = 'seen', hops = 0) {
  const m: Memory = { t: w.t, text, weight, source, about, culprit, hops }
  c.memory.push(m)
  if (c.memory.length > 30) c.memory.shift()
  if (weight >= 0.7) { c.longMemory.push(m); if (c.longMemory.length > 15) c.longMemory.sort((a, b) => b.weight - a.weight).pop() }
}

function rel(a: Character, b: Character) {
  return (a.relations[b.id] ??= newRelation(a.family !== 'none' && a.family === b.family))
}
function adjust(a: Character, b: Character, d: { liking?: number; trust?: number; fear?: number }) {
  const r = rel(a, b)
  if (d.liking) r.liking = clamp(r.liking + d.liking)
  if (d.trust) r.trust = clamp(r.trust + d.trust)
  if (d.fear) r.fear = clamp(r.fear + d.fear, 0, 1)
}
function mood(c: Character, d: Partial<Character['mood']>) {
  for (const k of Object.keys(d) as (keyof Character['mood'])[]) c.mood[k] = clamp(c.mood[k] + (d[k] ?? 0), 0, 1)
}

const alive = (w: World) => w.chars.filter(c => c.alive && !c.left)
const awake = (c: Character) => c.activity.kind !== 'sleep' && c.activity.kind !== 'sick'

function witnesses(w: World, pos: Vec, radius: number, exclude: string[]) {
  return alive(w).filter(c => !exclude.includes(c.id) && awake(c) && dist(c.pos, pos) <= radius)
}

function building(w: World, id: string) { return w.buildings.find(b => b.id === id) }
function home(w: World, c: Character): Building | undefined { return building(w, c.home) }

const PLACE_PHRASE: Record<string, string> = {
  market: 'at the depot', bakery: 'at the canteen', forge: 'at the workshop', church: 'at the chapel', tavern: 'in the bar',
  guard: 'at the security post', school: 'at the school', mill: 'at the reactor',
}
export function wherePhrase(w: World, pos: Vec): string {
  if (pos.x >= 21 && pos.x <= 27 && pos.y >= 13 && pos.y <= 19) return dist(pos, { x: 24, y: 16 }) < 2 ? 'at the fountain' : 'on the plaza'
  let best: Building | undefined, bd = 99
  for (const b of w.buildings) { const d = dist(pos, b.door); if (d < bd) { bd = d; best = b } }
  if (best && bd <= 2.5) {
    if (best.type === 'house') return `at the ${best.name.replace(/Module$/, 'module')}`
    return PLACE_PHRASE[best.id]
  }
  if (pos.x >= 42) return 'by the canal'
  const k = w.tiles[Math.round(pos.y) * w.w + Math.round(pos.x)]
  if (k === 4) return 'at the hydroponics'
  if (k === 3 || k === 0) return 'at the dome edge'
  return 'on the road'
}

function randomOf<T>(w: World, arr: T[]): T { return arr[Math.floor(w.rng() * arr.length)] }

function goTo(w: World, c: Character, target: Vec, kind: ActivityKind, label: string, duration: number, place: string | null, withId?: string) {
  const path = findPath(w, c.pos, target)
  c.intent = { kind, label, duration, place, with: withId }
  if (path.length === 0) { arrive(w, c); return }
  c.path = path
  c.activity = { kind: 'walk', label: `walking ${place ? PLACE_TO[place] ?? 'on an errand' : 'on an errand'}`, until: w.t + 999, place }
}
const PLACE_TO: Record<string, string> = {
  home: 'home', market: 'to the depot', bakery: 'to the canteen', forge: 'to the workshop', church: 'to the chapel', tavern: 'to the bar',
  guard: 'to the security post', school: 'to the school', mill: 'to the reactor', square: 'to the plaza', fields: 'to the hydroponics', forest: 'to the grove',
  exit: 'to the airlock', target: 'to find someone',
}

function arrive(w: World, c: Character) {
  const i = c.intent
  c.intent = null
  if (!i) { c.activity = { kind: 'idle', label: 'standing', until: w.t + 5, place: null }; return }
  c.activity = { kind: i.kind, label: i.label, until: w.t + i.duration, place: i.place, with: i.with }
  onArrive(w, c)
}

function sampleWeighted<T extends { weight: number }>(w: World, opts: T[], temperature = 1): T | null {
  const valid = opts.filter(o => o.weight > 0)
  if (!valid.length) return null
  const ws = valid.map(o => Math.pow(o.weight, 1 / temperature))
  let r = w.rng() * ws.reduce((a, b) => a + b, 0)
  for (let i = 0; i < valid.length; i++) { r -= ws[i]; if (r <= 0) return valid[i] }
  return valid[valid.length - 1]
}

const spot = (w: World, placeId: string): Vec => {
  const list = w.places[placeId]
  if (!list || !list.length) return { x: 24, y: 18 }
  for (let i = 0; i < 6; i++) { const p = randomOf(w, list); if (walkable(w, p.x, p.y)) return p }
  return list[0]
}
const homeSpot = (w: World, c: Character): Vec => home(w, c)?.door ?? spot(w, 'tavern')

// ───────────────────────── construction ─────────────────────────

const adultsIn = (w: World, homeId: string) => alive(w).filter(c => c.home === homeId && c.role !== 'child')

export function startConstruction(w: World, owners: Character[], reason: NonNullable<Building['reason']>, near: Vec): Building | null {
  let b: Building | undefined
  if (reason === 'rebuild') {
    b = home(w, owners[0])
    if (!b) return null
    b.site = true; b.progress = 0.2; b.builders = []; b.reason = reason
    w.mapVersion++
  } else {
    const plot = findPlot(w, near, w.rng)
    if (!plot) return null
    const famName = owners.find(o => o.familyName)?.familyName ?? ''
    const famGen = FAMILIES.find(f => f.name === famName)?.gen
    const name = famGen ? `${famGen} Module` : `${owners[0].name.nom} Module`
    b = { id: `${w.domeId ?? ''}b${w.nextId++}`, type: 'house', name, x: plot.x, y: plot.y, w: plot.w, h: plot.h, door: plot.door, owners: owners.map(o => o.id), family: famName || owners[0].name.nom, site: true, progress: 0, builders: [], reason }
    placeBuilding(w, b)
    let left = reason === 'settle' ? 12 : 20
    for (const o of owners) { const pay = Math.min(o.money, left); o.money -= pay; left -= pay }
  }
  for (const o of owners) {
    o.goals = o.goals.filter(gl => gl.id !== 'build' && gl.id !== 'savehouse' && gl.id !== 'settle')
    o.goals.push({ id: 'build', text: reason === 'rebuild' ? 'rebuild the module' : 'build my own module', priority: 0.9, source: reason === 'whisper' ? 'player' : 'self', target: b.id })
  }
  return b
}

function buildStep(w: World, c: Character, bid: string) {
  const b = w.buildings.find(x => x.id === bid)
  if (!b || !b.site) return
  const owner = b.owners.includes(c.id)
  let inc = c.role === 'carpenter' ? 0.12 : owner ? 0.09 : 0.06
  if (w.stock.parts > 0) w.stock.parts--
  else { inc *= 0.3; if (!w.cooldowns.noparts) { w.cooldowns.noparts = w.t + 1440; log(w, `No parts left at the depot: work on the ${b.name} crawls along, they build with whatever is at hand`, 'trade', 0.55, [c.id]) } }
  b.progress = Math.min(1, (b.progress ?? 0) + inc)
  b.builders ??= []
  const owners = b.owners.map(id => w.chars.find(x => x.id === id)!).filter(Boolean)
  if (!owner && !b.builders.includes(c.id)) {
    b.builders.push(c.id)
    const o = owners[0]
    if (o) {
      log(w, `${c.name.nom} came to help ${o.name.nom} ${b.reason === 'rebuild' ? 'rebuild the module' : 'build the module'}`, 'kindness', 0.45, [c.id, ...owners.map(x => x.id)])
      for (const ow of owners) { adjust(ow, c, { liking: 0.2, trust: 0.15 }); remember(ow, w, `${c.name.nom} helped us build the module`, 0.7, [c.id, ow.id]) }
      w.stats.kindness++
    }
  }
  mood(c, { joy: 0.04 }); c.needs.sleep = clamp(c.needs.sleep + 0.05, 0, 1)
  w.mapVersion++
  if (b.progress >= 1) finishConstruction(w, b)
}

function finishConstruction(w: World, b: Building) {
  b.site = false; b.progress = undefined; b.burned = false
  const owners = b.owners.map(id => w.chars.find(x => x.id === id)!).filter(Boolean)
  const helpers = (b.builders ?? []).map(id => w.chars.find(x => x.id === id)!).filter(Boolean)
  for (const o of owners) {
    o.home = b.id
    o.goals = o.goals.filter(gl => gl.id !== 'build')
    mood(o, { joy: 0.45, fear: -0.2 })
    remember(o, w, b.reason === 'rebuild' ? 'the module is rebuilt' : 'we have our own module now', 0.9, owners.map(x => x.id))
  }
  if (b.reason !== 'rebuild') {
    for (const o of owners) { o.family = b.id; o.familyName = b.family ?? o.familyName }
    for (const other of w.buildings) if (other !== b) other.owners = other.owners.filter(id => !b.owners.includes(id))
  }
  const names = owners.map(o => o.name.nom).join(' and ')
  const helpText = helpers.length ? `Helped by ${helpers.map(h => h.name.nom).join(', ')}.` : 'They managed on their own.'
  log(w, b.reason === 'rebuild' ? `${b.name} is rebuilt. ${helpText}` : `${names}: the module is finished. Housewarming, tables for the whole sector. ${helpText}`, 'world', 0.9, owners.map(o => o.id))
  for (const c of alive(w)) if (!owners.includes(c) && dist(c.pos, b.door) <= 14) { remember(c, w, `housewarming at ${owners.map(o => o.name.nom).join(' and ')}'s`, 0.4, owners.map(o => o.id)); mood(c, { joy: 0.05 }) }
  w.stats.built++
  w.mapVersion++
}

function moveIn(w: World, mover: Character, host: Character) {
  const from = home(w, mover)
  const to = home(w, host)
  if (!to) return
  if (from) from.owners = from.owners.filter(id => id !== mover.id)
  to.owners.push(mover.id)
  mover.home = to.id; mover.family = host.family; mover.familyName = host.familyName
  log(w, `${mover.name.nom} moved into ${host.name.nom}'s module`, 'life', 0.5, [mover.id, host.id])
}

function holdWedding(w: World, a: Character, b: Character) {
  w.stats.weddings++
  log(w, `${a.name.nom} and ${b.name.nom} got married. The whole colony celebrated till morning`, 'love', 1, [a.id, b.id])
  for (const c of alive(w)) {
    mood(c, { joy: 0.2 })
    remember(c, w, `the wedding of ${a.name.nom} and ${b.name.nom}`, c === a || c === b ? 1 : 0.5, [a.id, b.id])
    if (c !== a && c !== b && c.role !== 'child') c.drunk = clamp(c.drunk + 0.2, 0, 1)
  }
  const husband = a.name.sex === 'm' ? a : b, wife = husband === a ? b : a
  const hAlone = husband.home !== 'none' && adultsIn(w, husband.home).length <= 1
  const wAlone = wife.home !== 'none' && adultsIn(w, wife.home).length <= 1
  if (hAlone) moveIn(w, wife, husband)
  else if (wAlone) moveIn(w, husband, wife)
  else if (a.money + b.money >= 20) {
    const site = startConstruction(w, [husband, wife], 'wedding', home(w, husband)?.door ?? home(w, wife)?.door ?? { x: 24, y: 18 })
    if (site) log(w, `${husband.name.nom} bought a plot for a module from the administrator. The newlyweds will build`, 'life', 0.55, [husband.id, wife.id])
    else log(w, `${husband.name.nom} looked for a plot for a module, but there is no free space under the dome. For now they live with relatives`, 'life', 0.5, [husband.id, wife.id])
  } else {
    for (const c of [husband, wife]) c.goals.push({ id: 'savehouse', text: 'save up for my own module', priority: 0.7, source: 'self', target: c === husband ? wife.id : husband.id })
    log(w, `The newlyweds have no module of their own — no credits for a frame. They will save up`, 'life', 0.45, [husband.id, wife.id])
  }
}

// ───────────────────────── decisions ─────────────────────────

interface Option { weight: number; run: () => void; name: string; label?: string }

/** Menu metadata: strategy group and a human label for each option the engine can build. */
const OPTION_META: Record<string, { group: string; label: string; risky?: boolean }> = {
  sleep: { group: 'need', label: 'go to sleep' },
  'eat-home': { group: 'eat', label: 'eat at home' },
  buy: { group: 'eat', label: 'buy a ration at the canteen' },
  'tavern-eat': { group: 'eat', label: 'have supper in the bar' },
  endure: { group: 'eat', label: 'endure the hunger' },
  steal: { group: 'eat', label: 'swipe a ration off the shelf', risky: true },
  beg: { group: 'eat', label: 'beg on the plaza' },
  school: { group: 'work', label: 'go to school' },
  play: { group: 'social', label: 'play on the plaza' },
  bench: { group: 'rest', label: 'sit on a bench' },
  loiter: { group: 'rest', label: 'loiter about' },
  work: { group: 'work', label: 'go to work' },
  tavern: { group: 'social', label: 'sit in the bar' },
  square: { group: 'social', label: 'walk around the plaza' },
  seek: { group: 'goal', label: 'find the person you need' },
  burgle: { group: 'goal', label: 'break into someone else\'s module', risky: true },
  report: { group: 'goal', label: 'report to the patrol', risky: true },
  leave: { group: 'goal', label: 'leave the colony through the airlock' },
  build: { group: 'goal', label: 'build your own module' },
  helpbuild: { group: 'goal', label: 'help the neighbours on the build' },
  pray: { group: 'rest', label: 'pray in the chapel' },
  home: { group: 'rest', label: 'sit at home' },
  wander: { group: 'rest', label: 'wander around the colony' },
}

function decide(w: World, c: Character) {
  const h = hourOf(w.t)
  const n = c.needs
  const isChild = c.role === 'child'
  const opts: Option[] = []
  const minutesUntil = (hour: number) => ((hour * 60 - (w.t % 1440)) + 1440) % 1440 || 1440
  const goal = (id: string) => c.goals.find(gg => gg.id.startsWith(id))

  // sleep
  const night = h >= 22 || h < 6
  opts.push({
    name: 'sleep', weight: night ? 12 + n.sleep * 6 : n.sleep > 0.85 ? 5 : 0,
    run: () => goTo(w, c, homeSpot(w, c), 'sleep', 'sleeping', night ? minutesUntil(6) + Math.floor(w.rng() * 50) : 90, 'home'),
  })
  // eat
  if (n.hunger > 0.45) {
    const hw = n.hunger * 9
    if (c.food > 0) opts.push({ name: 'eat-home', weight: hw, run: () => goTo(w, c, homeSpot(w, c), 'eat', 'eating at home', 25, 'home') })
    else if (isChild) opts.push({ name: 'eat-home', weight: hw, run: () => goTo(w, c, homeSpot(w, c), 'eat', 'eating at home', 25, 'home') })
    else if (c.money >= w.foodPrice && h >= 6 && h < 18 && w.stock.food > 0) opts.push({ name: 'buy', weight: hw, run: () => goTo(w, c, spot(w, 'bakery'), 'eat', 'buying a ration', 15, 'bakery') })
    else if (c.money >= w.foodPrice + 1 && (h >= 16 || h < 2) && w.stock.food > 0) opts.push({ name: 'tavern-eat', weight: hw, run: () => goTo(w, c, spot(w, 'tavern'), 'eat', 'having supper in the bar', 40, 'tavern') })
    else {
      opts.push({ name: 'endure', weight: 2 + Math.max(0, c.traits.honesty) * 3 + (c.mood.shame > 0.3 ? 2 : 0), run: () => { c.activity = { kind: 'rest', label: 'enduring the hunger', until: w.t + 40, place: null } } })
      if (h >= 7 && h < 19) opts.push({ name: 'steal', weight: (n.hunger * 4 * (1 - c.traits.honesty) + (goal('rich') ? 2 : 0)) * (1 - c.mood.fear * 0.8) * (1 - c.mood.shame * 0.6), run: () => goTo(w, c, spot(w, w.rng() < 0.5 ? 'market' : 'bakery'), 'steal', 'hovering by the shelves', 6, 'market') })
      opts.push({ name: 'beg', weight: n.hunger * 3 * (1 - c.traits.courage * 0.5) - c.mood.shame, run: () => goTo(w, c, spot(w, 'square'), 'rest', 'begging', 60, 'square') })
    }
  }
  // work / school
  const workH = h >= 8 && h < 18
  if (workH && !c.sick) {
    if (isChild) {
      if (h >= 9 && h < 14) opts.push({ name: 'school', weight: 6, run: () => goTo(w, c, spot(w, 'school'), 'work', 'studying at school', 60 + Math.floor(w.rng() * 60), 'school') })
      else opts.push({ name: 'play', weight: 5, run: () => goTo(w, c, spot(w, w.rng() < 0.6 ? 'square' : 'road'), 'play', 'playing', 40, 'square') })
    } else if (c.role === 'old') {
      opts.push({ name: 'bench', weight: 4, run: () => goTo(w, c, spot(w, w.rng() < 0.7 ? 'square' : 'church'), 'rest', 'sitting on a bench', 70, 'square') })
    } else if (c.role === 'vagrant' || c.role === 'stranger') {
      opts.push({ name: 'loiter', weight: 3, run: () => goTo(w, c, spot(w, w.rng() < 0.5 ? 'square' : 'tavern'), 'rest', 'loitering', 60, 'square') })
    } else {
      const wp = WORKPLACE[c.role] ?? 'square'
      const labels: Record<string, string> = { smith: 'fixing machines', baker: 'cooking rations', merchant: 'running the depot', guard: 'on patrol', teacher: 'teaching the children', priest: 'holding a service', farmer: 'working the hydroponics', innkeeper: 'behind the counter', miller: 'watching the reactor', elder: 'settling disputes', healer: 'seeing patients', carpenter: 'welding frames', hunter: 'out on a sortie beyond the dome', weaver: 'keeping contact with Earth' }
      opts.push({ name: 'work', weight: 6 + (c.money < 8 ? 3 : 0), run: () => goTo(w, c, wp === 'home' ? homeSpot(w, c) : spot(w, wp), 'work', labels[c.role] ?? 'working', 60 + Math.floor(w.rng() * 90), wp) })
    }
  }
  // social
  const socialW = n.social * 6 + c.traits.sociability * 2 + (goal('elder') ? 2 : 0)
  if (socialW > 0 && !night) {
    if (h >= 17 && !isChild && c.money >= 1) opts.push({ name: 'tavern', weight: socialW * (0.8 + c.traits.sociability * 0.4), run: () => goTo(w, c, spot(w, 'tavern'), 'drink', 'sitting in the bar', 50 + Math.floor(w.rng() * 60), 'tavern') })
    opts.push({ name: 'square', weight: socialW * 0.8, run: () => goTo(w, c, spot(w, 'square'), 'rest', 'walking the plaza', 30 + Math.floor(w.rng() * 40), 'square') })
  }
  // goals
  for (const gl of c.goals) {
    const target = gl.target ? w.chars.find(x => x.id === gl.target) : undefined
    const tAlive = target && target.alive && !target.left
    if ((gl.id.startsWith('court') || gl.id.startsWith('revenge') || gl.id.startsWith('reconcile') || gl.id.startsWith('debt')) && tAlive && awake(target!) && !night) {
      opts.push({ name: 'seek', label: `find ${target!.name.nom}`, weight: 3 * gl.priority + 1, run: () => goTo(w, c, nearFree(w, target!.pos), 'rest', `looking for ${target!.name.nom}`, 10, 'target', target!.id) })
    }
    if (gl.id.startsWith('steal') && tAlive && !isChild) {
      const th = home(w, target!)
      if (th && dist(target!.pos, th.door) > 8 && (night || w.rng() < 0.3)) opts.push({ name: 'burgle', label: `break into ${target!.name.nom}'s module`, weight: 4 * gl.priority, run: () => goTo(w, c, th.door, 'steal', 'creeping toward the module', 8, th.id, target!.id) })
    }
    if (gl.id.startsWith('report') && tAlive && workH) {
      opts.push({ name: 'report', label: `report ${target!.name.nom} to the patrol`, weight: 3 * gl.priority, run: () => goTo(w, c, spot(w, 'guard'), 'talk', 'heading to the patrol', 10, 'guard', target!.id) })
    }
    if (gl.id.startsWith('leave') && dayOf(w.t) > c.arrivedDay && h >= 6 && h < 20) {
      opts.push({ name: 'leave', weight: 4 * gl.priority, run: () => goTo(w, c, spot(w, 'exit'), 'leave', 'leaving through the airlock', 5, 'exit') })
    }
  }
  // construction
  const buildGoal = c.goals.find(gl => gl.id === 'build')
  const site = buildGoal ? w.buildings.find(b => b.id === buildGoal.target && b.site) : undefined
  if (site && h >= 6 && h < 20 && !c.sick && !isChild) {
    opts.push({ name: 'build', weight: 7 + (site.reason === 'rebuild' ? 3 : 0), run: () => goTo(w, c, nearFree(w, site.door), 'build', site.reason === 'rebuild' ? 'rebuilding the module' : 'building the module', 70 + Math.floor(w.rng() * 40), site.id) })
  } else if (workH && !isChild && !c.sick && c.role !== 'old') {
    for (const b of w.buildings) {
      if (!b.site || dist(c.pos, b.door) > 16) continue
      const owners = b.owners.map(id => w.chars.find(x => x.id === id)!).filter(Boolean)
      if (!owners.length) continue
      const liking = Math.max(...owners.map(o => rel(c, o).liking + (rel(c, o).family ? 0.5 : 0)))
      const someoneThere = alive(w).some(o => o.activity.kind === 'build' && o.activity.place === b.id)
      const wgt = (c.role === 'carpenter' ? 3 : 0) + c.traits.generosity * 1.5 + liking * 2 + (b.reason === 'rebuild' ? 1.2 : 0) + (goal('help') ? 2 : 0) - 0.6
      if (wgt > 0 && (someoneThere || c.role === 'carpenter' || liking > 0.5)) opts.push({ name: 'helpbuild', label: `help ${owners[0].name.nom} on the build`, weight: wgt, run: () => goTo(w, c, nearFree(w, b.door), 'build', `helping ${owners[0].name.nom} ${b.reason === 'rebuild' ? 'rebuild the module' : 'build the module'}`, 50 + Math.floor(w.rng() * 30), b.id) })
    }
  }
  // pray
  if (h >= 7 && h < 9 && !isChild && (c.traits.honesty > 0.2 || c.mood.shame > 0.3 || c.role === 'old')) opts.push({ name: 'pray', weight: 2 + c.mood.shame * 3, run: () => goTo(w, c, spot(w, 'church'), 'pray', 'sitting in the chapel', 30, 'church') })
  // misc
  opts.push({ name: 'home', weight: 1.2 + (c.mood.fear * 3) + (c.sick ? 6 : 0), run: () => goTo(w, c, homeSpot(w, c), c.sick ? 'sick' : 'rest', c.sick ? 'lying sick' : 'sitting at home', 60, 'home') })
  opts.push({ name: 'wander', weight: 1, run: () => goTo(w, c, spot(w, w.rng() < 0.5 ? 'road' : 'forest'), 'rest', 'wandering', 20, null) })

  const temperature = 1 + c.mood.anger * 0.8 + n.hunger * 0.3 + c.drunk * 0.6
  const menu: MenuOption[] = opts.filter(o => o.weight > 0).map(o => ({ name: o.name, weight: o.weight, group: OPTION_META[o.name]?.group ?? 'rest', label: o.label ?? OPTION_META[o.name]?.label ?? o.name, risky: OPTION_META[o.name]?.risky }))
  if (!menu.length) return
  // inner state the brain is asked about; local brains answer from these priors
  const inner = {
    desperate: Math.min(3, Math.round((n.hunger > 0.8 ? 1.5 : 0) + (c.money < 3 ? 1 : 0) + c.mood.anger + c.mood.fear * 0.5)),
    important: Math.min(1, (c.goals.some(gl => gl.source === 'player') ? 0.3 : 0) + c.mood.anger * 0.3 + c.mood.shame * 0.3 + (c.needs.hunger > 0.9 ? 0.3 : 0)),
    fear: Math.max(0, Math.min(1, 0.3 + c.mood.fear * 0.5 + c.traits.honesty * 0.3 - c.traits.courage * 0.2)),
  }
  const questions = buildQuestions(menu, inner)
  const state = buildState(w, c)
  const brain = getBrain()
  const apply = (answers: Answer[]) => {
    const res = resolveDecision(menu, answers, w.rng, temperature)
    const opt = opts.find(o => o.name === res.option.name)!
    c.lastDecision = { t: w.t, state, chosen: res.option.label, probs: res.probs, desperate: res.desperate, important: res.important, fear: res.fear, brain: brain.kind }
    w.decisions.push({ t: w.t, charId: c.id, chosen: res.option.label, state })
    if (w.decisions.length > 400) w.decisions.splice(0, 100)
    if (res.fear > 0.7) mood(c, { fear: 0.03 })
    if (res.important > 0.85 && w.rng() < 0.3) log(w, `${c.name.nom} senses that something important is being decided`, 'life', 0.35, [c.id])
    opt.run()
  }
  const answers = brain.decide(state, questions)
  if (answers instanceof Promise) {
    c.activity = { kind: 'think', label: 'thinking it over', until: w.t + 60, place: c.activity.place }
    c.path = []; c.intent = null
    answers
      .then(a => w.brainQueue.push({ charId: c.id, apply: () => apply(a) }))
      .catch(() => w.brainQueue.push({ charId: c.id, apply: () => apply(new HeuristicBrain().decide(state, questions)) }))
  } else apply(answers)
}

const WORKPLACE: Partial<Record<Character['role'], string>> = {
  smith: 'forge', baker: 'bakery', merchant: 'market', guard: 'square', teacher: 'school', priest: 'church',
  farmer: 'fields', innkeeper: 'tavern', miller: 'mill', elder: 'square', healer: 'forest', carpenter: 'road',
  hunter: 'forest', weaver: 'home',
}

function nearFree(w: World, p: Vec): Vec {
  const cands = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]
  for (const [dx, dy] of cands) { const x = Math.round(p.x) + dx, y = Math.round(p.y) + dy; if (walkable(w, x, y)) return { x, y } }
  return { x: 24, y: 18 }
}

// ───────────────────────── arrival effects ─────────────────────────

function onArrive(w: World, c: Character) {
  const a = c.activity
  if (a.kind === 'eat') {
    if (a.place === 'home') { if (c.food > 0) c.food--; c.needs.hunger = Math.max(0, c.needs.hunger - 0.7) }
    else if (a.place === 'bakery') { c.money -= w.foodPrice; c.needs.hunger = 0.1; w.stock.food = Math.max(0, w.stock.food - 1); if (w.rng() < 0.25 && w.stock.food > 0) { c.food += 1; w.stock.food-- } }
    else if (a.place === 'tavern') { c.money -= w.foodPrice + 1; c.needs.hunger = 0.05; c.drunk = clamp(c.drunk + 0.2, 0, 1); w.stock.food = Math.max(0, w.stock.food - 1) }
    mood(c, { joy: 0.08 })
  }
  if (a.kind === 'drink') { c.money -= 1; c.drunk = clamp(c.drunk + 0.35, 0, 1); c.needs.social -= 0.3; mood(c, { joy: 0.1 }) }
  if (a.kind === 'pray') { mood(c, { shame: -0.25, fear: -0.1, joy: 0.05 }) }
  if (a.kind === 'sleep') { c.needs.sleep = Math.max(0, c.needs.sleep - 0.2) }
  if (a.kind === 'steal') resolveTheft(w, c)
  if (a.kind === 'talk' && a.place === 'guard' && a.with) resolveReport(w, c, a.with)
  if (a.kind === 'leave') {
    c.left = true
    c.goals = []
    log(w, `${c.name.nom} left the colony through the airlock. Whether they return, nobody knows.`, 'world', 1, [c.id])
    for (const o of alive(w)) if (rel(o, c).liking > 0.4 || rel(o, c).family) { remember(o, w, `${c.name.nom} left the colony`, 0.8, [c.id]); mood(o, { joy: -0.3 }) }
  }
}

function resolveTheft(w: World, c: Character) {
  const isBurglary = c.activity.place?.startsWith('h') && c.activity.with
  const guard = alive(w).find(x => x !== c && x.role === 'guard' && awake(x) && dist(x.pos, c.pos) <= 5)
  const wit = witnesses(w, c.pos, 3, [c.id, guard?.id ?? ''])
  const pCaught = 0.2 + (guard ? 0.5 : 0) + wit.length * 0.12 - c.traits.courage * 0.05
  const where = wherePhrase(w, c.pos)
  w.stats.thefts++
  if (isBurglary) {
    const victim = w.chars.find(x => x.id === c.activity.with)!
    const take = Math.floor(victim.money * 0.35)
    if (w.rng() < pCaught * 0.6) {
      log(w, `${c.name.nom} got caught: ${wit[0] ? wit[0].name.nom + ' found' : 'a neighbour found'} ${g(c, 'him', 'her')} at ${victim.name.nom}'s module`, 'conflict', 0.85, [c.id, victim.id])
      mood(c, { shame: 0.5, fear: 0.4 })
      for (const o of [...wit, victim]) { remember(o, w, `${c.name.nom} tried to rob ${victim.name.nom}'s module`, 0.85, [c.id, victim.id], c.id); o.beliefs.push({ claim: `${c.name.nom} is a thief`, confidence: 0.9, about: c.id }); adjust(o, c, { trust: -0.5, liking: -0.4 }) }
    } else {
      c.money += take; victim.money -= take
      const loot = take > 0 ? `${take} credits are gone` : (victim.food > 0 ? (victim.food--, c.food++, 'The last ration was taken') : 'There was nothing to take — the place was turned upside down')
      log(w, `Someone robbed ${victim.name.nom}'s module while nobody was home. ${loot}. It was ${c.name.nom}`, 'conflict', 0.8, [c.id, victim.id])
      remember(victim, w, `someone broke into my module. ${loot.toLowerCase()}`, 0.85, [victim.id])
      mood(victim, { anger: 0.5, fear: 0.2 })
      const suspect = Object.entries(victim.relations).filter(([, r]) => !r.family).sort((a, b) => a[1].trust - b[1].trust)[0]
      if (suspect) { victim.beliefs.push({ claim: `${w.chars.find(x => x.id === suspect[0])!.name.nom} robbed my module`, confidence: 0.45, about: suspect[0] }) }
      remember(c, w, `robbed ${victim.name.nom}'s module — ${take} credits`, 0.7, [c.id, victim.id], c.id)
      mood(c, { fear: 0.2, shame: c.traits.honesty > 0 ? 0.3 : 0.05, joy: 0.1 })
    }
    c.goals = c.goals.filter(gl => !gl.id.startsWith('steal'))
    return
  }
  if (w.rng() < pCaught) {
    const catcher = guard ?? wit[0]
    const text = guard
      ? `patrol officer ${guard.name.nom} caught ${c.name.nom} red-handed ${where}: ${g(c, 'he', 'she')} was pulling a ration off the shelf`
      : catcher ? `${catcher.name.nom} caught ${c.name.nom} red-handed ${where}: ${g(c, 'he', 'she')} was pulling a ration off the shelf` : `${c.name.nom} got caught stealing ${where}`
    log(w, text, 'conflict', 0.8, [c.id, catcher?.id ?? ''].filter(Boolean))
    mood(c, { shame: 0.5, fear: 0.4, anger: 0.2 })
    c.money = Math.max(0, c.money - 3)
    for (const o of witnesses(w, c.pos, 7, [c.id])) { remember(o, w, text, 0.75, [c.id], c.id); o.beliefs.push({ claim: `${c.name.nom} is a thief`, confidence: 0.8, about: c.id }); adjust(o, c, { trust: -0.35, liking: -0.25 }) }
    if (guard) adjust(c, guard, { fear: 0.3 })
    remember(c, w, `I got caught stealing ${where}`, 0.9, [c.id], c.id)
  } else {
    c.food += 1; c.needs.hunger = Math.max(0, c.needs.hunger - 0.5)
    log(w, `${c.name.nom} swiped a ration off the shelf ${where}. ${wit.length ? 'Someone noticed.' : 'Nobody noticed.'}`, 'conflict', 0.55, [c.id])
    for (const o of wit) if (w.rng() < 0.6) { remember(o, w, `${c.name.nom} swiped a ration off the shelf ${where}`, 0.65, [c.id], c.id); o.beliefs.push({ claim: `${c.name.nom} is a thief`, confidence: 0.6, about: c.id }); adjust(o, c, { trust: -0.25 }) }
    remember(c, w, `swiped a ration ${where}, got away with it`, 0.5, [c.id], c.id)
    mood(c, { shame: c.traits.honesty > 0 ? 0.3 : 0.05, fear: 0.1 })
  }
}

function resolveReport(w: World, c: Character, targetId: string) {
  const target = w.chars.find(x => x.id === targetId)!
  const guard = alive(w).find(x => x.role === 'guard' && dist(x.pos, c.pos) <= 4)
  c.goals = c.goals.filter(gl => !gl.id.startsWith('report'))
  if (!guard) { log(w, `${c.name.nom} went to the security post, but found nobody there.`, 'life', 0.3, [c.id]); return }
  const belief = c.beliefs.find(b => b.about === target.id)
  const claim = belief?.claim ?? `${target.name.nom} is up to no good`
  log(w, `${c.name.nom} reported ${target.name.nom} to patrol officer ${guard.name.nom}: «${claim}»`, 'conflict', 0.75, [c.id, target.id, guard.id])
  guard.beliefs.push({ claim, confidence: 0.5 + rel(guard, c).trust * 0.3, about: target.id })
  adjust(guard, target, { trust: -0.3 })
  guard.goals.push({ id: `interrogate-${target.id}`, text: `question ${target.name.nom}`, priority: 0.7, source: 'self', target: target.id })
  remember(guard, w, `${c.name.nom} reported ${target.name.nom}: ${claim}`, 0.6, [c.id, target.id], target.id, 'told')
  remember(c, w, `reported ${target.name.nom} to the patrol`, 0.7, [c.id, target.id])
  mood(c, { shame: c.traits.honesty > 0.3 ? 0.1 : 0, joy: 0.1 })
}

// ───────────────────────── interactions ─────────────────────────

interface IOpt { name: string; weight: number; run: () => void }

function interact(w: World, a: Character, b: Character) {
  const rab = rel(a, b), rba = rel(b, a)
  const where = wherePhrase(w, a.pos)
  const wit = witnesses(w, a.pos, 4, [a.id, b.id])
  const isChildA = a.role === 'child', isChildB = b.role === 'child'
  const adults = !isChildA && !isChildB
  const goalOn = (id: string) => a.goals.find(gg => gg.id.startsWith(id) && gg.target === b.id)
  const opts: IOpt[] = []
  rab.lastContact = w.t; rba.lastContact = w.t

  const busy = (c: Character, kind: ActivityKind, label: string, minutes: number, withId: string) => {
    c.activity = { kind, label, until: w.t + minutes, place: c.activity.place, with: withId }; c.path = []; c.intent = null
  }

  // talk
  opts.push({
    name: 'talk', weight: 4 + a.traits.sociability * 2 + Math.max(0, rab.liking) * 3 + (goalOn('reconcile') ? 4 : 0),
    run: () => {
      busy(a, 'talk', `chatting with ${b.name.nom}`, 8 + Math.floor(w.rng() * 8), b.id); busy(b, 'talk', `chatting with ${a.name.nom}`, 8 + Math.floor(w.rng() * 8), a.id)
      a.needs.social = Math.max(0, a.needs.social - 0.35); b.needs.social = Math.max(0, b.needs.social - 0.35)
      const warm = 0.03 + (rab.liking > 0 ? 0.02 : 0)
      adjust(a, b, { liking: warm, trust: 0.01 }); adjust(b, a, { liking: warm, trust: 0.01 })
      if (goalOn('reconcile')) {
        const ok = w.rng() < 0.5 + rba.liking * 0.3 + b.traits.generosity * 0.2
        if (ok) {
          log(w, `${a.name.nom} apologised to ${b.name.nom} ${where}. ${b.name.nom} forgave ${g(a, 'him', 'her')}`, 'kindness', 0.7, [a.id, b.id])
          adjust(a, b, { liking: 0.4, trust: 0.2 }); adjust(b, a, { liking: 0.45, trust: 0.25 })
          remember(a, w, `made peace with ${b.name.nom}`, 0.75, [a.id, b.id]); remember(b, w, `${a.name.nom} apologised, and I forgave ${g(a, 'him', 'her')}`, 0.75, [a.id, b.id])
          b.beliefs = b.beliefs.filter(bl => bl.about !== a.id); w.stats.kindness++
        } else {
          log(w, `${a.name.nom} apologised to ${b.name.nom}, but ${b.name.nom} turned away`, 'conflict', 0.6, [a.id, b.id])
          mood(a, { shame: 0.3, anger: 0.15 }); remember(a, w, `${b.name.nom} did not accept my apology`, 0.7, [a.id, b.id], b.id)
        }
        a.goals = a.goals.filter(gl => gl !== goalOn('reconcile'))
      } else if (w.rng() < 0.12) log(w, `${a.name.nom} and ${b.name.nom} exchanged a few words ${where}`, 'life', 0.1, [a.id, b.id])
    },
  })
  // gossip
  const rumor = [...a.memory, ...a.longMemory].filter(m => m.weight >= 0.4 && m.culprit && m.culprit !== b.id && m.culprit !== a.id && !b.memory.some(x => x.text === m.text || (x.culprit === m.culprit && x.about.join() === m.about.join())) && !b.longMemory.some(x => x.text === m.text)).sort((x, y) => y.weight - x.weight)[0]
  if (rumor && !isChildA && !isChildB && !rba.family) opts.push({
    name: 'gossip', weight: 2.5 + a.traits.sociability * 2 - a.traits.honesty * 0.5 + (rab.liking > 0.2 ? 1 : 0),
    run: () => {
      busy(a, 'talk', `whispering with ${b.name.nom}`, 10, b.id); busy(b, 'talk', `listening to ${a.name.nom}`, 10, a.id)
      const hops = (rumor.hops ?? 0) + 1
      let culprit = rumor.culprit!
      let text = rumor.text
      const pDistort = 0.12 + hops * 0.1 + Math.max(0, -a.traits.honesty) * 0.25
      // a rumour brought from another dome names people nobody here knows: it spreads as a tale, without consequences
      const known = w.chars.find(x => x.id === culprit)
      if (known && w.rng() < pDistort) {
        const old = known
        const cand = alive(w).filter(x => x.id !== culprit && x.id !== a.id && x.id !== b.id && x.name.sex === old.name.sex && rel(a, x).liking < 0.1)
        if (cand.length) {
          const nw = randomOf(w, cand)
          const forms = (['nom', 'gen', 'dat', 'acc', 'ins'] as const).slice().sort((x, y) => old.name[y].length - old.name[x].length)
          for (const k of forms) text = text.replace(new RegExp(`(^|[^A-Za-z])${old.name[k]}(?![A-Za-z])`, 'g'), `$1${nw.name[k]}`)
          culprit = nw.id
        }
      }
      const cul = w.chars.find(x => x.id === culprit)
      const believes = w.rng() < 0.45 + rba.trust * 0.4 + b.traits.trust * 0.25 - ((cul ? rel(b, cul).liking : 0) * 0.3)
      w.stats.rumors++
      if (believes) {
        remember(b, w, text, Math.min(1, rumor.weight + 0.05), rumor.about, culprit, 'told', hops)
        if (cul) {
          const ex = b.beliefs.find(bl => bl.about === culprit)
          if (ex) ex.confidence = Math.min(1, ex.confidence + 0.15); else b.beliefs.push({ claim: `${cul.name.nom} is not to be trusted`, confidence: 0.5, about: culprit })
          adjust(b, cul, { trust: -0.15, liking: -0.1 })
          log(w, `${a.name.nom} whispered to ${b.name.nom} ${where}: «${text}»${hops > 1 ? ' — the rumor has now changed hands ' + hops + ' times' : ''}`, 'rumor', 0.45 + hops * 0.05, [a.id, b.id, culprit])
        } else log(w, `${a.name.nom} retold ${b.name.nom} a story from another dome ${where}: «${text}»`, 'rumor', 0.4, [a.id, b.id])
      } else {
        adjust(b, a, { trust: -0.05 })
        if (w.rng() < 0.5) log(w, `${b.name.nom} did not believe ${a.name.nom}: «${text}»`, 'rumor', 0.3, cul ? [a.id, b.id, culprit] : [a.id, b.id])
      }
    },
  })
  // quarrel
  const quarrelW = 0.08 + a.mood.anger * 1.8 + Math.max(0, a.traits.temper) * 0.6 + (rab.liking < -0.2 ? 1.8 : 0) + (goalOn('revenge') ? 4 : 0) + a.drunk * 1.2 - (rab.family ? 0.6 : 0) - (rab.liking > 0.3 ? 1 : 0)
  if (!isChildA && !isChildB) opts.push({
    name: 'quarrel', weight: quarrelW,
    run: () => {
      const reasons = [rab.debt !== 0 ? 'over a debt' : '', rab.liking < -0.3 ? 'over an old grudge' : '', 'over the queue at the depot', 'over a partition wall', 'over a careless word', a.drunk > 0.3 ? 'in a drunken fit' : ''].filter(Boolean)
      const reason = randomOf(w, reasons)
      busy(a, 'quarrel', `quarreling with ${b.name.nom}`, 8, b.id); busy(b, 'quarrel', `quarreling with ${a.name.nom}`, 8, a.id)
      adjust(a, b, { liking: -0.15 }); adjust(b, a, { liking: -0.15 })
      mood(a, { anger: 0.25 }); mood(b, { anger: 0.3 })
      w.stats.conflicts++
      const escalate = a.traits.courage > -0.2 && w.rng() < 0.04 + Math.max(0, a.traits.temper) * 0.2 + a.mood.anger * 0.25 + (a.traits.courage > b.traits.courage ? 0.05 : -0.1) + (goalOn('revenge') ? 0.35 : 0) - (a.name.sex === 'f' ? 0.08 : 0)
      if (escalate) {
        busy(a, 'fight', `fighting ${b.name.nom}`, 6, b.id); busy(b, 'fight', `fighting ${a.name.nom}`, 6, a.id)
        const text = `${a.name.nom} hit ${b.name.nom} ${where} ${reason}`
        log(w, text, 'conflict', 0.85, [a.id, b.id])
        mood(b, { fear: 0.35, shame: 0.2 }); mood(a, { shame: a.traits.honesty > 0.2 ? 0.2 : 0 })
        adjust(b, a, { fear: 0.35, liking: -0.3, trust: -0.2 })
        remember(a, w, `hit ${b.name.nom} ${reason}`, 0.7, [a.id, b.id], a.id)
        remember(b, w, `${a.name.nom} hit me ${where}`, 0.9, [a.id, b.id], a.id)
        for (const o of wit) { remember(o, w, text, 0.7, [a.id, b.id], a.id); adjust(o, a, { fear: 0.1, liking: -0.1 }) }
        const guard = alive(w).find(x => x.role === 'guard' && awake(x) && dist(x.pos, a.pos) <= 7 && x.id !== a.id && x.id !== b.id)
        if (guard) { log(w, `Patrol officer ${guard.name.nom} pulled the brawlers apart`, 'world', 0.4, [guard.id, a.id, b.id]); adjust(a, guard, { fear: 0.2 }); mood(a, { anger: -0.2 }) }
        if (goalOn('revenge')) a.goals = a.goals.filter(gl => gl !== goalOn('revenge'))
      } else {
        const text = `${a.name.nom} and ${b.name.nom} quarreled ${where} ${reason}`
        log(w, text, 'conflict', 0.5, [a.id, b.id])
        remember(a, w, `quarreled with ${b.name.nom} ${reason}`, 0.45, [a.id, b.id], b.id)
        remember(b, w, `quarreled with ${a.name.nom} ${reason}`, 0.5, [a.id, b.id], a.id)
        for (const o of wit) if (w.rng() < 0.5) remember(o, w, text, 0.35, [a.id, b.id])
      }
    },
  })
  // debt
  if (rab.debt > 0) opts.push({
    name: 'debt', weight: 2.5 + (a.money < 8 ? 2 : 0) + (goalOn('debt') ? 1.5 : 0),
    run: () => {
      busy(a, 'talk', `demanding the debt from ${b.name.nom}`, 6, b.id); busy(b, 'talk', `explaining to ${a.name.nom}`, 6, a.id)
      const pays = b.money >= rab.debt && (rba.liking + b.traits.honesty + (wit.length ? 0.3 : 0)) > 0.1
      if (pays) {
        b.money -= rab.debt; a.money += rab.debt
        log(w, `${b.name.nom} paid ${a.name.nom} back — ${rab.debt} credits`, 'trade', 0.5, [a.id, b.id])
        remember(a, w, `${b.name.nom} paid the debt back`, 0.5, [a.id, b.id]); adjust(a, b, { trust: 0.3, liking: 0.15 })
        rab.debt = 0; rba.debt = 0; a.goals = a.goals.filter(gl => gl.target !== b.id || !gl.id.startsWith('debt'))
      } else {
        log(w, `${b.name.nom} again failed to pay ${a.name.nom} back${wit.length ? ' — in front of people' : ''}`, 'conflict', 0.4, [a.id, b.id])
        mood(a, { anger: 0.25 }); mood(b, { shame: wit.length ? 0.25 : 0.1 }); adjust(a, b, { liking: -0.1, trust: -0.1 })
        remember(a, w, `${b.name.nom} again failed to pay the debt`, 0.45, [a.id, b.id], b.id)
        if (a.traits.temper > 0.3 && w.rng() < 0.35) {
          log(w, `${a.name.nom} threatened ${b.name.nom}: pay up or regret it`, 'conflict', 0.6, [a.id, b.id])
          adjust(b, a, { fear: 0.25, liking: -0.2 }); mood(b, { fear: 0.25 }); remember(b, w, `${a.name.nom} threatened me over the debt`, 0.7, [a.id, b.id], a.id)
        }
      }
    },
  })
  // ask for a loan
  if (adults && a.money < 5 && !rab.family && a.role !== 'child') opts.push({
    name: 'loan', weight: 1.5 + a.needs.hunger * 2.5 + (a.goals.some(gl => gl.id === 'rich') ? 1 : 0) - a.mood.shame * 2,
    run: () => {
      busy(a, 'talk', `asking ${b.name.nom} for a loan`, 6, b.id); busy(b, 'talk', `deciding whether to lend to ${a.name.nom}`, 6, a.id)
      const amount = 5 + Math.floor(w.rng() * 6)
      const score = b.traits.generosity + rba.liking + rba.trust * 0.5 - (b.money < amount + 5 ? 1.5 : 0) - (rab.debt < 0 ? 0.5 : 0)
      if (score > 0.1 && b.money >= amount) {
        b.money -= amount; a.money += amount
        rba.debt += amount; rab.debt -= amount
        log(w, `${b.name.nom} lent ${a.name.nom} ${amount} credits`, 'kindness', 0.45, [a.id, b.id])
        adjust(a, b, { liking: 0.2, trust: 0.15 }); remember(a, w, `${b.name.nom} helped me out — gave me a loan`, 0.55, [a.id, b.id]); w.stats.kindness++
        if (!b.goals.some(gl => gl.target === a.id)) b.goals.push({ id: `debt-${a.id}`, text: `collect the debt from ${a.name.nom}`, priority: 0.4, source: 'self', target: a.id })
      } else {
        const publicly = wit.length > 0
        log(w, `${b.name.nom} refused ${a.name.nom} a loan${publicly ? ' in front of people' : ''}`, 'conflict', publicly ? 0.5 : 0.3, [a.id, b.id])
        mood(a, { shame: publicly ? 0.3 : 0.1, anger: 0.15 }); adjust(a, b, { liking: -0.2 })
        remember(a, w, `${b.name.nom} refused me a loan${publicly ? ' in front of everyone' : ''}`, publicly ? 0.75 : 0.45, [a.id, b.id], b.id)
        if (publicly) for (const o of wit) if (w.rng() < 0.4) remember(o, w, `${b.name.nom} refused ${a.name.nom} a loan in front of everyone`, 0.35, [a.id, b.id])
      }
    },
  })
  // help with food
  if (b.needs.hunger > 0.6 && a.food > 0 && !isChildA) opts.push({
    name: 'help', weight: 1.5 + a.traits.generosity * 2.5 + rab.liking * 1.5 + (a.goals.some(gl => gl.id === 'help') ? 3 : 0),
    run: () => {
      busy(a, 'help', `sharing a ration with ${b.name.nom}`, 6, b.id); busy(b, 'eat', `eating ${a.name.nom}'s ration`, 6, a.id)
      a.food--; b.needs.hunger = Math.max(0, b.needs.hunger - 0.5)
      log(w, `${a.name.nom} shared a ration with ${b.name.nom} ${where}`, 'kindness', 0.5, [a.id, b.id])
      adjust(b, a, { liking: 0.25, trust: 0.15 }); mood(b, { joy: 0.2 }); mood(a, { joy: 0.1 })
      remember(b, w, `${a.name.nom} fed me when I was hungry`, 0.7, [a.id, b.id])
      for (const o of wit) if (w.rng() < 0.4) { remember(o, w, `${a.name.nom} shared a ration with ${b.name.nom}`, 0.35, [a.id, b.id]); adjust(o, a, { liking: 0.05 }) }
      w.stats.kindness++
    },
  })
  // treat to a drink
  if (adults && a.activity.kind === 'drink' && b.activity.kind === 'drink' && a.money >= 3 && !rab.family) opts.push({
    name: 'treat', weight: 1.2 + a.traits.generosity * 2 + Math.max(0, rab.liking) * 2 + a.drunk,
    run: () => {
      a.money -= 2; b.drunk = clamp(b.drunk + 0.2, 0, 1)
      busy(a, 'drink', `buying ${b.name.nom} a drink`, 12, b.id); busy(b, 'drink', `drinking on ${a.name.nom}'s tab`, 12, a.id)
      log(w, `${a.name.nom} bought ${b.name.nom} a drink in the bar`, 'kindness', 0.35, [a.id, b.id])
      adjust(b, a, { liking: 0.15, trust: 0.05 }); adjust(a, b, { liking: 0.05 }); mood(b, { joy: 0.15 }); w.stats.kindness++
      remember(b, w, `${a.name.nom} bought me a drink in the bar`, 0.4, [a.id, b.id])
    },
  })
  // small gift / kind word
  if (!isChildA && rab.liking > -0.05 && !rab.family) opts.push({
    name: 'gift', weight: 0.9 + a.traits.generosity * 1.8 + rab.liking * 1.5 + (a.goals.some(gl => gl.id === 'help') ? 2 : 0) + (a.mood.joy > 0.5 ? 0.5 : 0),
    run: () => {
      busy(a, 'help', `doing ${b.name.nom} a favour`, 8, b.id); busy(b, 'talk', `thanking ${a.name.nom}`, 8, a.id)
      const acts = a.role === 'baker' ? `${a.name.nom} slipped ${b.name.nom} a hot ration straight from the press` : a.role === 'smith' ? `${a.name.nom} fixed ${b.name.nom}'s respirator and took no credits` : a.role === 'healer' ? `${a.name.nom} gave ${b.name.nom} a stimulant for the aches` : b.role === 'child' ? `${a.name.nom} made ${b.name.nom} a little lantern` : `${a.name.nom} helped ${b.name.nom} carry containers ${where}`
      log(w, acts, 'kindness', 0.4, [a.id, b.id])
      adjust(b, a, { liking: 0.15, trust: 0.1 }); mood(b, { joy: 0.15 }); mood(a, { joy: 0.05 }); w.stats.kindness++
      remember(b, w, acts, 0.45, [a.id, b.id])
      for (const o of wit) if (w.rng() < 0.3) adjust(o, a, { liking: 0.05 })
    },
  })
  // comfort someone in a bad mood
  if (!isChildA && (b.mood.joy < 0.2 || b.mood.fear > 0.4 || b.mood.shame > 0.35) && rab.liking > -0.1) opts.push({
    name: 'comfort', weight: 1 + a.traits.generosity + a.traits.sociability * 0.5 + (rab.family ? 1.5 : 0),
    run: () => {
      busy(a, 'talk', `comforting ${b.name.nom}`, 10, b.id); busy(b, 'talk', `confiding in ${a.name.nom}`, 10, a.id)
      log(w, `${a.name.nom} sat down beside ${b.name.nom} ${where} and listened for a long while`, 'kindness', 0.4, [a.id, b.id])
      mood(b, { joy: 0.2, fear: -0.2, shame: -0.1 }); adjust(b, a, { liking: 0.2, trust: 0.15 }); w.stats.kindness++
      remember(b, w, `${a.name.nom} heard me out when things were hard`, 0.6, [a.id, b.id])
    },
  })
  // alms
  if (b.activity.label === 'begging' && a.money > 3 && !isChildA) opts.push({
    name: 'alms', weight: 1 + a.traits.generosity * 2 + (a.goals.some(gl => gl.id === 'help') ? 2 : 0),
    run: () => { a.money--; b.money++; log(w, `${a.name.nom} gave ${b.name.nom} a credit`, 'kindness', 0.35, [a.id, b.id]); adjust(b, a, { liking: 0.15 }); mood(b, { shame: 0.05, joy: 0.05 }) },
  })
  // accuse
  const belief = a.beliefs.find(bl => bl.about === b.id && bl.confidence >= 0.6)
  if (belief && wit.length >= 2 && !isChildA) opts.push({
    name: 'accuse', weight: 1 + a.mood.anger * 2 + Math.max(0, a.traits.temper) + Math.max(0, a.traits.courage) + (a.goals.some(gl => gl.id === 'elder') ? 1 : 0),
    run: () => {
      busy(a, 'quarrel', `accusing ${b.name.nom}`, 8, b.id); busy(b, 'quarrel', `making excuses in public`, 8, a.id)
      log(w, `${a.name.nom} publicly accused ${b.name.nom} ${where}: «${belief.claim}»`, 'conflict', 0.7, [a.id, b.id])
      mood(b, { shame: 0.3, anger: 0.35 }); adjust(b, a, { liking: -0.35, trust: -0.2 })
      for (const o of wit) {
        const believes = w.rng() < 0.4 + rel(o, a).trust * 0.4 - rel(o, b).liking * 0.3
        if (believes) { const ex = o.beliefs.find(bl => bl.about === b.id); if (ex) ex.confidence = Math.min(1, ex.confidence + 0.15); else o.beliefs.push({ claim: belief.claim, confidence: 0.45, about: b.id }); adjust(o, b, { trust: -0.15, liking: -0.1 }) }
        else adjust(o, a, { liking: -0.05 })
        remember(o, w, `${a.name.nom} publicly accused ${b.name.nom}: ${belief.claim}`, 0.5, [a.id, b.id], b.id)
      }
      remember(b, w, `${a.name.nom} publicly accused me: ${belief.claim}`, 0.85, [a.id, b.id], a.id)
      w.stats.conflicts++
    },
  })
  // courtship
  const bothSingle = isSingle(w, a) && isSingle(w, b)
  if (adults && a.name.sex !== b.name.sex && !rab.family && rab.liking > 0.35 && bothSingle && a.age < 60 && b.age < 60) opts.push({
    name: 'court', weight: 1.2 + rab.liking * 2.5 + (goalOn('court') ? 4 : 0) + a.traits.courage * 0.5,
    run: () => {
      busy(a, 'court', `flirting with ${b.name.nom}`, 12, b.id); busy(b, 'court', `listening to ${a.name.nom}`, 12, a.id)
      const gestures = [`${a.name.nom} gave ${b.name.nom} flowers from the greenhouse ${where}`, `${a.name.nom} and ${b.name.nom} took a long walk along the canal`, `${a.name.nom} walked ${b.name.nom} home to the module`]
      const text = randomOf(w, gestures)
      const gain = 0.12 + b.traits.trust * 0.05 + (rba.liking > 0 ? 0.05 : -0.05)
      adjust(b, a, { liking: gain, trust: 0.05 }); adjust(a, b, { liking: 0.08 }); mood(a, { joy: 0.15 }); mood(b, { joy: 0.1 })
      if (rba.liking > 0.7 && rab.liking > 0.7 && w.rng() < 0.3) {
        const yes = rba.trust > 0.25 && b.mood.anger < 0.4
        if (yes) {
          log(w, `${a.name.nom} proposed to ${b.name.nom} ${where}. ${b.name.nom} said yes!`, 'love', 0.95, [a.id, b.id])
          remember(a, w, `${b.name.nom} agreed to be my ${g(b, 'husband', 'wife')}`, 1, [a.id, b.id]); remember(b, w, `${a.name.nom} proposed to me, and I said yes`, 1, [a.id, b.id])
          rab.family = true; rba.family = true; a.goals = a.goals.filter(gl => !gl.id.startsWith('court'))
          a.goals.push({ id: 'wedding', text: 'hold the wedding', priority: 0.9, source: 'self', target: b.id })
          for (const o of alive(w)) if (o !== a && o !== b && w.rng() < 0.5) remember(o, w, `${a.name.nom} and ${b.name.nom} are engaged`, 0.5, [a.id, b.id], undefined, 'told')
        } else {
          log(w, `${a.name.nom} proposed to ${b.name.nom}, but ${b.name.nom} said no`, 'love', 0.85, [a.id, b.id])
          mood(a, { shame: 0.45, joy: -0.3 }); adjust(a, b, { liking: -0.25 }); remember(a, w, `${b.name.nom} turned me down`, 0.9, [a.id, b.id], b.id)
          for (const o of wit) remember(o, w, `${b.name.nom} turned ${a.name.nom} down ${where}`, 0.5, [a.id, b.id])
        }
      } else if (w.rng() < 0.45) {
        log(w, text, 'love', 0.45, [a.id, b.id])
        remember(b, w, text, 0.5, [a.id, b.id])
        // jealousy
        for (const o of wit) if (o.name.sex === a.name.sex && rel(o, b).liking > 0.5) { adjust(o, a, { liking: -0.3 }); mood(o, { anger: 0.3 }); remember(o, w, `${text} — and I was standing right there`, 0.7, [a.id, b.id, o.id], a.id); log(w, `${o.name.nom} saw it and ${g(o, 'his', 'her')} face darkened`, 'love', 0.5, [o.id, a.id, b.id]) }
      }
    },
  })
  // children play
  if (isChildA && isChildB) opts.push({
    name: 'play', weight: 5,
    run: () => {
      busy(a, 'play', `playing with ${b.name.nom}`, 15, b.id); busy(b, 'play', `playing with ${a.name.nom}`, 15, a.id)
      a.needs.social = 0; b.needs.social = 0; mood(a, { joy: 0.15 }); mood(b, { joy: 0.15 }); adjust(a, b, { liking: 0.05 }); adjust(b, a, { liking: 0.05 })
      if (w.rng() < 0.12 && a.traits.temper > 0) {
        log(w, `${a.name.nom} snatched ${b.name.nom}'s drone ${where}. ${b.name.nom} is in tears`, 'conflict', 0.35, [a.id, b.id])
        adjust(b, a, { liking: -0.2, fear: 0.1 }); mood(b, { anger: 0.2, joy: -0.2 }); remember(b, w, `${a.name.nom} snatched my drone`, 0.6, [a.id, b.id], a.id)
      } else if (w.rng() < 0.1) log(w, `${a.name.nom} and ${b.name.nom} are playing ${where}`, 'life', 0.1, [a.id, b.id])
    },
  })
  // interrogation (guard goal)
  const interrogate = a.goals.find(gl => gl.id.startsWith('interrogate') && gl.target === b.id)
  if (interrogate && a.role === 'guard') opts.push({
    name: 'interrogate', weight: 8,
    run: () => {
      busy(a, 'talk', `questioning ${b.name.nom}`, 10, b.id); busy(b, 'quarrel', `answering the patrol officer`, 10, a.id)
      const bl = a.beliefs.find(x => x.about === b.id)
      log(w, `Patrol officer ${a.name.nom} questioned ${b.name.nom} ${where}${bl ? `: «${bl.claim}»` : ''}`, 'conflict', 0.65, [a.id, b.id])
      mood(b, { fear: 0.3, shame: 0.2, anger: 0.25 }); adjust(b, a, { fear: 0.2, liking: -0.2 })
      const informer = alive(w).filter(o => o !== a && o !== b && !rel(b, o).family).sort((x, y) => rel(b, x).trust - rel(b, y).trust)[0]
      if (informer) { b.beliefs.push({ claim: `${informer.name.nom} reported me`, confidence: 0.5, about: informer.id }); adjust(b, informer, { liking: -0.3, trust: -0.3 }); remember(b, w, `the patrol questioned me — surely ${informer.name.nom} reported me`, 0.8, [a.id, b.id, informer.id], informer.id) }
      a.goals = a.goals.filter(gl => gl !== interrogate)
      for (const o of wit) remember(o, w, `the patrol questioned ${b.name.nom} ${where}`, 0.5, [a.id, b.id], b.id)
    },
  })

  const temperature = 1 + a.mood.anger * 0.7 + a.drunk * 0.6
  const pick = sampleWeighted(w, opts, temperature)
  if (pick) pick.run()
}

function isSingle(w: World, c: Character) {
  if (c.role === 'child' || c.role === 'old') return false
  if (Object.values(c.relations).some(r => r.family && w.chars.find(x => x.relations === undefined) === undefined && false)) return false
  const spouse = w.chars.some(o => o !== c && o.alive && rel(c, o).family && o.role !== 'child' && o.role !== 'old' && (o.home === c.home))
  return !spouse
}

// ───────────────────────── tick ─────────────────────────

export function tick(w: World) {
  w.t++
  if (w.brainQueue.length) {
    const q = w.brainQueue.splice(0)
    for (const p of q) { const c = w.chars.find(x => x.id === p.charId); if (c && c.alive && !c.left && c.activity.kind === 'think') p.apply() }
  }
  const h = hourOf(w.t)
  const drought = w.events.some(e => e.id === 'drought')
  const feast = w.events.some(e => e.id === 'feast')
  w.events = w.events.filter(e => e.until > w.t)
  if (w.t % 1440 === 6 * 60) runEconomy(w, drought)
  for (const k of Object.keys(w.cooldowns)) if (w.cooldowns[k] <= w.t) delete w.cooldowns[k]

  for (const c of w.chars) {
    if (!c.alive || c.left) continue
    const n = c.needs
    const asleep = c.activity.kind === 'sleep'
    n.hunger = clamp(n.hunger + 0.0009 * (drought ? 1.6 : 1) * (c.sick ? 1.3 : 1) * (asleep ? 0.4 : 1), 0, 1)
    n.sleep = clamp(n.sleep + (asleep ? -0.0035 : 0.00075), 0, 1)
    n.social = clamp(n.social + 0.0006 * (1 + c.traits.sociability * 0.6) * (asleep ? 0 : 1), 0, 1)
    n.safety = clamp(n.safety - 0.0004, 0, 1)
    c.mood.anger = clamp(c.mood.anger - 0.0014, 0, 1)
    c.mood.fear = clamp(c.mood.fear - 0.001, 0, 1)
    c.mood.shame = clamp(c.mood.shame - 0.0008, 0, 1)
    c.mood.joy = clamp(c.mood.joy + (0.3 - c.mood.joy) * 0.001, 0, 1)
    c.drunk = clamp(c.drunk - 0.004, 0, 1)
    if (n.hunger >= 1) { c.starving++; if (c.starving % 240 === 120) log(w, `${c.name.nom} has gone ${c.starving > 1400 ? 'days' : 'hours'} without food. Gaunt, but says nothing`, 'life', 0.5, [c.id]); if (c.starving > 2000 && w.rng() < 0.0006 && (c.role === 'old' || c.sick)) die(w, c, 'of hunger') }
    else c.starving = 0
    if (c.sick && w.rng() < 0.0004 && c.role === 'old') die(w, c, 'of the infection')
    if (c.sick && w.rng() < 0.0006) { c.sick = false; log(w, `${c.name.nom} is on the mend`, 'life', 0.4, [c.id]) }

    // movement
    if (c.path.length) {
      c.prev = { ...c.pos }
      const step = c.path.shift()!
      c.pos = { x: step.x, y: step.y }
      if (c.path.length === 0) arrive(w, c)
      continue
    }
    c.prev = { ...c.pos }
    // decision
    if (w.t >= c.activity.until) {
      if (c.activity.kind === 'build' && c.activity.place) buildStep(w, c, c.activity.place)
      if (c.activity.kind === 'work') { c.money += c.role === 'merchant' ? 4 : c.role === 'farmer' ? 2 : 3; if (c.role === 'farmer' && !drought && w.rng() < 0.5) c.food++; if (c.role === 'baker') c.food++ ; if (c.role === 'hunter' && w.rng() < 0.5) c.food++ }
      if (feast && h >= 12 && h < 23 && awake(c)) { c.activity = { kind: 'rest', label: 'celebrating', until: w.t + 30, place: 'square' }; c.drunk = clamp(c.drunk + (c.role === 'child' ? 0 : 0.1), 0, 1); mood(c, { joy: 0.05 }) }
      else decide(w, c)
    }
  }
  // interactions
  const list = alive(w).filter(c => awake(c) && c.path.length === 0 && (c.activity.kind === 'rest' || c.activity.kind === 'idle' || c.activity.kind === 'play' || c.activity.kind === 'work' || c.activity.kind === 'drink' || c.activity.kind === 'watch' || c.activity.kind === 'build'))
  for (const a of list) {
    const p = 0.02 + a.traits.sociability * 0.012 + a.needs.social * 0.02 + (feast ? 0.03 : 0)
    if (w.rng() > p) continue
    const near = list.filter(b => b !== a && dist(a.pos, b.pos) <= 2.3 && awake(b) && b.activity.kind !== 'talk' && b.activity.kind !== 'quarrel' && (a.goals.some(gl => gl.target === b.id) || (w.t - rel(a, b).lastContact > 75 && rel(a, b).fear < 0.45)))
    if (!near.length) continue
    // prefer people with unfinished business
    near.sort((x, y) => score(a, y) - score(a, x))
    const b = w.rng() < 0.6 ? near[0] : randomOf(w, near)
    interact(w, a, b)
  }
  // day change
  if (w.t % 1440 === 0) dayChange(w)
  if (w.t % 1440 === 6 * 60) log(w, `Dawn. ${timeFlavor(w)}`, 'world', 0.2, [])
  if (w.t % 1440 === 21 * 60) log(w, `The dome dims. Lights come on in the module windows.`, 'world', 0.15, [])
}

function score(a: Character, b: Character) {
  const r = rel(a, b)
  let s = Math.abs(r.liking) + (r.debt !== 0 ? 1 : 0) + (a.goals.some(gl => gl.target === b.id) ? 2 : 0) + (a.beliefs.some(bl => bl.about === b.id) ? 0.5 : 0)
  if (a.role === 'child' && b.role === 'child') s += 1
  return s
}

function timeFlavor(w: World) {
  const opts = ['The ventilation hums, the first carts roll toward the depot.', 'The dome is still misty with night condensation.', 'Quiet, only the workshop is already humming.', 'The canteen smells of fresh rations.']
  return randomOf(w, opts)
}

function die(w: World, c: Character, cause: string) {
  c.alive = false
  c.activity = { kind: 'idle', label: 'dead', until: Infinity, place: null }
  log(w, `${c.name.nom} died ${cause}. ${c.familyName ? 'The ' + c.familyName + ' family is in mourning.' : 'There is nobody to bury ' + g(c, 'him', 'her') + '.'}`, 'world', 1, [c.id])
  for (const o of alive(w)) {
    const r = rel(o, c)
    if (r.family) { remember(o, w, `${c.name.nom} died ${cause}`, 1, [c.id]); mood(o, { joy: -0.6, fear: 0.2 }) }
    else if (r.liking > 0.3) { remember(o, w, `${c.name.nom} died`, 0.8, [c.id]); mood(o, { joy: -0.3 }) }
  }
}

function dayChange(w: World) {
  const day = dayOf(w.t)
  const yesterday = day - 1
  for (const c of alive(w)) {
    c.diary.push({ day: yesterday, text: diaryFor(w, c, yesterday) })
    if (c.diary.length > 7) c.diary.shift()
    // trait drift from the day's memories
    const dayMem = c.memory.filter(m => dayOf(m.t) === yesterday)
    const cheated = dayMem.filter(m => m.culprit && m.culprit !== c.id).length
    const helped = dayMem.filter(m => /fed me|helped me out|shared a ration|lent /.test(m.text)).length
    c.traits.trust = clamp(c.traits.trust - cheated * 0.02 + helped * 0.02)
    c.traits.generosity = clamp(c.traits.generosity + helped * 0.015)
    if (c.mood.anger > 0.4) c.traits.temper = clamp(c.traits.temper + 0.02)
    if (c.mood.shame > 0.4) c.traits.courage = clamp(c.traits.courage - 0.015)
    c.age += 0
    // burned houses get rebuilt
  }
  // weddings
  for (const a of alive(w)) {
    const wg = a.goals.find(gl => gl.id === 'wedding')
    if (!wg) continue
    const b = w.chars.find(x => x.id === wg.target)
    if (!b || !b.alive || b.left) { a.goals = a.goals.filter(gl => gl !== wg); continue }
    if (w.rng() < 0.45) continue
    a.goals = a.goals.filter(gl => gl !== wg)
    holdWedding(w, a, b)
  }
  // saving for a house
  for (const a of alive(w)) {
    const sg = a.goals.find(gl => gl.id === 'savehouse')
    if (!sg) continue
    const partner = sg.target ? w.chars.find(x => x.id === sg.target && x.alive && !x.left) : undefined
    const owners = partner ? [a, partner] : [a]
    if (owners.reduce((s, o) => s + o.money, 0) < 20) continue
    const site = startConstruction(w, owners, partner ? 'wedding' : 'whisper', home(w, a)?.door ?? a.pos)
    if (site) log(w, `${a.name.nom} saved up for a frame and bought a plot under the dome`, 'life', 0.55, owners.map(o => o.id))
    else { for (const o of owners) o.goals = o.goals.filter(gl => gl.id !== 'savehouse'); log(w, `${a.name.nom} wanted to build, but no free space is left under the dome`, 'life', 0.5, [a.id]) }
  }
  // strangers settle down
  for (const a of alive(w)) {
    const st = a.goals.find(gl => gl.id === 'settle')
    if (!st || day - a.arrivedDay < 2) continue
    if (a.money < 12) { if (day - a.arrivedDay > 6 && w.rng() < 0.4) { a.goals = a.goals.filter(gl => gl !== st); a.goals.push({ id: 'leave', text: 'leave, since I never settled in', priority: 0.6, source: 'LLM' }); log(w, `${a.name.nom} never scraped together the credits for a place. Packing up`, 'life', 0.55, [a.id]) } continue }
    const site = startConstruction(w, [a], 'settle', { x: 24, y: 16 })
    if (site) log(w, `${a.name.nom} talked the administrator into a plot and is building a module. The neighbours are watching`, 'life', 0.6, [a.id])
    else { a.goals = a.goals.filter(gl => gl !== st); a.goals.push({ id: 'leave', text: 'leave, since there is no room', priority: 0.6, source: 'LLM' }); log(w, `${a.name.nom} wanted to settle, but was given no room. Will leave`, 'life', 0.55, [a.id]) }
  }
  // chronicle for yesterday
  const entries = w.log.filter(e => dayOf(e.t) === yesterday && e.weight >= 0.45).sort((a, b) => b.weight - a.weight).slice(0, 5)
  const title = entries[0] ? entries[0].text.split(/[.:—]/)[0] : 'A quiet day'
  w.chronicle.push({ day: yesterday, title, text: entries.map(e => /[.!?»]$/.test(e.text) ? e.text : e.text + '.').join(' ') || 'Nothing of note. They worked, ate, slept.' })
  log(w, `Midnight. Day ${day} begins.`, 'world', 0.3, [])
}

// ───────────────────────── player ─────────────────────────

export function canPlay(w: World, cardId: string) { return !w.cooldowns[cardId] }

export function playCard(w: World, cardId: string, targetId?: string): string {
  const card = DECK.find(c => c.id === cardId)!
  if (w.cooldowns[cardId]) return 'too soon'
  w.cooldowns[cardId] = w.t + card.cooldown
  const people = alive(w)
  const adults = people.filter(c => c.role !== 'child')
  switch (cardId) {
    case 'fire': {
      const houses = w.buildings.filter(b => b.type === 'house' && !b.burned)
      const house = randomOf(w, houses)
      house.burned = true
      const owners = people.filter(c => c.home === house.id)
      let helpers = 0
      for (const c of people) {
        if (!awake(c) && w.rng() < 0.4) continue
        const d = dist(c.pos, house.door)
        if (d > 16) continue
        const helps = c.traits.courage > -0.3 && c.traits.generosity > -0.6 && c.role !== 'child'
        if (helps) helpers++
        goTo(w, c, nearFree(w, { x: house.door.x + Math.floor(w.rng() * 3) - 1, y: house.door.y + 1 }), helps ? 'help' : 'watch', helps ? 'fighting the fire' : 'watching the fire', 40, house.id)
        remember(c, w, `the ${house.name.replace(/Module$/, 'module')} burned${helps ? ', I helped put it out' : ', I watched from the side'}`, helps ? 0.6 : 0.5, owners.map(o => o.id))
        mood(c, { fear: 0.2 })
      }
      for (const o of owners) { o.food = 0; o.money = Math.floor(o.money * 0.6); mood(o, { fear: 0.5, joy: -0.4 }); remember(o, w, `our module burned down. We survived, but everything we had is gone`, 1, owners.map(x => x.id)); for (const c of people) if (!owners.includes(c) && dist(c.pos, house.door) <= 16 && c.traits.courage > -0.3 && c.role !== 'child') adjust(o, c, { liking: 0.15, trust: 0.1 }) }
      w.events.push({ id: 'fire', name: 'Fire', icon: '🔥', until: w.t + 90 })
      if (owners.length) startConstruction(w, owners, 'rebuild', house.door)
      log(w, `The ${house.name.replace(/Module$/, 'module')} caught fire! ${helpers} people rushed to put it out. ${owners[0] ? owners[0].name.nom + ' stood and watched everything ' + g(owners[0], 'he', 'she') + ' owned go up in flames' : ''}`, 'player', 0.95, owners.map(o => o.id))
      return `The ${house.name.replace(/Module$/, 'module')} is burning`
    }
    case 'gold': {
      const lucky = randomOf(w, adults)
      lucky.money += 40
      mood(lucky, { joy: 0.5 })
      log(w, `${lucky.name.nom} found a container of credits at the airlock — forty credits!`, 'player', 0.75, [lucky.id])
      remember(lucky, w, `found a container of credits at the airlock`, 0.9, [lucky.id])
      for (const c of people) if (c !== lucky && w.rng() < 0.45) {
        remember(c, w, `${lucky.name.nom} found credits at the airlock`, 0.55, [lucky.id], lucky.id, 'told')
        if (c.traits.generosity < 0 || c.money < 8) { adjust(c, lucky, { liking: -0.1 }); if (w.rng() < 0.3) c.beliefs.push({ claim: `${lucky.name.nom} got rich dishonestly`, confidence: 0.4, about: lucky.id }) }
        else adjust(c, lucky, { liking: 0.05 })
      }
      return `${lucky.name.nom} got rich`
    }
    case 'stranger': {
      const used = new Set(w.chars.map(c => c.name.nom))
      const pool = [...MALE, ...FEMALE].filter(n => !used.has(n.nom))
      const name = randomOf(w, pool)
      const c = makeStranger(w, name)
      w.chars.push(c)
      log(w, `A stranger came into the colony through the airlock. ${g(c, 'He', 'She')} gave the name ${c.name.nom}. Where from — not a word`, 'player', 0.8, [c.id])
      for (const o of people) { rel(o, c).trust = -0.3; rel(o, c).liking = -0.1 + o.traits.trust * 0.2; if (w.rng() < 0.4) remember(o, w, `a stranger came into the colony — ${c.name.nom}`, 0.4, [c.id], undefined, 'told') }
      return `${c.name.nom} came into the colony`
    }
    case 'rumor': {
      const target = w.chars.find(c => c.id === targetId) ?? randomOf(w, adults)
      const tpl = randomOf(w, RUMOR_TEMPLATES)
      const text = tpl(target.name.nom, target.name.gen, target.name.acc, target.name.sex === 'm')
      const seeds = people.filter(c => c !== target && c.role !== 'child').sort(() => w.rng() - 0.5).slice(0, 3)
      for (const c of seeds) { remember(c, w, text, 0.6, [target.id], target.id, 'told', 1); adjust(c, target, { trust: -0.1 }) }
      log(w, `Someone started a rumor in the colony: «${text}». The first to hear it: ${seeds.map(s => s.name.nom).join(', ')}`, 'player', 0.7, [target.id, ...seeds.map(s => s.id)])
      return `The rumor is out`
    }
    case 'drought': {
      w.events.push({ id: 'drought', name: 'Hydroponics Failure', icon: '🥀', until: w.t + 1440 * 3 })
      w.foodPrice = 4
      w.timers.push({ at: w.t + 1440 * 3, action: 'foodPrice', value: 2 })
      log(w, `The hydroponics failed: half the beds are dead. Rations at the depot doubled in price`, 'player', 0.8, [])
      for (const c of adults) { mood(c, { fear: 0.15 }); if (c.role === 'farmer') remember(c, w, `hydroponics failure, the beds are lost`, 0.7, [c.id]) }
      return 'Failure for three days'
    }
    case 'feast': {
      w.events.push({ id: 'feast', name: 'Festival', icon: '🎉', until: w.t + 240 })
      const elder = people.find(c => c.role === 'elder')
      log(w, `${elder ? elder.name.nom + ' declared' : 'The administrator declared'} a festival — tables were set on the plaza and the bar opened`, 'player', 0.85, elder ? [elder.id] : [])
      for (const c of people) { if (!awake(c) && w.rng() < 0.5) continue; goTo(w, c, spot(w, 'square'), 'rest', 'celebrating', 60 + Math.floor(w.rng() * 120), 'square'); mood(c, { joy: 0.4 }); c.needs.hunger = Math.max(0, c.needs.hunger - 0.5); if (c.role !== 'child') c.drunk = clamp(c.drunk + 0.3, 0, 1); remember(c, w, `a festival on the plaza, tables, music`, 0.5, []) }
      return 'Festival on the plaza'
    }
    case 'plague': {
      const sickOnes = adults.filter(c => !c.sick).sort(() => w.rng() - 0.5).slice(0, 4)
      for (const c of sickOnes) { c.sick = true; mood(c, { fear: 0.3 }); remember(c, w, `came down with the infection`, 0.7, [c.id]) }
      log(w, `An infection is spreading through the colony. Down with it: ${sickOnes.map(s => s.name.nom).join(', ')}. The medic is in demand`, 'player', 0.85, sickOnes.map(s => s.id))
      for (const c of people) if (!sickOnes.includes(c)) { mood(c, { fear: 0.2 }); for (const s of sickOnes) if (w.rng() < 0.3) remember(c, w, `${s.name.nom} came down with the infection`, 0.4, [s.id], undefined, 'told') }
      w.events.push({ id: 'plague', name: 'Infection', icon: '🦠', until: w.t + 1440 * 2 })
      w.timers.push({ at: w.t + 1440 * 2, action: 'cure', ids: sickOnes.map(s => s.id) })
      return 'The infection has arrived'
    }
    case 'tax': {
      const elder = people.find(c => c.role === 'elder')
      let total = 0; const failed: Character[] = []
      for (const c of adults) { if (c === elder) continue; if (c.money >= 8) { c.money -= 8; total += 8; mood(c, { anger: 0.1 }) } else { failed.push(c); mood(c, { shame: 0.3, anger: 0.2 }); remember(c, w, `could not pay the levy, ${elder ? elder.name.nom + ' put me down as a debtor' : 'I was put down as a debtor'}`, 0.75, elder ? [elder.id] : []); if (elder) { adjust(c, elder, { liking: -0.2, fear: 0.1 }); rel(elder, c).debt += 8; rel(c, elder).debt -= 8 } } }
      if (elder) elder.money += total
      log(w, `${elder ? elder.name.nom : 'The administrator'} went round the modules and collected the levy: ${total} credits. Could not pay: ${failed.length ? failed.map(f => f.name.nom).join(', ') : 'everyone paid'}`, 'player', 0.7, [elder?.id ?? '', ...failed.map(f => f.id)].filter(Boolean))
      return `Collected ${total} credits`
    }
    case 'wolves': {
      w.events.push({ id: 'wolves', name: 'Storm', icon: '🌪️', until: w.t + 600 })
      log(w, `A dust storm rose outside. The dome hums, the airlocks are sealed, the children stay home`, 'player', 0.75, [])
      for (const c of people) { mood(c, { fear: 0.35 }); c.needs.safety = 1; if (awake(c) && w.rng() < 0.8) goTo(w, c, homeSpot(w, c), 'rest', 'sitting at home, listening', 120, 'home'); remember(c, w, `a storm raged in the night`, 0.4, []) }
      const hunter = people.find(c => c.role === 'hunter')
      if (hunter) { hunter.goals.push({ id: 'wolves', text: 'check the dome anchors', priority: 0.8, source: 'self' }); goTo(w, hunter, spot(w, 'forest'), 'work', 'checking the dome anchors', 180, 'forest') }
      return 'Storm beyond the dome'
    }
    case 'harvest': {
      w.foodPrice = 1
      w.stock.food += 30
      w.timers.push({ at: w.t + 1440 * 2, action: 'foodPrice', value: 2 })
      for (const c of adults) { if (c.role === 'farmer') { c.food += 4; c.money += 8 } else c.food += 1; mood(c, { joy: 0.2 }) }
      log(w, `The hydroponics yielded a harvest — the depot is full. Rations at one credit`, 'player', 0.7, [])
      return 'Harvest'
    }
    case 'letter': {
      const target = w.chars.find(c => c.id === targetId) ?? randomOf(w, adults)
      const kind = Math.floor(w.rng() * 3)
      let text = ''
      if (kind === 0) { text = `${target.name.nom} got a message from Earth: ${g(target, 'his', 'her')} brother died. Left no inheritance`; mood(target, { joy: -0.5, fear: 0.1 }); remember(target, w, `a message from Earth: my brother died`, 0.9, [target.id]) }
      else if (kind === 1) { text = `${target.name.nom} got a message: an offer of a well-paid post on the orbital station`; target.goals.push({ id: 'leave', text: 'leave the colony for orbit', priority: 0.55, source: 'LLM' }); remember(target, w, `a message: an offer from the orbital station`, 0.8, [target.id]) }
      else { text = `${target.name.nom} got a message: an aunt on Earth left an inheritance — 25 credits`; target.money += 25; mood(target, { joy: 0.4 }); remember(target, w, `received an inheritance from my aunt`, 0.8, [target.id]); for (const c of people) if (c !== target && w.rng() < 0.4) { remember(c, w, `${target.name.nom} received an inheritance`, 0.4, [target.id], undefined, 'told'); if (c.traits.generosity < -0.2) adjust(c, target, { liking: -0.1 }) } }
      log(w, text + '. The comms operator read it aloud at the fountain — now everyone knows', 'player', 0.7, [target.id])
      return 'Message delivered'
    }
  }
  return ''
}

/** Once a day at 06:00 the warehouse is counted: agronomists grow rations, mechanics turn out parts, prices follow the stock. */
export function runEconomy(w: World, drought: boolean) {
  const people = alive(w)
  const farmers = people.filter(c => c.role === 'farmer').length, mechanics = people.filter(c => c.role === 'smith' || c.role === 'carpenter').length
  const grown = drought ? Math.floor((8 + farmers * 5) * 0.3) : 8 + farmers * 5
  const made = 2 + mechanics * 2
  // the canteen feeds everyone a little, and the dome systems eat parts for upkeep
  const kitchen = Math.min(w.stock.food + grown, Math.ceil(people.length / 6))
  const upkeep = Math.min(w.stock.parts + made, Math.ceil(w.buildings.filter(b => !b.site && !b.burned).length / 5))
  w.stock.food += grown - kitchen
  w.stock.parts += made - upkeep
  const before = w.foodPrice
  if (!w.timers.some(tm => tm.action === 'foodPrice')) w.foodPrice = w.stock.food >= 60 ? 1 : w.stock.food >= 25 ? 2 : w.stock.food >= 10 ? 3 : 4
  w.partsPrice = w.stock.parts >= 40 ? 2 : w.stock.parts >= 15 ? 3 : 5
  const priceNote = w.foodPrice > before ? ` Rations went up to ${w.foodPrice}.` : w.foodPrice < before ? ` Rations went down to ${w.foodPrice}.` : ''
  if (w.stock.food < 10) log(w, `The depot is almost empty: ${w.stock.food} rations for ${people.length} people.${priceNote} People eye their neighbours`, 'trade', 0.7, [])
  else log(w, `Morning count: ${w.stock.food} rations and ${w.stock.parts} parts in the depot; grew ${grown}, made ${made}, the canteen and upkeep took ${kitchen} and ${upkeep}.${priceNote}`, 'trade', 0.25, [])
}

export function runTimers(w: World) {
  w.timers ??= []
  for (let i = w.timers.length - 1; i >= 0; i--) {
    const tm = w.timers[i]
    if (tm.at > w.t) continue
    if (tm.action === 'foodPrice') w.foodPrice = tm.value ?? 2
    if (tm.action === 'cure') for (const id of tm.ids ?? []) { const c = w.chars.find(x => x.id === id); if (c && c.sick && c.alive) c.sick = false }
    w.timers.splice(i, 1)
  }
}

function makeStranger(w: World, name: (typeof MALE)[number]): Character {
  const rng = w.rng
  const gauss = () => (rng() + rng() + rng()) / 1.5 - 1
  const id = `${w.domeId ?? ''}c${w.nextId++}`
  const exit = w.places.exit[0]
  const c: Character = {
    id, name, age: 22 + Math.floor(rng() * 30), role: 'stranger', home: 'none', family: 'none', familyName: '',
    traits: { trust: gauss(), generosity: gauss(), temper: gauss(), honesty: gauss(), sociability: gauss(), courage: gauss() + 0.3 },
    mood: { joy: 0.2, anger: 0.1, fear: 0.3, shame: 0 },
    needs: { hunger: 0.6, sleep: 0.5, money: 0.3, safety: 0.5, social: 0.5, esteem: 0.3 },
    money: 3 + Math.floor(rng() * 10), food: 0,
    pos: { x: exit.x, y: exit.y }, prev: { x: exit.x, y: exit.y }, path: [],
    activity: { kind: 'idle', label: 'looking around', until: 0, place: null },
    memory: [], longMemory: [{ t: w.t - 1440 * 30, text: 'what happened before the colony is better left untold', weight: 0.9, source: 'seen', about: [id] }], relations: {}, goals: [{ id: 'settle', text: 'settle here and have nobody ask about the past', priority: 0.8, source: 'LLM' }], beliefs: [], diary: [],
    alive: true, sick: false, drunk: 0, color: 0x3a5a7a, seed: rng(), arrivedDay: dayOf(w.t), intent: null, left: false, starving: 0,
  }
  for (const o of w.chars) rel(c, o).trust = -0.2
  goTo(w, c, spot(w, 'square'), 'rest', 'looking around the plaza', 40, 'square')
  return c
}

export function whisper(w: World, charId: string, whisperId: string, targetId?: string, boost = 0): { accepted: boolean; text: string } {
  const c = w.chars.find(x => x.id === charId)!
  const def = WHISPERS.find(x => x.id === whisperId)!
  const target = targetId ? w.chars.find(x => x.id === targetId) : undefined
  const text = target ? def.text.replace('{dat}', target.name.dat).replace('{ins}', target.name.ins).replace('{gen}', target.name.gen).replace('{acc}', target.name.acc) : def.text
  const t = c.traits
  const r = target ? rel(c, target) : null
  let p = 0.4
  switch (whisperId) {
    case 'revenge': p = 0.35 + t.temper * 0.3 + (r && r.liking < 0 ? 0.35 : -0.25) + t.courage * 0.1; break
    case 'reconcile': p = 0.4 + t.generosity * 0.3 + t.honesty * 0.15 - (r && r.liking < -0.6 ? 0.25 : 0); break
    case 'court': p = 0.3 + (r && r.liking > 0 ? 0.45 : 0) + t.sociability * 0.15 - (r?.family ? 1 : 0); break
    case 'steal': p = 0.15 + (0 - t.honesty) * 0.4 + (c.money < 10 ? 0.3 : 0) + (r && r.liking < 0 ? 0.15 : 0); break
    case 'report': p = 0.2 + t.honesty * 0.2 + (c.beliefs.some(b => b.about === targetId) ? 0.45 : 0) + t.courage * 0.15 - (r?.family ? 1 : 0); break
    case 'elder': p = 0.35 + t.courage * 0.25 + t.sociability * 0.2 - (c.role === 'child' ? 1 : 0); break
    case 'leave': p = 0.25 + (c.mood.joy < 0.3 ? 0.25 : 0) + (c.mood.anger > 0.4 ? 0.2 : 0) + (c.mood.shame > 0.3 ? 0.2 : 0) - (Object.values(c.relations).filter(x => x.family).length > 0 ? 0.15 : 0); break
    case 'rich': p = 0.4 + (0 - t.honesty) * 0.3 + (c.money < 15 ? 0.2 : 0); break
    case 'help': p = 0.35 + t.generosity * 0.5; break
    case 'found': p = 0.3 + t.sociability * 0.25 + t.courage * 0.2 + (c.mood.joy < 0.4 ? 0.2 : 0) - (c.role === 'child' || c.role === 'old' ? 1 : 0); break
    case 'house': p = 0.3 + (c.money >= 20 ? 0.35 : 0.05) + t.courage * 0.1 - (c.role === 'child' || c.role === 'old' ? 1 : 0) - (adultsIn(w, c.home).length <= 1 && c.home !== 'none' ? 0.5 : 0); break
  }
  const accepted = w.rng() < clamp(p + boost, 0.05, 0.95)
  c.activity = { kind: 'think', label: 'lost in thought', until: w.t + 6, place: c.activity.place }
  c.path = []; c.intent = null
  c.goals = c.goals.filter(gl => gl.id !== whisperId)
  if (whisperId === 'house') {
    if (!accepted) { log(w, `${c.name.nom} brushed off the thought of ${g(c, 'his', 'her')} own module: ${c.money < 20 ? 'no credits for it' : 'things are fine as they are'}`, 'player', 0.45, [c.id]); return { accepted, text } }
    if (c.money >= 20) {
      const site = startConstruction(w, [c], 'whisper', home(w, c)?.door ?? c.pos)
      if (site) log(w, `The whisper landed: ${c.name.nom} bought a plot and is starting on the frame`, 'player', 0.65, [c.id])
      else log(w, `${c.name.nom} warmed to the idea of ${g(c, 'his', 'her')} own module, but there is no free space under the dome`, 'player', 0.5, [c.id])
    } else {
      c.goals.push({ id: 'savehouse', text: 'save up for my own module', priority: 0.8, source: 'player' })
      log(w, `The whisper landed: ${c.name.nom} decided to save up for ${g(c, 'his', 'her')} own module`, 'player', 0.6, [c.id])
    }
    return { accepted, text }
  }
  if (accepted) {
    c.goals.push({ id: whisperId, text, priority: boost > 0 ? 0.95 : 0.85, source: 'player', target: targetId })
    log(w, `The whisper landed: ${c.name.nom} is turning it over — «${text}». And the thought took root`, 'player', 0.65, [c.id, targetId ?? ''].filter(Boolean))
  } else {
    c.goals.push({ id: whisperId, text, priority: 0.2, source: 'player', target: targetId })
    log(w, `${c.name.nom} brushed off the thought «${text}»: not ${g(c, 'his', 'her')} style`, 'player', 0.45, [c.id])
  }
  return { accepted, text }
}
