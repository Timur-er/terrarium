import * as THREE from 'three'

/** Procedural textures drawn on canvas: colour map, height → normal map, roughness map. */

export interface TexSet { map: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture }

function rng(seed: number) {
  let a = Math.floor(seed * 1e6) | 0
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  return { c, ctx: c.getContext('2d')! }
}

function hex(n: number) { return '#' + n.toString(16).padStart(6, '0') }
function shade(n: number, f: number) {
  const r = Math.min(255, Math.max(0, ((n >> 16) & 255) * f)), g = Math.min(255, Math.max(0, ((n >> 8) & 255) * f)), b = Math.min(255, Math.max(0, (n & 255) * f))
  return `rgb(${r | 0},${g | 0},${b | 0})`
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number, r: () => number, scale = 1) {
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const cell = Math.max(1, Math.floor(scale))
  for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
    const n = (r() - 0.5) * 2 * amount * 255
    for (let yy = 0; yy < cell && y + yy < h; yy++) for (let xx = 0; xx < cell && x + xx < w; xx++) {
      const i = ((y + yy) * w + x + xx) * 4
      d[i] += n; d[i + 1] += n; d[i + 2] += n
    }
  }
  ctx.putImageData(img, 0, 0)
}

/** Sobel normal map from a grayscale height canvas. */
export function normalFromHeight(hc: HTMLCanvasElement, strength = 2): HTMLCanvasElement {
  const w = hc.width, h = hc.height
  const src = hc.getContext('2d')!.getImageData(0, 0, w, h).data
  const { c, ctx } = canvas(w, h)
  const out = ctx.createImageData(w, h)
  const o = out.data
  const H = (x: number, y: number) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1))
    const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1))
    let nx = -dx * strength, ny = dy * strength, nz = 1
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l
    const i = (y * w + x) * 4
    o[i] = (nx * 0.5 + 0.5) * 255; o[i + 1] = (ny * 0.5 + 0.5) * 255; o[i + 2] = (nz * 0.5 + 0.5) * 255; o[i + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
  return c
}

function tex(c: HTMLCanvasElement, srgb = true, repeat = false): THREE.Texture {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = 4
  if (repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping }
  return t
}

// ───────────────────────── ground atlas ─────────────────────────

export const ATLAS_CELLS = 4
export const CELL = 128

export interface GroundAtlas extends TexSet { cells: number; emissive: THREE.Texture }

/** 4×4 atlas of 128px tiles. Index by kind (see cellFor). */
export function buildGroundAtlas(): GroundAtlas {
  const S = ATLAS_CELLS * CELL
  const col = canvas(S, S), hgt = canvas(S, S), rgh = canvas(S, S), emi = canvas(S, S)
  emi.ctx.fillStyle = '#000'; emi.ctx.fillRect(0, 0, S, S)
  const r = rng(0.4242)
  let emiCtx: CanvasRenderingContext2D = emi.ctx
  const cell = (i: number, draw: (ctx: CanvasRenderingContext2D, hctx: CanvasRenderingContext2D, rctx: CanvasRenderingContext2D) => void) => {
    const x = (i % ATLAS_CELLS) * CELL, y = Math.floor(i / ATLAS_CELLS) * CELL
    for (const { ctx } of [col, hgt, rgh, emi]) { ctx.save(); ctx.translate(x, y); ctx.beginPath(); ctx.rect(0, 0, CELL, CELL); ctx.clip() }
    emiCtx = emi.ctx
    draw(col.ctx, hgt.ctx, rgh.ctx)
    for (const { ctx } of [col, hgt, rgh, emi]) ctx.restore()
  }
  const fill = (ctx: CanvasRenderingContext2D, color: string) => { ctx.fillStyle = color; ctx.fillRect(0, 0, CELL, CELL) }
  const grassCell = (variant: number) => (ctx: CanvasRenderingContext2D, h: CanvasRenderingContext2D, rg: CanvasRenderingContext2D) => {
    // dark regolith with gravel; variant 2 carries a patch of faintly glowing moss
    fill(ctx, ['#3b3833', '#36332e', '#3e3a34'][variant]); fill(h, '#808080'); fill(rg, '#e8e8e8')
    noise(ctx, CELL, CELL, 0.06, r, 2)
    for (let i = 0; i < 90; i++) {
      const x = r() * CELL, y = r() * CELL, sz = 1 + r() * 2.5
      ctx.fillStyle = r() > 0.5 ? '#5a554d' : '#2a2824'; ctx.beginPath(); ctx.arc(x, y, sz, 0, Math.PI * 2); ctx.fill()
      h.fillStyle = r() > 0.5 ? '#a8a8a8' : '#606060'; h.beginPath(); h.arc(x, y, sz, 0, Math.PI * 2); h.fill()
    }
    if (variant === 1) for (let i = 0; i < 3; i++) { ctx.fillStyle = 'rgba(60,70,60,0.6)'; ctx.beginPath(); ctx.ellipse(r() * CELL, r() * CELL, 14 + r() * 16, 8 + r() * 10, r() * 3, 0, Math.PI * 2); ctx.fill() }
    if (variant === 2) {
      for (let i = 0; i < 4; i++) {
        const x = r() * CELL, y = r() * CELL, rx = 10 + r() * 18, ry = 6 + r() * 12, a = r() * 3
        ctx.fillStyle = 'rgba(70,150,120,0.75)'; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, a, 0, Math.PI * 2); ctx.fill()
        emiCtx.fillStyle = 'rgba(60,200,170,0.9)'; emiCtx.beginPath(); emiCtx.ellipse(x, y, rx * 0.8, ry * 0.8, a, 0, Math.PI * 2); emiCtx.fill()
        rg.fillStyle = '#b0b0b0'; rg.beginPath(); rg.ellipse(x, y, rx, ry, a, 0, Math.PI * 2); rg.fill()
      }
    }
  }
  const slabCell = (crack: boolean, line: boolean) => (ctx: CanvasRenderingContext2D, h: CanvasRenderingContext2D, rg: CanvasRenderingContext2D) => {
    fill(ctx, '#b4b9bf'); fill(h, '#9a9a9a'); fill(rg, '#d0d0d0')
    noise(ctx, CELL, CELL, 0.05, r, 2)
    // slabs 2×2 with seams
    ctx.strokeStyle = '#7e848b'; ctx.lineWidth = 3; h.strokeStyle = '#303030'; h.lineWidth = 3
    for (const p of [0, CELL / 2, CELL]) { ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, CELL); ctx.moveTo(0, p); ctx.lineTo(CELL, p); ctx.stroke(); h.beginPath(); h.moveTo(p, 0); h.lineTo(p, CELL); h.moveTo(0, p); h.lineTo(CELL, p); h.stroke() }
    // stains
    for (let i = 0; i < 3; i++) { ctx.fillStyle = `rgba(60,58,54,${0.08 + r() * 0.12})`; ctx.beginPath(); ctx.ellipse(r() * CELL, r() * CELL, 10 + r() * 24, 6 + r() * 14, r() * 3, 0, Math.PI * 2); ctx.fill() }
    if (crack) { ctx.strokeStyle = '#6a6f75'; ctx.lineWidth = 1.5; ctx.beginPath(); let x = 10, y = 90; ctx.moveTo(x, y); for (let i = 0; i < 8; i++) { x += 12 + r() * 6; y += (r() - 0.5) * 20; ctx.lineTo(x, y) } ctx.stroke(); h.strokeStyle = '#404040'; h.lineWidth = 1.5; h.stroke() }
    if (line) { ctx.fillStyle = '#e0b83a'; ctx.fillRect(0, 6, CELL, 5); rg.fillStyle = '#a0a0a0'; rg.fillRect(0, 6, CELL, 5) }
  }
  const plateCell = (variant: number) => (ctx: CanvasRenderingContext2D, h: CanvasRenderingContext2D, rg: CanvasRenderingContext2D) => {
    fill(ctx, '#8f969e'); fill(h, '#a0a0a0'); fill(rg, '#8c8c8c')
    noise(ctx, CELL, CELL, 0.04, r, 2)
    ctx.strokeStyle = '#5c636b'; ctx.lineWidth = 2; h.strokeStyle = '#282828'; h.lineWidth = 2
    for (const p of [0, CELL / 2, CELL]) { ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, CELL); ctx.moveTo(0, p); ctx.lineTo(CELL, p); ctx.stroke(); h.beginPath(); h.moveTo(p, 0); h.lineTo(p, CELL); h.moveTo(0, p); h.lineTo(CELL, p); h.stroke() }
    for (const px of [8, CELL / 2 - 8, CELL / 2 + 8, CELL - 8]) for (const py of [8, CELL / 2 - 8, CELL / 2 + 8, CELL - 8]) {
      ctx.fillStyle = '#6f767e'; ctx.beginPath(); ctx.arc(px, py, 2.2, 0, Math.PI * 2); ctx.fill()
      h.fillStyle = '#e0e0e0'; h.beginPath(); h.arc(px, py, 2.2, 0, Math.PI * 2); h.fill()
    }
    if (variant === 1) { // hazard corner
      ctx.save(); ctx.beginPath(); ctx.rect(0, CELL - 14, CELL, 14); ctx.clip()
      for (let i = -2; i < 12; i++) { ctx.fillStyle = i % 2 ? '#2b2b2b' : '#e0b83a'; ctx.beginPath(); ctx.moveTo(i * 14, CELL); ctx.lineTo(i * 14 + 14, CELL); ctx.lineTo(i * 14 + 28, CELL - 14); ctx.lineTo(i * 14 + 14, CELL - 14); ctx.fill() }
      ctx.restore()
    }
    if (variant === 2) { // manhole
      ctx.fillStyle = '#5c636b'; ctx.beginPath(); ctx.arc(CELL / 2, CELL / 2, 26, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = '#3f454c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(CELL / 2, CELL / 2, 20, 0, Math.PI * 2); ctx.stroke()
      for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.moveTo(CELL / 2 - 16, CELL / 2 - 12 + i * 5); ctx.lineTo(CELL / 2 + 16, CELL / 2 - 12 + i * 5); ctx.stroke() }
      h.fillStyle = '#404040'; h.beginPath(); h.arc(CELL / 2, CELL / 2, 26, 0, Math.PI * 2); h.fill()
      rg.fillStyle = '#606060'; rg.beginPath(); rg.arc(CELL / 2, CELL / 2, 26, 0, Math.PI * 2); rg.fill()
    }
    if (variant === 3) { // arrow marking
      ctx.fillStyle = 'rgba(224,184,58,0.85)'; ctx.beginPath(); ctx.moveTo(CELL / 2, 22); ctx.lineTo(CELL / 2 + 18, 52); ctx.lineTo(CELL / 2 + 6, 52); ctx.lineTo(CELL / 2 + 6, 100); ctx.lineTo(CELL / 2 - 6, 100); ctx.lineTo(CELL / 2 - 6, 52); ctx.lineTo(CELL / 2 - 18, 52); ctx.fill()
    }
  }
  const waterCell = (ctx: CanvasRenderingContext2D, h: CanvasRenderingContext2D, rg: CanvasRenderingContext2D) => {
    fill(ctx, '#2f7aa0'); fill(h, '#808080'); fill(rg, '#202020')
    for (let i = 0; i < 9; i++) { ctx.strokeStyle = `rgba(150,210,235,${0.25 + r() * 0.3})`; ctx.lineWidth = 1.5; ctx.beginPath(); const y = r() * CELL; ctx.moveTo(r() * 30, y); ctx.bezierCurveTo(40, y - 6, 80, y + 6, 100 + r() * 28, y); ctx.stroke(); h.strokeStyle = '#a0a0a0'; h.lineWidth = 2; h.stroke() }
  }
  const bedCell = (ctx: CanvasRenderingContext2D, h: CanvasRenderingContext2D, rg: CanvasRenderingContext2D) => {
    fill(ctx, '#2f3436'); fill(h, '#808080'); fill(rg, '#a0a0a0')
    ctx.strokeStyle = '#1e2224'; ctx.lineWidth = 2; h.strokeStyle = '#404040'; h.lineWidth = 2
    for (let i = 0; i <= CELL; i += CELL / 4) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, CELL); ctx.moveTo(0, i); ctx.lineTo(CELL, i); ctx.stroke(); h.beginPath(); h.moveTo(i, 0); h.lineTo(i, CELL); h.moveTo(0, i); h.lineTo(CELL, i); h.stroke() }
  }
  const grateCell = (ctx: CanvasRenderingContext2D, h: CanvasRenderingContext2D, rg: CanvasRenderingContext2D) => {
    fill(ctx, '#4a5058'); fill(h, '#404040'); fill(rg, '#707070')
    ctx.fillStyle = '#8c949c'; h.fillStyle = '#d0d0d0'
    for (let i = 0; i < CELL; i += 8) { ctx.fillRect(i, 0, 3, CELL); h.fillRect(i, 0, 3, CELL) }
    for (let i = 0; i < CELL; i += 32) { ctx.fillRect(0, i, CELL, 4); h.fillRect(0, i, CELL, 4) }
  }
  const ashCell = (ctx: CanvasRenderingContext2D, h: CanvasRenderingContext2D, rg: CanvasRenderingContext2D) => {
    fill(ctx, '#3a3532'); fill(h, '#707070'); fill(rg, '#e0e0e0')
    noise(ctx, CELL, CELL, 0.08, r, 3)
    for (let i = 0; i < 5; i++) { ctx.fillStyle = `rgba(255,${90 + r() * 60 | 0},20,${0.4 + r() * 0.4})`; ctx.fillRect(r() * CELL, r() * CELL, 2, 2) }
  }
  const darkCell = (ctx: CanvasRenderingContext2D, h: CanvasRenderingContext2D, rg: CanvasRenderingContext2D) => { fill(ctx, '#55605a'); fill(h, '#808080'); fill(rg, '#e0e0e0') }

  cell(0, grassCell(0)); cell(1, grassCell(1)); cell(2, grassCell(2))
  cell(3, slabCell(false, false)); cell(4, slabCell(true, false)); cell(5, slabCell(false, true))
  cell(6, plateCell(0)); cell(7, plateCell(1)); cell(8, plateCell(2)); cell(9, plateCell(3))
  cell(10, waterCell); cell(11, bedCell); cell(12, grateCell); cell(13, ashCell); cell(14, darkCell); cell(15, plateCell(0))

  const map = tex(col.c, true)
  const normal = tex(normalFromHeight(hgt.c, 1.6), false)
  const rough = tex(rgh.c, false)
  const emissive = tex(emi.c, true)
  for (const t of [map, normal, rough, emissive]) { t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true }
  return { map, normal, rough, emissive, cells: ATLAS_CELLS }
}

/** Atlas cell for a tile kind, with variation by hash. */
export function cellFor(kind: number, h: number): number {
  switch (kind) {
    case 0: case 3: return h < 0.55 ? 0 : h < 0.85 ? 1 : 2
    case 1: return h < 0.7 ? 3 : h < 0.92 ? 4 : 5
    case 7: return h < 0.72 ? 6 : h < 0.82 ? 7 : h < 0.9 ? 8 : 9
    case 2: return 10
    case 4: return 11
    case 6: return 12
    case 9: return 13
    case 5: case 8: return 14
    default: return 3
  }
}

// ───────────────────────── building walls & roofs ─────────────────────────

const wallCache = new Map<string, TexSet>()

export interface WallOpts { type: string; wUnits: number; hUnits: number; base: number; accent: number; seed: number; label?: string; hazard?: boolean }

export function wallTexture(o: WallOpts): TexSet {
  const key = `${o.type}|${o.wUnits.toFixed(1)}|${o.hUnits.toFixed(1)}|${o.base}|${o.accent}|${o.seed.toFixed(3)}`
  const cached = wallCache.get(key)
  if (cached) return cached
  const PX = 96
  const W = Math.min(768, Math.max(64, Math.round(o.wUnits * PX))), H = Math.min(384, Math.max(64, Math.round(o.hUnits * PX)))
  const col = canvas(W, H), hgt = canvas(W, H), rgh = canvas(W, H)
  const r = rng(o.seed + 0.17)
  const ctx = col.ctx, h = hgt.ctx, rg = rgh.ctx
  ctx.fillStyle = hex(o.base); ctx.fillRect(0, 0, W, H)
  h.fillStyle = '#909090'; h.fillRect(0, 0, W, H)
  rg.fillStyle = '#a8a8a8'; rg.fillRect(0, 0, W, H)
  noise(ctx, W, H, 0.035, r, 2)
  // panels: vertical seams every ~0.9 units, one horizontal seam
  const seamX = Math.max(1, Math.round(o.wUnits / 0.9))
  const stepX = W / seamX
  const seamY = H * 0.62
  ctx.strokeStyle = shade(o.base, 0.62); ctx.lineWidth = 2; h.strokeStyle = '#303030'; h.lineWidth = 2
  for (let i = 1; i < seamX; i++) { const x = Math.round(i * stepX); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); h.beginPath(); h.moveTo(x, 0); h.lineTo(x, H); h.stroke() }
  ctx.beginPath(); ctx.moveTo(0, seamY); ctx.lineTo(W, seamY); ctx.stroke(); h.beginPath(); h.moveTo(0, seamY); h.lineTo(W, seamY); h.stroke()
  // panel shade variation
  for (let i = 0; i < seamX; i++) for (const [y0, y1] of [[0, seamY], [seamY, H]]) {
    if (r() < 0.35) { ctx.fillStyle = `rgba(0,0,0,${0.03 + r() * 0.05})`; ctx.fillRect(i * stepX + 1, y0 + 1, stepX - 2, y1 - y0 - 2) }
  }
  // rivets along seams
  const rivet = (x: number, y: number) => { ctx.fillStyle = shade(o.base, 0.55); ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = shade(o.base, 1.15); ctx.beginPath(); ctx.arc(x - 0.5, y - 0.5, 0.9, 0, Math.PI * 2); ctx.fill(); h.fillStyle = '#e8e8e8'; h.beginPath(); h.arc(x, y, 1.8, 0, Math.PI * 2); h.fill(); rg.fillStyle = '#606060'; rg.beginPath(); rg.arc(x, y, 1.8, 0, Math.PI * 2); rg.fill() }
  for (let i = 0; i <= seamX; i++) { const x = Math.min(W - 5, Math.max(5, Math.round(i * stepX) + (i === 0 ? 5 : i === seamX ? -5 : 0))); for (const y of [6, seamY - 6, seamY + 6, H - 6]) rivet(x, y) }
  for (let x = 24; x < W - 12; x += 24) { rivet(x, 6); rivet(x, H - 6) }
  // vents on some panels
  for (let i = 0; i < seamX; i++) if (r() < 0.25) {
    const vx = i * stepX + stepX * 0.25, vy = H * 0.12, vw = stepX * 0.5, vh = H * 0.16
    ctx.fillStyle = shade(o.base, 0.5); ctx.fillRect(vx, vy, vw, vh)
    for (let k = 0; k < 4; k++) { ctx.fillStyle = shade(o.base, 0.8); ctx.fillRect(vx + 2, vy + 2 + k * (vh / 4), vw - 4, vh / 8) }
    h.fillStyle = '#404040'; h.fillRect(vx, vy, vw, vh)
  }
  // grime at the bottom
  const g = ctx.createLinearGradient(0, H * 0.7, 0, H)
  g.addColorStop(0, 'rgba(40,34,28,0)'); g.addColorStop(1, 'rgba(40,34,28,0.55)')
  ctx.fillStyle = g; ctx.fillRect(0, H * 0.7, W, H * 0.3)
  const gr = rg.createLinearGradient(0, H * 0.7, 0, H); gr.addColorStop(0, 'rgba(230,230,230,0)'); gr.addColorStop(1, 'rgba(230,230,230,0.8)')
  rg.fillStyle = gr; rg.fillRect(0, H * 0.7, W, H * 0.3)
  // streaks under rivets
  for (let x = 24; x < W - 12; x += 48) if (r() < 0.5) { const sg = ctx.createLinearGradient(0, 8, 0, 8 + H * 0.35); sg.addColorStop(0, 'rgba(40,34,28,0.35)'); sg.addColorStop(1, 'rgba(40,34,28,0)'); ctx.fillStyle = sg; ctx.fillRect(x - 1.5, 8, 3, H * 0.35) }
  // scratches
  for (let i = 0; i < 4; i++) { ctx.strokeStyle = `rgba(255,255,255,${0.12 + r() * 0.15})`; ctx.lineWidth = 1; ctx.beginPath(); const x = r() * W, y = r() * H; ctx.moveTo(x, y); ctx.lineTo(x + (r() - 0.5) * 40, y + (r() - 0.5) * 16); ctx.stroke(); rg.strokeStyle = '#404040'; rg.lineWidth = 1; rg.stroke() }
  // thin accent line under the stripe mesh
  ctx.fillStyle = hex(o.accent); ctx.globalAlpha = 0.35; ctx.fillRect(0, H * 0.86, W, 2); ctx.globalAlpha = 1
  // label
  if (o.label) { ctx.font = `bold ${Math.max(10, Math.round(H * 0.16))}px "IBM Plex Mono", monospace`; ctx.fillStyle = shade(o.base, 0.45); ctx.textBaseline = 'top'; ctx.fillText(o.label, 10, H * 0.05) }
  // hazard stripes at the base
  if (o.hazard) { ctx.save(); ctx.beginPath(); ctx.rect(0, H - 10, W, 10); ctx.clip(); for (let i = -2; i < W / 10 + 2; i++) { ctx.fillStyle = i % 2 ? '#2b2b2b' : '#e0b83a'; ctx.beginPath(); ctx.moveTo(i * 10, H); ctx.lineTo(i * 10 + 10, H); ctx.lineTo(i * 10 + 20, H - 10); ctx.lineTo(i * 10 + 10, H - 10); ctx.fill() } ctx.restore() }
  const set: TexSet = { map: tex(col.c, true), normal: tex(normalFromHeight(hgt.c, 1.8), false), rough: tex(rgh.c, false) }
  wallCache.set(key, set)
  return set
}

const roofCache = new Map<string, TexSet>()
export function roofTexture(wUnits: number, dUnits: number, base: number, seed: number): TexSet {
  const key = `${wUnits.toFixed(1)}|${dUnits.toFixed(1)}|${base}|${seed.toFixed(3)}`
  const cached = roofCache.get(key)
  if (cached) return cached
  const PX = 80
  const W = Math.min(512, Math.max(64, Math.round(wUnits * PX))), H = Math.min(512, Math.max(64, Math.round(dUnits * PX)))
  const col = canvas(W, H), hgt = canvas(W, H), rgh = canvas(W, H)
  const r = rng(seed + 0.91)
  const ctx = col.ctx, h = hgt.ctx, rg = rgh.ctx
  ctx.fillStyle = hex(base); ctx.fillRect(0, 0, W, H); h.fillStyle = '#909090'; h.fillRect(0, 0, W, H); rg.fillStyle = '#b0b0b0'; rg.fillRect(0, 0, W, H)
  noise(ctx, W, H, 0.04, r, 2)
  const nx = Math.max(1, Math.round(wUnits / 0.8)), ny = Math.max(1, Math.round(dUnits / 0.8))
  ctx.strokeStyle = shade(base, 0.6); ctx.lineWidth = 2; h.strokeStyle = '#303030'; h.lineWidth = 2
  for (let i = 1; i < nx; i++) { const x = i * W / nx; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); h.beginPath(); h.moveTo(x, 0); h.lineTo(x, H); h.stroke() }
  for (let i = 1; i < ny; i++) { const y = i * H / ny; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); h.beginPath(); h.moveTo(0, y); h.lineTo(W, y); h.stroke() }
  for (let i = 0; i < nx * ny; i++) if (r() < 0.3) { const x = (i % nx) * W / nx, y = Math.floor(i / nx) * H / ny; ctx.fillStyle = `rgba(0,0,0,${0.04 + r() * 0.06})`; ctx.fillRect(x + 1, y + 1, W / nx - 2, H / ny - 2) }
  // hatch / vent plate
  if (r() < 0.7) { const x = W * 0.12, y = H * 0.55, s = Math.min(W, H) * 0.22; ctx.fillStyle = shade(base, 0.75); ctx.fillRect(x, y, s, s); ctx.strokeStyle = shade(base, 0.5); ctx.strokeRect(x, y, s, s); h.fillStyle = '#c0c0c0'; h.fillRect(x, y, s, s) }
  // stains and dust
  for (let i = 0; i < 4; i++) { ctx.fillStyle = `rgba(60,55,50,${0.08 + r() * 0.15})`; ctx.beginPath(); ctx.ellipse(r() * W, r() * H, 6 + r() * 20, 4 + r() * 12, r() * 3, 0, Math.PI * 2); ctx.fill() }
  const set: TexSet = { map: tex(col.c, true), normal: tex(normalFromHeight(hgt.c, 1.6), false), rough: tex(rgh.c, false) }
  roofCache.set(key, set)
  return set
}


// ───────────────────────── window interiors ─────────────────────────

const windowCache = new Map<number, THREE.Texture>()
/** A lit window seen from outside: warm room light with a silhouette (curtain, shelves, screen, plant). */
export function windowTexture(kind: number): THREE.Texture {
  const cached = windowCache.get(kind)
  if (cached) return cached
  const W = 64, H = 48
  const { c, ctx } = canvas(W, H)
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, '#ffd89a'); g.addColorStop(1, '#ff9a3c')
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = 'rgba(40,20,10,0.85)'
  if (kind === 0) { // curtains
    ctx.fillRect(0, 0, 14, H); ctx.fillRect(W - 14, 0, 14, H)
    ctx.fillStyle = 'rgba(60,30,15,0.5)'; ctx.fillRect(14, 0, 4, H); ctx.fillRect(W - 18, 0, 4, H)
  } else if (kind === 1) { // shelves with things
    for (let y = 10; y < H; y += 12) { ctx.fillRect(6, y, W - 12, 3); for (let x = 8; x < W - 10; x += 9) ctx.fillRect(x, y - 7, 5, 7) }
  } else if (kind === 2) { // a screen glowing blue
    ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#5fc8ff'; ctx.fillRect(18, 12, 28, 18); ctx.fillStyle = '#bfe8ff'; ctx.fillRect(22, 16, 12, 3)
  } else if (kind === 3) { // plant on the sill
    ctx.beginPath(); ctx.arc(20, 22, 10, 0, Math.PI * 2); ctx.arc(30, 18, 8, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(18, 30, 14, 12)
  } else { // person silhouette
    ctx.beginPath(); ctx.arc(32, 16, 7, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(22, 24, 20, 24)
  }
  ctx.strokeStyle = 'rgba(30,20,10,0.9)'; ctx.lineWidth = 3; ctx.strokeRect(1.5, 1.5, W - 3, H - 3)
  ctx.fillStyle = 'rgba(30,20,10,0.7)'; ctx.fillRect(W / 2 - 1, 0, 2, H)
  const t = tex(c, true)
  windowCache.set(kind, t)
  return t
}


/** Tileable noise normal map for water ripples. */
export function rippleNormal(): THREE.Texture {
  const S = 128
  const { c, ctx } = canvas(S, S)
  const r = rng(0.777)
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, S, S)
  for (let i = 0; i < 260; i++) {
    const x = r() * S, y = r() * S, rad = 6 + r() * 14
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad)
    const v = 110 + r() * 70
    g.addColorStop(0, `rgba(${v},${v},${v},0.9)`); g.addColorStop(1, 'rgba(128,128,128,0)')
    ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2)
  }
  const t = tex(normalFromHeight(c, 1.2), false, true)
  return t
}


/** Stained-glass strip for the chapel: coloured shards with dark leading. */
export function stainedGlassTexture(): THREE.Texture {
  const W = 64, H = 256
  const { c, ctx } = canvas(W, H)
  const r = rng(0.313)
  const colors = ['#5fd8ff', '#ff6fd8', '#ffb347', '#7fe0a0', '#c7a3ff', '#ffffff']
  ctx.fillStyle = '#1a1f2a'; ctx.fillRect(0, 0, W, H)
  for (let y = 0; y < H; y += 24) for (let x = 0; x < W; x += 16) {
    ctx.fillStyle = colors[Math.floor(r() * colors.length)]
    ctx.beginPath(); ctx.moveTo(x + 2, y + 2); ctx.lineTo(x + 14, y + 4 + r() * 6); ctx.lineTo(x + 6 + r() * 6, y + 22); ctx.closePath(); ctx.fill()
    ctx.fillStyle = colors[Math.floor(r() * colors.length)]
    ctx.beginPath(); ctx.moveTo(x + 14, y + 4); ctx.lineTo(x + 15, y + 22); ctx.lineTo(x + 8, y + 22); ctx.closePath(); ctx.fill()
  }
  ctx.strokeStyle = '#0e1118'; ctx.lineWidth = 2
  for (let y = 0; y <= H; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() }
  for (let x = 0; x <= W; x += 16) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke() }
  return tex(c, true)
}

/** A shop / menu screen: dark panel with glowing lines. */
export function screenTexture(kind: number): THREE.Texture {
  const W = 96, H = 64
  const { c, ctx } = canvas(W, H)
  ctx.fillStyle = kind === 0 ? '#0a1a26' : kind === 1 ? '#1a0a1e' : '#0a1e14'; ctx.fillRect(0, 0, W, H)
  const col = kind === 0 ? '#5fd8ff' : kind === 1 ? '#ff6fd8' : '#7fe0a0'
  ctx.fillStyle = col
  for (let i = 0; i < 5; i++) ctx.fillRect(8, 8 + i * 11, 20 + ((i * 37) % 50), 4)
  ctx.globalAlpha = 0.5; ctx.fillRect(70, 10, 18, 40); ctx.globalAlpha = 1
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(2, 2, W - 4, H - 4)
  return tex(c, true)
}
