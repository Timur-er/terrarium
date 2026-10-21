import type { Vec, World, TileKind } from './types'

export const WALKABLE = new Set<TileKind>([0, 1, 4, 6, 7, 9])
const COST: Partial<Record<TileKind, number>> = { 0: 2.4, 1: 1, 4: 3, 6: 1, 7: 1, 9: 2 }

export function tileAt(w: World, x: number, y: number): TileKind {
  if (x < 0 || y < 0 || x >= w.w || y >= w.h) return 2
  return w.tiles[y * w.w + x]
}
export function walkable(w: World, x: number, y: number) {
  return WALKABLE.has(tileAt(w, x, y))
}

export function findPath(w: World, from: Vec, to: Vec, maxIter = 6000): Vec[] {
  const sx = Math.round(from.x), sy = Math.round(from.y)
  const tx = Math.round(to.x), ty = Math.round(to.y)
  if (!walkable(w, tx, ty)) return []
  if (sx === tx && sy === ty) return []
  const W = w.w
  const key = (x: number, y: number) => y * W + x
  const g = new Map<number, number>()
  const came = new Map<number, number>()
  const open: { k: number; f: number }[] = []
  const start = key(sx, sy), goal = key(tx, ty)
  g.set(start, 0)
  open.push({ k: start, f: 0 })
  const closed = new Set<number>()
  let iter = 0
  while (open.length && iter++ < maxIter) {
    let bi = 0
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i
    const cur = open[bi]
    open[bi] = open[open.length - 1]
    open.pop()
    if (cur.k === goal) {
      const out: Vec[] = []
      let k = goal
      while (k !== start) {
        out.push({ x: k % W, y: Math.floor(k / W) })
        k = came.get(k)!
      }
      return out.reverse()
    }
    if (closed.has(cur.k)) continue
    closed.add(cur.k)
    const cx = cur.k % W, cy = Math.floor(cur.k / W)
    const gc = g.get(cur.k)!
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy
      if (!walkable(w, nx, ny)) continue
      const nk = key(nx, ny)
      if (closed.has(nk)) continue
      const ng = gc + (COST[tileAt(w, nx, ny)] ?? 2)
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng)
        came.set(nk, cur.k)
        open.push({ k: nk, f: ng + Math.abs(nx - tx) + Math.abs(ny - ty) })
      }
    }
  }
  return []
}
