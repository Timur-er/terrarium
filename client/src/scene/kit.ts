/**
 * The Kenney Space Kit (CC0, kenney.nl) as glTF: buildings, rocks and the rover are assembled from these models.
 * Models are loaded once, measured, and cloned per building; the procedural builder stays as the fallback.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const BASE = '/assets/kenney/space/'
/** Kenney material names → our look. `metalRed` is the accent stripe and is recoloured per building. */
const PALETTE: Record<string, { color: number; roughness: number; metalness: number }> = {
  metal: { color: 0xb8b2a4, roughness: 0.62, metalness: 0.22 },
  metalDark: { color: 0x8a867d, roughness: 0.66, metalness: 0.28 },
  metalRed: { color: 0xffb84a, roughness: 0.5, metalness: 0.15 },
  dark: { color: 0x363a42, roughness: 0.55, metalness: 0.45 },
}
export const ACCENT_MATERIAL = 'metalRed'
const cache = new Map<string, { scene: THREE.Group; size: THREE.Vector3; min: THREE.Vector3 }>()
const loader = new GLTFLoader()

/** One piece of a building recipe: which model, where relative to the centre (tile units, before fit), how it sits. */
export interface Part {
  model: string
  /** offset in units of the main part's footprint: -0.5..0.5 across W and D */
  dx?: number
  dz?: number
  rot?: number
  /** scale relative to the main part's scale (default 1) */
  s?: number
  /** put on top of the previous part */
  stack?: boolean
  y?: number
}

export const RECIPES: Record<string, (seed: number) => Part[]> = {
  house: seed => [{ model: seed < 0.5 ? 'hangar_smallA' : 'hangar_smallB' }, ...(seed > 0.6 ? [{ model: 'satelliteDish', dx: 0.42, dz: -0.42, s: 0.55 }] : []), ...(seed < 0.3 ? [{ model: 'barrel', dx: -0.46, dz: 0.4, s: 0.5 }] : [])],
  market: () => [{ model: 'hangar_largeA' }, { model: 'barrels_rail', dx: 0.55, dz: 0.3, s: 0.7, rot: Math.PI / 2 }, { model: 'barrels', dx: -0.5, dz: 0.4, s: 0.6 }],
  bakery: () => [{ model: 'hangar_roundA' }, { model: 'chimney', dx: 0.35, dz: -0.35, s: 0.6 }],
  forge: () => [{ model: 'hangar_largeB' }, { model: 'machine_generator', dx: -0.55, dz: 0.35, s: 0.6 }, { model: 'machine_barrel', dx: 0.55, dz: 0.35, s: 0.55 }],
  church: () => [{ model: 'hangar_roundGlass' }],
  tavern: () => [{ model: 'hangar_roundB' }, { model: 'machine_wireless', dx: 0.45, dz: 0.45, s: 0.5 }, { model: 'desk_chairStool', dx: -0.5, dz: 0.5, s: 0.45 }, { model: 'desk_chairStool', dx: -0.35, dz: 0.55, s: 0.45 }],
  school: () => [{ model: 'hangar_smallA', rot: Math.PI / 2 }, { model: 'satelliteDish_large', dx: 0.5, dz: -0.4, s: 0.55 }],
  guard: () => [{ model: 'hangar_smallB' }, { model: 'turret_single', stack: true, s: 0.6 }, { model: 'satelliteDish', dx: 0.45, dz: 0.4, s: 0.45 }],
  mill: () => [{ model: 'rocket_baseA' }, { model: 'rocket_fuelA', stack: true }, { model: 'rocket_topA', stack: true }, { model: 'machine_generatorLarge', dx: 0.6, dz: 0.4, s: 0.55 }],
}

export const KIT_MODELS = Array.from(new Set([
  ...Object.values(RECIPES).flatMap(r => [...r(0.1), ...r(0.5), ...r(0.9)].map(p => p.model)),
  'rover', 'rock', 'rock_largeA', 'rock_largeB', 'rocks_smallA', 'rocks_smallB', 'meteor', 'meteor_half', 'rock_crystals', 'rock_crystalsLargeA', 'craterLarge', 'gate_simple',
]))

function load(name: string) {
  return new Promise<void>((resolve, reject) => {
    loader.load(BASE + name + '.glb', gltf => {
      const scene = gltf.scene
      scene.traverse(o => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.castShadow = true; m.receiveShadow = true
          const mats = Array.isArray(m.material) ? m.material : [m.material]
          for (const mat of mats) {
            const s = mat as THREE.MeshStandardMaterial
            if (!s.isMeshStandardMaterial) continue
            // Kenney's white plastic is retinted to the colony palette: warm grey hulls, dark steel, amber accents
            const tint = PALETTE[s.name]
            if (tint) { s.color.setHex(tint.color); s.roughness = tint.roughness; s.metalness = tint.metalness } else { s.roughness = 0.7; s.metalness = 0.1 }
            s.envMapIntensity = 0.6
          }
        }
      })
      const box = new THREE.Box3().setFromObject(scene)
      const size = new THREE.Vector3(); box.getSize(size)
      cache.set(name, { scene, size, min: box.min.clone() })
      resolve()
    }, undefined, err => reject(err))
  })
}

let loading: Promise<boolean> | null = null
/** Loads the whole set once; resolves true when every model came through. */
export function loadKit(): Promise<boolean> {
  if (!loading) loading = Promise.all(KIT_MODELS.map(n => load(n).catch(e => { console.warn('kit: failed to load', n, e); return null }))).then(rs => rs.every(r => r !== null))
  return loading
}
export const kitLoaded = () => cache.size > 0

/** A clone of a model with shared geometry and cloned materials so tints stay local. */
export function instance(name: string): THREE.Group | null {
  const m = cache.get(name)
  if (!m) return null
  const g = m.scene.clone(true)
  g.traverse(o => { const mesh = o as THREE.Mesh; if (mesh.isMesh) mesh.material = Array.isArray(mesh.material) ? mesh.material.map(x => x.clone()) : mesh.material.clone() })
  return g
}
export const measure = (name: string) => cache.get(name)

/**
 * Assemble a recipe inside `group` so that the main part covers a W×D footprint.
 * Returns the height of the tallest point, for labels, or null if models are missing.
 */
export function assemble(group: THREE.Group, parts: Part[], W: number, D: number): number | null {
  const main = measure(parts[0].model)
  if (!main) return null
  const rot0 = parts[0].rot ?? 0
  const mx = Math.abs(Math.cos(rot0)) > 0.5 ? main.size.x : main.size.z, mz = Math.abs(Math.cos(rot0)) > 0.5 ? main.size.z : main.size.x
  const s = Math.min((W - 0.25) / mx, (D - 0.25) / mz)
  let top = 0, prevTop = 0
  let ok = true
  for (const p of parts) {
    const m = measure(p.model), inst = instance(p.model)
    if (!m || !inst) { ok = false; continue }
    const ps = s * (p.s ?? 1)
    inst.scale.setScalar(ps)
    inst.rotation.y = p.rot ?? 0
    const y = p.stack ? prevTop : (p.y ?? 0)
    // models sit on their own base; lift by -min.y so the base is on the ground
    inst.position.set((p.dx ?? 0) * W, y - m.min.y * ps, (p.dz ?? 0) * D)
    group.add(inst)
    const h = y + m.size.y * ps
    prevTop = h
    top = Math.max(top, h)
  }
  return ok ? top : null
}
