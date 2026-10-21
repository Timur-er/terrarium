import type { Building, TileKind, Vec, World } from './types'

export const MAP_W = 52
export const MAP_H = 34

interface MapResult { tiles: TileKind[]; buildings: Building[]; places: Record<string, Vec[]> }

const B = (id: string, type: Building['type'], name: string, x: number, y: number, w: number, h: number, dx: number, dy: number, open?: [number, number]): Building =>
  ({ id, type, name, x, y, w, h, door: { x: dx, y: dy }, owners: [], open })

export function buildMap(rng: () => number): MapResult {
  const W = MAP_W, H = MAP_H
  const tiles: TileKind[] = new Array(W * H).fill(0)
  const at = (x: number, y: number) => tiles[y * W + x]
  const set = (x: number, y: number, k: TileKind) => { if (x >= 0 && y >= 0 && x < W && y < H) tiles[y * W + x] = k }

  const buildings: Building[] = [
    B('market', 'market', 'Depot', 30, 11, 5, 4, 29, 13, [8, 18]),
    B('bakery', 'bakery', 'Canteen', 17, 10, 4, 3, 19, 13, [6, 18]),
    B('forge', 'forge', 'Workshop', 11, 13, 4, 3, 15, 14, [7, 19]),
    B('church', 'church', 'Chapel', 22, 4, 5, 5, 24, 9, [6, 22]),
    B('tavern', 'tavern', 'Orbit Bar', 17, 21, 5, 4, 22, 22, [16, 2]),
    B('guard', 'guard', 'Security Post', 30, 20, 4, 3, 29, 21, [0, 24]),
    B('school', 'school', 'School', 8, 21, 4, 3, 12, 22, [9, 14]),
    B('mill', 'mill', 'Reactor', 39, 5, 3, 3, 40, 8, [7, 18]),
    B('h1', 'house', 'Module',5, 4, 3, 3, 6, 7),
    B('h2', 'house', 'Module',10, 4, 3, 2, 11, 6),
    B('h3', 'house', 'Module',15, 5, 3, 3, 16, 8),
    B('h4', 'house', 'Module',30, 4, 3, 3, 31, 7),
    B('h5', 'house', 'Module',34, 7, 3, 2, 35, 9),
    B('h6', 'house', 'Module',36, 13, 3, 3, 35, 14),
    B('h7', 'house', 'Module',36, 18, 3, 2, 35, 19),
    B('h8', 'house', 'Module',36, 23, 3, 3, 35, 24),
    B('h9', 'house', 'Module',30, 26, 3, 2, 31, 25),
    B('h10', 'house', 'Module',25, 27, 3, 3, 26, 26),
    B('h11', 'house', 'Module',19, 28, 3, 2, 20, 27),
    B('h12', 'house', 'Module',13, 27, 3, 3, 14, 26),
    B('h13', 'house', 'Module',5, 27, 3, 2, 6, 26),
    B('h14', 'house', 'Module',3, 9, 3, 2, 4, 11),
  ]

  // river
  const riverX: number[] = []
  for (let y = 0; y < H; y++) {
    const rx = 45 + Math.round(1.5 * Math.sin(y / 4.5))
    riverX.push(rx)
    set(rx, y, 2); set(rx + 1, y, 2)
    if (y % 3 === 0) set(rx + 2, y, 2)
  }
  // fields
  for (let y = 14; y <= 19; y++) for (let x = 3; x <= 10; x++) set(x, y, 4)
  for (let y = 28; y <= 32; y++) for (let x = 36; x <= 42; x++) set(x, y, 4)
  // square
  for (let y = 13; y <= 19; y++) for (let x = 21; x <= 27; x++) set(x, y, 7)
  set(24, 16, 8)
  // buildings
  for (const b of buildings) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) set(x, y, 5)

  const canPath = (x: number, y: number) => { const k = at(x, y); return k === 0 || k === 4 }
  const carve = (from: Vec, to: Vec) => {
    let { x, y } = from
    const horizFirst = Math.abs(to.x - x) >= Math.abs(to.y - y)
    const stepX = () => { while (x !== to.x) { x += Math.sign(to.x - x); if (canPath(x, y)) set(x, y, 1) } }
    const stepY = () => { while (y !== to.y) { y += Math.sign(to.y - y); if (canPath(x, y)) set(x, y, 1) } }
    if (canPath(x, y)) set(x, y, 1)
    if (horizFirst) { stepX(); stepY() } else { stepY(); stepX() }
  }
  const nearestSquare = (p: Vec): Vec => ({ x: Math.min(27, Math.max(21, p.x)), y: Math.min(19, Math.max(13, p.y)) })
  for (const b of buildings) {
    set(b.door.x, b.door.y, 1)
    carve(b.door, nearestSquare(b.door))
  }
  // bridge + east road
  const brx = riverX[16]
  for (let y = 15; y <= 16; y++) for (let x = brx - 1; x <= brx + 3; x++) set(x, y, 6)
  carve({ x: 27, y: 16 }, { x: brx - 2, y: 16 })
  carve({ x: brx + 4, y: 16 }, { x: W - 1, y: 16 })
  // south road & north road
  carve({ x: 24, y: 19 }, { x: 24, y: H - 1 })
  carve({ x: 24, y: 9 }, { x: 24, y: 0 })
  // link h14 & fields
  carve({ x: 4, y: 11 }, { x: 4, y: 13 })

  // trees
  const nearPath = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = at(x + dx, y + dy)
      if (k === 1 || k === 5 || k === 7 || k === 6 || k === 8) return true
    }
    return false
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (at(x, y) !== 0 || nearPath(x, y)) continue
    let p = 0.07
    if (x < 2 || y < 2 || y > H - 3) p = 0.8
    if (x < 9 && y < 4) p = 0.85
    if (x > riverX[y] + 3) p = 0.6
    if (x < 3 && y > 20) p = 0.7
    if (rng() < p) set(x, y, 3)
  }
  // keep roads at edges clear
  for (let y = 0; y < H; y++) if (at(24, y) === 3) set(24, y, 0)

  const places: Record<string, Vec[]> = {}
  places.square = []
  for (let y = 13; y <= 19; y++) for (let x = 21; x <= 27; x++) if (at(x, y) === 7) places.square.push({ x, y })
  places.fields = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (at(x, y) === 4) places.fields.push({ x, y })
  places.forest = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (at(x, y) !== 0) continue
    let n = 0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (at(x + dx, y + dy) === 3) n++
    if (n >= 2) places.forest.push({ x, y })
  }
  places.bridge = []
  for (let y = 15; y <= 16; y++) for (let x = brx - 1; x <= brx + 3; x++) places.bridge.push({ x, y })
  places.exit = [{ x: W - 1, y: 16 }]
  places.road = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (at(x, y) === 1) places.road.push({ x, y })
  for (const b of buildings) places[b.id] = [b.door]

  return { tiles, buildings, places }
}


// ───────────────────────── dynamic map ─────────────────────────

export const CHUNK = 8
export const SQUARE = { x0: 21, y0: 13, x1: 27, y1: 19 }

export function chunkIndex(x: number, y: number) {
  return Math.floor(y / CHUNK) * Math.ceil(MAP_W / CHUNK) + Math.floor(x / CHUNK)
}
export function markDirty(w: World, x: number, y: number) {
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const xx = x + dx, yy = y + dy
    if (xx < 0 || yy < 0 || xx >= w.w || yy >= w.h) continue
    const i = chunkIndex(xx, yy)
    if (!w.dirty.includes(i)) w.dirty.push(i)
  }
}
function setTile(w: World, x: number, y: number, k: TileKind) {
  if (x < 0 || y < 0 || x >= w.w || y >= w.h) return
  w.tiles[y * w.w + x] = k
  markDirty(w, x, y)
}
const tile = (w: World, x: number, y: number): TileKind => (x < 0 || y < 0 || x >= w.w || y >= w.h ? 2 : w.tiles[y * w.w + x])
const isRoad = (k: TileKind) => k === 1 || k === 7 || k === 6

/** Nearest road tile reachable over land (BFS, ignores buildings and water). */
export function nearestRoad(w: World, from: Vec, maxDist = 12): { p: Vec; d: number } | null {
  const seen = new Set<number>([from.y * w.w + from.x])
  let frontier: Vec[] = [{ x: from.x, y: from.y }]
  for (let d = 0; d <= maxDist; d++) {
    const next: Vec[] = []
    for (const p of frontier) {
      const k = tile(w, p.x, p.y)
      if (isRoad(k)) return { p, d }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = p.x + dx, y = p.y + dy
        const key = y * w.w + x
        if (seen.has(key)) continue
        const kk = tile(w, x, y)
        if (kk === 2 || kk === 5 || kk === 8) continue
        seen.add(key); next.push({ x, y })
      }
    }
    frontier = next
  }
  return null
}

/** Carve an L-shaped path, replacing grass, field and trees. */
export function carvePath(w: World, from: Vec, to: Vec) {
  const ok = (x: number, y: number) => { const k = tile(w, x, y); return k === 0 || k === 4 || k === 3 }
  let { x, y } = from
  const horizFirst = Math.abs(to.x - x) >= Math.abs(to.y - y)
  const stepX = () => { while (x !== to.x) { x += Math.sign(to.x - x); if (ok(x, y)) setTile(w, x, y, 1) } }
  const stepY = () => { while (y !== to.y) { y += Math.sign(to.y - y); if (ok(x, y)) setTile(w, x, y, 1) } }
  if (ok(x, y)) setTile(w, x, y, 1)
  if (horizFirst) { stepX(); stepY() } else { stepY(); stepX() }
}

export interface Plot { x: number; y: number; w: number; h: number; door: Vec }

/** Find a free 3×3 plot near a point: grass or trees only, one tile clear of other buildings, near a road. */
export function findPlot(w: World, near: Vec, rng: () => number, size = 3, maxRadius = 22): Plot | null {
  const cands: { plot: Plot; score: number }[] = []
  for (let y = 2; y < w.h - size - 2; y++) for (let x = 2; x < w.w - size - 2; x++) {
    const dist = Math.hypot(x + 1 - near.x, y + 1 - near.y)
    if (dist > maxRadius) continue
    // square exclusion zone
    if (x + size > SQUARE.x0 - 2 && x < SQUARE.x1 + 3 && y + size > SQUARE.y0 - 2 && y < SQUARE.y1 + 3) continue
    let ok = true
    for (let yy = y - 1; yy <= y + size && ok; yy++) for (let xx = x - 1; xx <= x + size && ok; xx++) {
      const k = tile(w, xx, yy)
      const inner = xx >= x && xx < x + size && yy >= y && yy < y + size
      if (inner) { if (k !== 0 && k !== 3) ok = false }
      else if (k === 5 || k === 2 || k === 8 || k === 6) ok = false
    }
    if (!ok) continue
    const center = { x: x + 1, y: y + 1 }
    const road = nearestRoad(w, center, 9)
    if (!road) continue
    // door side facing the road
    const dx = road.p.x - center.x, dy = road.p.y - center.y
    let door: Vec
    if (Math.abs(dy) >= Math.abs(dx)) door = dy > 0 ? { x: x + 1, y: y + size } : { x: x + 1, y: y - 1 }
    else door = dx > 0 ? { x: x + size, y: y + 1 } : { x: x - 1, y: y + 1 }
    const dk = tile(w, door.x, door.y)
    if (dk === 2 || dk === 5 || dk === 8) continue
    cands.push({ plot: { x, y, w: size, h: size, door }, score: dist + road.d * 1.5 + rng() * 3 })
  }
  if (!cands.length) return null
  cands.sort((a, b) => a.score - b.score)
  return cands[0].plot
}

/** Put a building on the map: footprint tiles, door tile, path to the nearest road. */
export function placeBuilding(w: World, b: Building) {
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) setTile(w, x, y, 5)
  setTile(w, b.door.x, b.door.y, 1)
  const road = nearestRoad(w, b.door, 14)
  if (road && road.d > 0) carvePath(w, b.door, road.p)
  w.places[b.id] = [b.door]
  if (!w.buildings.includes(b)) w.buildings.push(b)
  w.mapVersion++
}

export function removeBuilding(w: World, b: Building) {
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) setTile(w, x, y, 9)
  w.buildings = w.buildings.filter(x => x !== b)
  delete w.places[b.id]
  w.mapVersion++
}
