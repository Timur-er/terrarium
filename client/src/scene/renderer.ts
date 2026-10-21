import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { World, Character, Building, Vec } from '../sim/types'
import type { RegionView } from '../sim/region'
import { statusEmoji, hourOf, roleLabel } from '../sim/text'
import { buildGroundAtlas, cellFor, wallTexture, roofTexture, windowTexture, rippleNormal, stainedGlassTexture, screenTexture, type GroundAtlas } from './textures'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { loadKit, instance as kitInstance, measure as kitMeasure, assemble as kitAssemble, RECIPES, ACCENT_MATERIAL } from './kit'
import { makeMosaicUniforms, applyMosaic, makePixels, type MosaicUniforms } from './mosaic'

export interface RendererCallbacks {
  onSelect: (id: string | null) => void
  onHover: (id: string | null, x: number, y: number) => void
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
function hash(x: number, y: number) { let h = x * 374761393 + y * 668265263; h = (h ^ (h >> 13)) * 1274126177; return ((h ^ (h >> 16)) >>> 0) / 4294967295 }

// ───────────────────────── geometry helpers ─────────────────────────

/** Gable roof: ridge along X, eaves at y=0, width w (x), depth d (z), height h. */
function gableGeometry(w: number, d: number, h: number): THREE.BufferGeometry {
  const hw = w / 2, hd = d / 2
  const v: number[] = []
  const tri = (a: number[], b: number[], c: number[]) => v.push(...a, ...b, ...c)
  const A = [-hw, 0, -hd], B = [hw, 0, -hd], C = [hw, 0, hd], D = [-hw, 0, hd]
  const R1 = [-hw, h, 0], R2 = [hw, h, 0]
  // back slope (z-)
  tri(A, R1, R2); tri(A, R2, B)
  // front slope (z+)
  tri(D, C, R2); tri(D, R2, R1)
  // ends
  tri(A, D, R1)
  tri(B, R2, C)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
  g.computeVertexNormals()
  return g
}

const textCache = new Map<string, THREE.Texture>()
function textTexture(text: string, opts: { font: string; size: number; color: string; stroke?: string; pad?: number }): { tex: THREE.Texture; aspect: number } {
  const key = text + '|' + opts.font + opts.size + opts.color
  const cached = textCache.get(key)
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')!
  ctx.font = `${opts.size}px ${opts.font}`
  const m = ctx.measureText(text)
  const pad = opts.pad ?? 8
  const w = Math.ceil(m.width + pad * 2), h = Math.ceil(opts.size * 1.4 + pad)
  if (cached) return { tex: cached, aspect: w / h }
  c.width = w; c.height = h
  ctx.font = `${opts.size}px ${opts.font}`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  if (opts.stroke) { ctx.lineWidth = 5; ctx.strokeStyle = opts.stroke; ctx.lineJoin = 'round'; ctx.strokeText(text, w / 2, h / 2) }
  ctx.fillStyle = opts.color
  ctx.fillText(text, w / 2, h / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  textCache.set(key, tex)
  return { tex, aspect: w / h }
}

function makeSprite(text: string, opts: Parameters<typeof textTexture>[1], height: number): THREE.Sprite {
  const { tex, aspect } = textTexture(text, opts)
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  const s = new THREE.Sprite(mat)
  s.scale.set(height * aspect, height, 1)
  s.renderOrder = 10
  s.layers.set(1)
  return s
}

// ───────────────────────── post shaders ─────────────────────────

const TiltShiftShader = {
  uniforms: { tDiffuse: { value: null }, resolution: { value: new THREE.Vector2(1, 1) }, focus: { value: 0.5 }, range: { value: 0.18 }, strength: { value: 2.2 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 resolution; uniform float focus; uniform float range; uniform float strength;
    varying vec2 vUv;
    void main(){
      float d = abs(vUv.y - focus);
      float blur = smoothstep(range, range + 0.4, d) * strength;
      vec2 px = blur / resolution;
      vec4 c = texture2D(tDiffuse, vUv) * 0.2;
      c += texture2D(tDiffuse, vUv + vec2( px.x, 0.0)) * 0.075;
      c += texture2D(tDiffuse, vUv + vec2(-px.x, 0.0)) * 0.075;
      c += texture2D(tDiffuse, vUv + vec2(0.0,  px.y)) * 0.075;
      c += texture2D(tDiffuse, vUv + vec2(0.0, -px.y)) * 0.075;
      c += texture2D(tDiffuse, vUv + vec2( px.x,  px.y) * 0.7) * 0.075;
      c += texture2D(tDiffuse, vUv + vec2(-px.x,  px.y) * 0.7) * 0.075;
      c += texture2D(tDiffuse, vUv + vec2( px.x, -px.y) * 0.7) * 0.075;
      c += texture2D(tDiffuse, vUv + vec2(-px.x, -px.y) * 0.7) * 0.075;
      c += texture2D(tDiffuse, vUv + vec2( px.x * 2.0, 0.0)) * 0.05;
      c += texture2D(tDiffuse, vUv + vec2(-px.x * 2.0, 0.0)) * 0.05;
      c += texture2D(tDiffuse, vUv + vec2(0.0,  px.y * 2.0)) * 0.05;
      c += texture2D(tDiffuse, vUv + vec2(0.0, -px.y * 2.0)) * 0.05;
      gl_FragColor = c;
    }`,
}

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, resolution: { value: new THREE.Vector2(1, 1) }, night: { value: 0 }, time: { value: 0 }, grain: { value: 0.05 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 resolution; uniform float night; uniform float time; uniform float grain;
    varying vec2 vUv;
    float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 q = vUv - 0.5;
      float ca = 0.0016 + night * 0.0012;
      float r = texture2D(tDiffuse, vUv + q * ca).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - q * ca).b;
      vec3 c = vec3(r, g, b);
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      // lift shadows toward cold teal, warm the highlights
      vec3 shadowTint = mix(vec3(0.06, 0.10, 0.16), vec3(0.05, 0.09, 0.18), night);
      c += shadowTint * (1.0 - smoothstep(0.0, 0.5, l)) * (0.3 - night * 0.2);
      vec3 highTint = vec3(1.0, 0.93, 0.80);
      c *= mix(vec3(1.0), highTint, smoothstep(0.45, 1.0, l) * 0.35);
      c = mix(vec3(l), c, 1.10);
      c = (c - 0.5) * (1.08 + night * 0.06) + 0.5;
      float v = 1.0 - dot(q, q) * 1.1;
      c *= mix(1.0, v, 0.55);
      c += (rand(vUv * resolution + mod(time, 100.0)) - 0.5) * grain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
}

// ───────────────────────── palette ─────────────────────────

const ACCENT = [0x5cc8ff, 0xffb347, 0xff6b9a, 0x7fe0a0, 0xc7a3ff]
const ROOF: Record<string, number> = { house: 0x6f7780, market: 0xff8c3a, tavern: 0x5a6270, forge: 0x4a4f57, church: 0x8f98a4, guard: 0x5a5e6e, school: 0x7a8290, mill: 0x6a727c, bakery: 0x6f7780 }
const WALL: Record<string, number> = { house: 0xd6dbe0, market: 0xb9bfc6, tavern: 0x9aa3b2, forge: 0x7d8590, church: 0xe8ecef, guard: 0x8b939e, school: 0xc9cfd6, mill: 0xa4adb8, bakery: 0xd2d7dc }
const WALL_H: Record<string, number> = { house: 1.0, market: 0.9, tavern: 1.3, forge: 1.15, church: 1.8, guard: 1.3, school: 1.2, mill: 1.7, bakery: 1.05 }
const PUBLIC_LABEL_Y: Record<string, number> = { mill: 4.3, church: 5.6, tavern: 2.9, market: 3.2, forge: 2.7, bakery: 2.6, school: 2.5, guard: 3.6 }
const TYPE_ACCENT: Record<string, number> = { market: 0xff8c3a, tavern: 0xff4fd8, forge: 0xff7a1a, church: 0xdff3ff, guard: 0xff3b3b, school: 0x7fe0a0, mill: 0x58c4ff, bakery: 0xffd166 }

interface CharView {
  id: string
  group: THREE.Group
  body: THREE.Mesh
  head: THREE.Mesh
  hair: THREE.Mesh
  torso: THREE.Group
  legL: THREE.Group
  legR: THREE.Group
  armL: THREE.Group
  armR: THREE.Group
  s: number
  mats: THREE.MeshStandardMaterial[]
  emoji: THREE.Sprite | null
  emojiText: string
  label: THREE.Sprite
  hit: THREE.Mesh
}
interface BuildView { id: string; group: THREE.Group; windows: THREE.MeshStandardMaterial[]; lights: THREE.PointLight[]; label: THREE.Sprite | null; key: string }

export class Renderer {
  world: World
  host: HTMLElement
  cb: RendererCallbacks
  getTiming: () => { lastTickAt: number; tickMs: number }
  renderer!: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera!: THREE.PerspectiveCamera
  composer!: EffectComposer
  bloom!: UnrealBloomPass
  gtao!: GTAOPass
  aoCamera!: THREE.PerspectiveCamera
  tilt!: ShaderPass
  grade!: ShaderPass
  motes!: THREE.Points
  motesBase!: Float32Array
  canvas!: HTMLCanvasElement
  target = new THREE.Vector3()
  azimuth = Math.PI / 4
  elevation = 0.66
  fov = 30
  zoomPx = 18
  fitZoomPx = 18
  domeFade = 1
  camTarget: Vec | null = null
  selected: string | null = null
  hovered: string | null = null
  destroyed = false
  ground!: THREE.Mesh
  atlas: GroundAtlas | null = null
  cables = new THREE.Group()
  props = new THREE.Group()
  drones: { group: THREE.Group; rotors: THREE.Mesh[]; lamp: THREE.MeshStandardMaterial; phase: number; rx: number; rz: number; speed: number; h: number }[] = []
  metal = new THREE.MeshStandardMaterial({ color: 0x8b939e, metalness: 0.65, roughness: 0.38 })
  metalDark = new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.6, roughness: 0.5 })
  rubber = new THREE.MeshStandardMaterial({ color: 0x1c1f24, metalness: 0.2, roughness: 0.9 })
  trees: THREE.Object3D[] = []
  uTime = { value: 0 }
  glowMats: THREE.MeshStandardMaterial[] = []
  water: THREE.Mesh | null = null
  fieldsGroup = new THREE.Group()
  views = new Map<string, CharView>()
  builds = new Map<string, BuildView>()
  mapVersion = -1
  sun!: THREE.DirectionalLight
  moon!: THREE.DirectionalLight
  hemi!: THREE.HemisphereLight
  ambient!: THREE.AmbientLight
  lamps: { light: THREE.PointLight; bulb: THREE.MeshStandardMaterial }[] = []
  dome!: THREE.Mesh
  domeFrame!: THREE.LineSegments
  ring!: THREE.Mesh
  ringMat!: THREE.MeshBasicMaterial
  link!: THREE.Line
  fire = new THREE.Group()
  fireLight!: THREE.PointLight
  // the rest of the region: neighbouring domes on the horizon, roads, rovers on the roads
  /** the glTF kit (Kenney Space Kit) once loaded; procedural builders stay as the fallback */
  kitReady = false
  useKit = true
  /** the «mosaic» look: tiles, bleached colour, dissolve at the rim, pixels in space */
  mosaicU: MosaicUniforms | null = null
  mosaicOn = (() => { try { return localStorage.getItem('mosaic') === '1' } catch { return false } })()
  pixels: { points: THREE.Points; base: Float32Array; dir: Float32Array } | null = null
  mosaicFrame = 0
  kitRocks = new THREE.Group()
  rocks: THREE.InstancedMesh | null = null
  regionGroup = new THREE.Group()
  regionKey = ''
  regionView: RegionView | null = null
  roads = new Map<string, { a: THREE.Vector3; b: THREE.Vector3 }>()
  rovers: THREE.Group[] = []
  roverPool = new THREE.Group()
  raycaster = new THREE.Raycaster()
  pointer = new THREE.Vector2()
  dragging = false
  dragMoved = false
  dragButton = 0
  dragStart = { x: 0, y: 0 }
  dragGround = new THREE.Vector3()
  azStart = 0
  raf = 0
  resizeObs!: ResizeObserver
  hitMeshes: THREE.Mesh[] = []
  clock = 0
  lastHover = 0

  constructor(host: HTMLElement, world: World, cb: RendererCallbacks, getTiming: () => { lastTickAt: number; tickMs: number }) {
    this.host = host; this.world = world; this.cb = cb; this.getTiming = getTiming
  }

  async init() {
    if (this.destroyed) return
    const w = this.world
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    r.setPixelRatio(Math.min(1.25, window.devicePixelRatio || 1))
    r.setSize(this.host.clientWidth, this.host.clientHeight)
    r.shadowMap.enabled = true
    r.shadowMap.type = THREE.PCFSoftShadowMap
    r.localClippingEnabled = true
    r.toneMapping = THREE.ACESFilmicToneMapping
    r.toneMappingExposure = 1.2
    this.renderer = r
    this.canvas = r.domElement
    this.canvas.style.display = 'block'
    this.host.appendChild(this.canvas)

    this.scene.background = new THREE.Color(0x06080d)
    this.scene.fog = new THREE.FogExp2(0x0a1018, 0.0045)
    const pmrem = new THREE.PMREMGenerator(r)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.28
    this.target.set(w.w / 2, 0, w.h / 2)
    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 1, 700)
    this.camera.layers.enable(1)
    this.aoCamera = this.camera.clone()
    this.aoCamera.layers.set(0)
    this.fitView()

    this.buildLights()
    this.buildOutside()
    this.buildGround()
    this.buildTrees()
    this.buildWater()
    this.scene.add(this.fieldsGroup)
    this.buildFields()
    this.buildDecor()
    this.buildDome()
    if (this.regionView) { this.regionKey = ''; this.setRegion(this.regionView) }
    loadKit().then(() => { if (this.destroyed) return; this.kitReady = true; this.onKitLoaded() })
    this.initMosaic()
    this.buildMotes()
    for (const b of w.buildings) this.addBuilding(b)
    this.scene.add(this.cables, this.props)
    this.buildCables()
    this.buildProps()
    this.buildDrones()
    this.mapVersion = w.mapVersion

    const ringGeo = new THREE.RingGeometry(0.55, 0.7, 40)
    ringGeo.rotateX(-Math.PI / 2)
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xf0a742, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    this.ring = new THREE.Mesh(ringGeo, this.ringMat)
    this.ring.visible = false
    this.noAO(this.ring)
    this.scene.add(this.ring)
    this.link = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xd6b26a, transparent: true, opacity: 0.6 }))
    this.link.visible = false
    this.noAO(this.link)
    this.scene.add(this.link)
    this.noAO(this.fire)
    this.scene.add(this.fire)
    this.fireLight = new THREE.PointLight(0xff7a2a, 0, 12, 1.5)
    this.scene.add(this.fireLight)

    // post-processing
    const W0 = this.host.clientWidth, H0 = this.host.clientHeight
    this.composer = new EffectComposer(r)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.gtao = new GTAOPass(this.scene, this.aoCamera, W0, H0)
    this.gtao.output = GTAOPass.OUTPUT.Default
    this.gtao.blendIntensity = 0.9
    this.gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1, thickness: 1, scale: 1.2, samples: 12, distanceFallOff: 1, screenSpaceRadius: false })
    this.composer.addPass(this.gtao)
    this.bloom = new UnrealBloomPass(new THREE.Vector2(W0, H0), 0.45, 0.55, 0.92)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    this.tilt = new ShaderPass(TiltShiftShader)
    this.tilt.uniforms.resolution.value.set(W0 * r.getPixelRatio(), H0 * r.getPixelRatio())
    this.composer.addPass(this.tilt)
    this.grade = new ShaderPass(GradeShader)
    this.grade.uniforms.resolution.value.set(W0 * r.getPixelRatio(), H0 * r.getPixelRatio())
    this.composer.addPass(this.grade)

    this.setupInput()
    this.resizeObs = new ResizeObserver(() => this.resize())
    this.resizeObs.observe(this.host)
    const loop = () => { if (this.destroyed) return; this.frame(); this.raf = requestAnimationFrame(loop) }
    this.raf = requestAnimationFrame(loop)
  }

  /** Put an object (and its children) on layer 1: rendered by the main camera, ignored by the AO depth pass. */
  noAO(o: THREE.Object3D) { o.traverse(x => x.layers.set(1)) }

  // ───────── camera ─────────
  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
    const pr = this.renderer.getPixelRatio()
    this.tilt?.uniforms.resolution.value.set(w * pr, h * pr)
    this.grade?.uniforms.resolution.value.set(w * pr, h * pr)
    this.updateCamera()
  }
  updateCamera() {
    const w = this.host.clientWidth, h = this.host.clientHeight
    this.camera.aspect = Math.max(0.1, w / Math.max(1, h))
    this.camera.fov = this.fov
    this.camera.updateProjectionMatrix()
    // distance so that one world unit at the target spans `zoomPx` pixels
    const d = h / (2 * this.zoomPx * Math.tan(THREE.MathUtils.degToRad(this.fov) / 2))
    const dir = new THREE.Vector3(Math.cos(this.elevation) * Math.sin(this.azimuth), Math.sin(this.elevation), Math.cos(this.elevation) * Math.cos(this.azimuth))
    this.camera.position.copy(this.target).addScaledVector(dir, d)
    this.camera.lookAt(this.target)
    this.camera.updateMatrixWorld()
  }
  fitView() {
    const w = this.world
    this.target.set(w.w / 2 + 1, 0, w.h / 2 + 1)
    this.zoomPx = Math.min(this.host.clientWidth / (w.w * 1.25), this.host.clientHeight / (w.h * 1.05))
    this.zoomPx = Math.max(8, this.zoomPx)
    this.fitZoomPx = this.zoomPx
    this.camTarget = null
    this.updateCamera()
  }
  zoomBy(f: number, cx?: number, cy?: number) {
    const px = cx ?? this.host.clientWidth / 2, py = cy ?? this.host.clientHeight / 2
    const before = this.groundPoint(px, py)
    this.zoomPx = Math.max(3.5, Math.min(90, this.zoomPx * f))
    this.updateCamera()
    const after = this.groundPoint(px, py)
    if (before && after) this.target.add(before.clone().sub(after))
    this.updateCamera()
    this.camTarget = null
  }
  rotateBy(a: number) { this.azimuth += a; this.updateCamera() }
  focusOn(id: string) {
    const c = this.world.chars.find(x => x.id === id)
    if (!c) return
    this.camTarget = { x: c.pos.x + 0.5, y: c.pos.y + 0.5 }
    if (this.zoomPx < 34) this.zoomPx = 34
    this.updateCamera()
  }
  groundPoint(px: number, py: number): THREE.Vector3 | null {
    const w = this.host.clientWidth, h = this.host.clientHeight
    this.pointer.set((px / w) * 2 - 1, -(py / h) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const out = new THREE.Vector3()
    return this.raycaster.ray.intersectPlane(plane, out) ? out : null
  }

  setupInput() {
    const cv = this.canvas
    cv.addEventListener('contextmenu', e => e.preventDefault())
    cv.addEventListener('pointerdown', e => {
      this.dragging = true; this.dragMoved = false; this.dragButton = e.button
      this.dragStart = { x: e.offsetX, y: e.offsetY }
      this.azStart = this.azimuth
      const gp = this.groundPoint(e.offsetX, e.offsetY)
      if (gp) this.dragGround.copy(gp)
      cv.setPointerCapture(e.pointerId)
    })
    cv.addEventListener('pointermove', e => {
      if (this.dragging) {
        const dx = e.offsetX - this.dragStart.x, dy = e.offsetY - this.dragStart.y
        if (Math.abs(dx) + Math.abs(dy) > 4) this.dragMoved = true
        if (!this.dragMoved) return
        if (this.dragButton === 2 || e.shiftKey) {
          this.azimuth = this.azStart - dx * 0.008
          this.updateCamera()
        } else {
          const gp = this.groundPoint(e.offsetX, e.offsetY)
          if (gp) { this.target.add(this.dragGround.clone().sub(gp)); this.updateCamera() }
        }
        this.camTarget = null
        return
      }
      this.pickHover(e.offsetX, e.offsetY)
    })
    const up = (e: PointerEvent) => {
      if (!this.dragging) return
      this.dragging = false
      if (this.dragMoved) return
      if (e.button !== 0) return
      const id = this.pick(e.offsetX, e.offsetY)
      this.cb.onSelect(id)
    }
    cv.addEventListener('pointerup', up)
    cv.addEventListener('pointerleave', () => { if (this.hovered) { this.hovered = null; this.cb.onHover(null, 0, 0) } })
    cv.addEventListener('wheel', e => {
      e.preventDefault()
      this.zoomBy(Math.exp(-e.deltaY * 0.0016), e.offsetX, e.offsetY)
    }, { passive: false })
  }

  pick(px: number, py: number): string | null {
    const w = this.host.clientWidth, h = this.host.clientHeight
    this.pointer.set((px / w) * 2 - 1, -(py / h) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(this.hitMeshes, false)
    for (const hit of hits) { const id = (hit.object.userData as { id?: string }).id; if (id) return id }
    return null
  }
  pickHover(px: number, py: number) {
    const now = performance.now()
    if (now - this.lastHover < 40) return
    this.lastHover = now
    const id = this.pick(px, py)
    if (id !== this.hovered) {
      this.hovered = id
      this.canvas.style.cursor = id ? 'pointer' : 'grab'
    }
    if (id) this.cb.onHover(id, px, py); else this.cb.onHover(null, 0, 0)
  }

  // ───────── static scene ─────────
  buildLights() {
    this.hemi = new THREE.HemisphereLight(0x9fc3e0, 0x3b4a2e, 0.9)
    this.scene.add(this.hemi)
    this.ambient = new THREE.AmbientLight(0xffffff, 0.15)
    this.scene.add(this.ambient)
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.2)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const sc = this.sun.shadow.camera
    sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 300
    this.sun.shadow.bias = -0.0008
    this.sun.shadow.normalBias = 0.02
    this.scene.add(this.sun, this.sun.target)
    this.moon = new THREE.DirectionalLight(0x8fa8ff, 0)
    this.scene.add(this.moon, this.moon.target)
  }

  buildOutside() {
    const w = this.world
    // regolith plane far beyond the dome
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(600, 600, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3b2a26, roughness: 1 }))
    plane.rotation.x = -Math.PI / 2
    plane.position.set(w.w / 2, -0.05, w.h / 2)
    plane.receiveShadow = true
    this.scene.add(plane)
    // rocks
    const rockGeo = new THREE.DodecahedronGeometry(1, 0)
    const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: 0x4a3733, roughness: 1, flatShading: true }), 140)
    const m = new THREE.Matrix4()
    const cx = w.w / 2, cz = w.h / 2, R = 36
    for (let i = 0; i < 140; i++) {
      const a = hash(i, 7) * Math.PI * 2, d = R + 4 + hash(i, 3) * 90
      const s = 0.4 + hash(i, 11) * 2.2
      m.compose(new THREE.Vector3(cx + Math.cos(a) * d, s * 0.3, cz + Math.sin(a) * d), new THREE.Quaternion().setFromEuler(new THREE.Euler(hash(i, 5) * 3, hash(i, 9) * 3, 0)), new THREE.Vector3(s, s * 0.7, s))
      rocks.setMatrixAt(i, m)
    }
    rocks.castShadow = true
    this.scene.add(rocks)
    this.rocks = rocks
    // stars
    const n = 1600
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const th = hash(i, 1) * Math.PI * 2, ph = Math.acos(hash(i, 2) * 0.9)
      const rr = 260
      pos[i * 3] = cx + rr * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = rr * Math.cos(ph) * 0.6 + 10; pos[i * 3 + 2] = cz + rr * Math.sin(ph) * Math.sin(th)
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 0.9, sizeAttenuation: false, transparent: true, opacity: 0.8, fog: false }))
    this.scene.add(stars)
  }

  buildGround() {
    const w = this.world
    if (!this.atlas) this.atlas = buildGroundAtlas()
    const pos: number[] = [], col: number[] = [], idx: number[] = [], uv: number[] = [], uv1: number[] = []
    let vi = 0
    const N = this.atlas.cells
    const pad = 2 / (N * 128)
    for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) {
      const k = w.tiles[y * w.w + x]
      const h = hash(x, y)
      const ci = cellFor(k, hash(x * 7 + 3, y * 13 + 5))
      const cx = ci % N, cy = Math.floor(ci / N)
      const u0 = cx / N + pad, u1 = (cx + 1) / N - pad
      const v1 = 1 - cy / N - pad, v0 = 1 - (cy + 1) / N + pad
      const corners = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]]
      const rot = k === 4 || k === 6 ? 0 : Math.floor(h * 4)
      const bright = k === 0 || k === 3 ? 0.9 + h * 0.2 : k === 1 || k === 7 ? 0.94 + h * 0.1 : 1
      const yy = k === 2 ? -0.22 : 0
      const lift = k === 0 || k === 3 ? h * 0.05 : 0
      const quad = [[x, yy + lift, y], [x + 1, yy + lift, y], [x + 1, yy + lift, y + 1], [x, yy + lift, y + 1]]
      quad.forEach((p, i) => {
        pos.push(p[0], p[1], p[2])
        const b = Math.min(1, bright)
        col.push(b, b, b)
        const c = corners[(i + rot) % 4]
        uv.push(c[0], c[1])
        uv1.push(p[0] / w.w, 1 - p[2] / w.h)
      })
      idx.push(vi, vi + 2, vi + 1, vi, vi + 3, vi + 2)
      vi += 4
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2))
    g.setIndex(idx)
    g.computeVertexNormals()
    if (this.ground) { this.ground.geometry.dispose(); this.ground.geometry = g; return }
    const puddles = this.puddleMap()
    puddles.channel = 1
    const mat = new THREE.MeshPhysicalMaterial({
      map: this.atlas.map, normalMap: this.atlas.normal, normalScale: new THREE.Vector2(0.85, 0.85), roughnessMap: this.atlas.rough,
      roughness: 1, metalness: 0.06, vertexColors: true, envMapIntensity: 1,
      clearcoat: 1, clearcoatMap: puddles, clearcoatRoughness: 0.08,
      emissiveMap: this.atlas.emissive, emissive: 0xffffff, emissiveIntensity: 0.25,
    })
    this.ground = new THREE.Mesh(g, mat)
    this.ground.receiveShadow = true
    this.scene.add(this.ground)
  }

  /** Clearcoat mask: black = dry, white = wet. Puddles along the walkways, water always wet. */
  puddleMap(): THREE.Texture {
    const w = this.world
    const S = 512
    const c = document.createElement('canvas'); c.width = S; c.height = S
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, S, S)
    const sx = S / w.w, sy = S / w.h
    for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) {
      const k = w.tiles[y * w.w + x]
      const h = hash(x * 3 + 1, y * 5 + 2)
      const px = x * sx, py = (w.h - 1 - y) * sy
      if (k === 1 || k === 7 || k === 6) {
        ctx.fillStyle = k === 7 ? '#2a2a2a' : '#1c1c1c'
        ctx.fillRect(px, py, sx + 0.5, sy + 0.5)
        if (h > 0.6) {
          ctx.fillStyle = h > 0.85 ? '#ffffff' : '#b0b0b0'
          ctx.beginPath()
          ctx.ellipse(px + sx * h, py + sy * ((h * 7) % 1), sx * (0.35 + h * 0.5), sy * (0.25 + ((h * 3) % 1) * 0.4), h * 3, 0, Math.PI * 2)
          ctx.fill()
        }
      } else if (k === 2) {
        ctx.fillStyle = '#f0f0f0'; ctx.fillRect(px, py, sx + 0.5, sy + 0.5)
      }
    }
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.NoColorSpace
    tex.minFilter = THREE.LinearMipmapLinearFilter
    return tex
  }

  buildMotes() {
    const w = this.world
    const cx = w.w / 2, cz = w.h / 2
    const R = Math.hypot(w.w, w.h) / 2
    const n = 900
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const a = hash(i, 21) * Math.PI * 2, rr = Math.sqrt(hash(i, 22)) * R * 0.95
      pos[i * 3] = cx + Math.cos(a) * rr; pos[i * 3 + 1] = 0.4 + hash(i, 23) * 14; pos[i * 3 + 2] = cz + Math.sin(a) * rr
    }
    this.motesBase = pos.slice()
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const m = new THREE.PointsMaterial({ color: 0xffe2b0, size: 0.09, sizeAttenuation: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })
    this.motes = new THREE.Points(g, m)
    this.noAO(this.motes)
    this.scene.add(this.motes)
  }

  /** Wind sway for instanced plants: amplitude grows with height, phase from the instance position. */
  swayMaterial(mat: THREE.Material, strength = 0.06) {
    mat.onBeforeCompile = shader => {
      shader.uniforms.uTime = this.uTime
      shader.uniforms.uSway = { value: strength }
      shader.vertexShader = 'uniform float uTime; uniform float uSway;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3][0] * 0.9 + instanceMatrix[3][2] * 1.3;
          float amp = max(0.0, position.y) * uSway;
          transformed.x += sin(uTime * 1.4 + ph) * amp;
          transformed.z += cos(uTime * 1.1 + ph * 0.7) * amp;
        #endif`)
    }
    mat.customProgramCacheKey = () => 'sway' + strength
    return mat
  }

  buildTrees() {
    const w = this.world
    for (const t of this.trees) { this.scene.remove(t); (t as THREE.InstancedMesh).dispose?.() }
    this.trees = []
    this.glowMats = this.glowMats.filter(m => m.userData.keep)
    const spots: { x: number; y: number; kind: number }[] = []
    const isRoad = (x: number, y: number) => { const k = w.tiles[y * w.w + x]; return k === 1 || k === 7 }
    const nearField = (x: number, y: number) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w.w && yy < w.h && w.tiles[yy * w.w + xx] === 4) return true } return false }
    const nearRoad = (x: number, y: number) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w.w && yy < w.h && isRoad(xx, yy)) return true } return false }
    for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) {
      if (w.tiles[y * w.w + x] !== 3) continue
      const h = hash(x, y)
      const kind = nearField(x, y) ? 2 : nearRoad(x, y) ? 1 : h < 0.75 ? 0 : 1
      spots.push({ x, y, kind })
    }
    const alien = spots.filter(p => p.kind === 0), eng = spots.filter(p => p.kind === 1), towers = spots.filter(p => p.kind === 2)
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color()
    const place = (im: THREE.InstancedMesh, i: number, x: number, y: number, z: number, sc: number, rot = 0) => { m.compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(sc, sc, sc)); im.setMatrixAt(i, m) }
    const addIM = (im: THREE.InstancedMesh, shadow = true) => { im.castShadow = shadow; im.receiveShadow = true; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; this.scene.add(im); this.trees.push(im) }

    // 1. alien flora: bending stalk, broad blades, glowing pods
    if (alien.length) {
      const stalkGeo = new THREE.CylinderGeometry(0.03, 0.07, 1.6, 6); stalkGeo.translate(0, 0.8, 0)
      const stalks = new THREE.InstancedMesh(stalkGeo, this.swayMaterial(new THREE.MeshStandardMaterial({ color: 0x3d5a52, roughness: 0.8 }), 0.09), alien.length)
      const bladeGeo = new THREE.PlaneGeometry(0.35, 0.9, 1, 3); bladeGeo.translate(0, 0.45, 0)
      const blades = new THREE.InstancedMesh(bladeGeo, this.swayMaterial(new THREE.MeshStandardMaterial({ color: 0x2f7a6a, roughness: 0.85, side: THREE.DoubleSide }), 0.12), alien.length * 3)
      const podGeo = new THREE.SphereGeometry(0.16, 8, 7)
      const podMat = new THREE.MeshStandardMaterial({ color: 0x6fc8d8, emissive: 0x4fc0e0, emissiveIntensity: 0.2, roughness: 0.4 })
      podMat.userData.glow = { day: 0.12, night: 1.3 }
      this.glowMats.push(this.swayMaterial(podMat, 0.09) as THREE.MeshStandardMaterial)
      const pods = new THREE.InstancedMesh(podGeo, podMat, alien.length * 2)
      alien.forEach((p, i) => {
        const h = hash(p.x, p.y), sc = 0.8 + h * 0.7
        const x = p.x + 0.5 + (h - 0.5) * 0.5, z = p.y + 0.5 + ((h * 3) % 1 - 0.5) * 0.5
        place(stalks, i, x, 0, z, sc, h * 6)
        for (let k = 0; k < 3; k++) place(blades, i * 3 + k, x, 0.05, z, sc * (0.8 + ((h * (k + 2)) % 1) * 0.5), h * 6 + k * 2.1)
        for (let k = 0; k < 2; k++) { place(pods, i * 2 + k, x + Math.sin(h * 6 + k * 2.5) * 0.18 * sc, 1.45 * sc + k * 0.22 * sc, z + Math.cos(h * 6 + k * 2.5) * 0.18 * sc, sc * (0.7 + k * 0.3)); c.setHex(h > 0.5 ? 0x6fc8d8 : 0xb08ad8); pods.setColorAt(i * 2 + k, c) }
        c.setHex([0x2f7a6a, 0x3a8a70, 0x2a6a80][Math.floor(h * 3)]); for (let k = 0; k < 3; k++) blades.setColorAt(i * 3 + k, c)
      })
      addIM(stalks); addIM(blades); addIM(pods, false)
    }
    // 2. engineered trees: thin trunk, flat disc canopy, grow lamp on an arm
    if (eng.length) {
      const trunkGeo = new THREE.CylinderGeometry(0.06, 0.09, 1.5, 6); trunkGeo.translate(0, 0.75, 0)
      const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b5a4a, roughness: 0.9 }), eng.length)
      const canopyGeo = new THREE.CylinderGeometry(0.75, 0.55, 0.28, 10); canopyGeo.translate(0, 1.55, 0)
      const canopies = new THREE.InstancedMesh(canopyGeo, this.swayMaterial(new THREE.MeshStandardMaterial({ color: 0x3f7a4a, roughness: 0.9, flatShading: true }), 0.03), eng.length)
      const armGeo = new THREE.BoxGeometry(0.04, 0.04, 0.9); armGeo.translate(0, 2.1, 0.35)
      const arms = new THREE.InstancedMesh(armGeo, this.metal, eng.length)
      const lampGeo = new THREE.BoxGeometry(0.22, 0.05, 0.22); lampGeo.translate(0, 2.08, 0.75)
      const lampMat = new THREE.MeshStandardMaterial({ color: 0xffb4e8, emissive: 0xff7ad0, emissiveIntensity: 0.4 })
      lampMat.userData.glow = { day: 0.2, night: 1.6 }
      this.glowMats.push(lampMat)
      const lamps = new THREE.InstancedMesh(lampGeo, lampMat, eng.length)
      const postGeo = new THREE.CylinderGeometry(0.03, 0.03, 2.1, 5); postGeo.translate(0, 1.05, 0.35)
      const posts = new THREE.InstancedMesh(postGeo, this.metal, eng.length)
      eng.forEach((p, i) => {
        const h = hash(p.x, p.y), sc = 0.85 + h * 0.4
        const x = p.x + 0.5 + (h - 0.5) * 0.3, z = p.y + 0.5 + ((h * 3) % 1 - 0.5) * 0.3
        place(trunks, i, x, 0, z, sc); place(canopies, i, x, 0, z, sc, h * 6)
        const rot = Math.floor(h * 4) * Math.PI / 2
        place(arms, i, x, 0, z, sc, rot); place(lamps, i, x, 0, z, sc, rot); place(posts, i, x, 0, z, sc, rot)
        c.setHex([0x3f7a4a, 0x4a8a52, 0x356a48][Math.floor(h * 3)]); canopies.setColorAt(i, c)
      })
      addIM(trunks); addIM(canopies); addIM(arms, false); addIM(lamps, false); addIM(posts, false)
    }
    // 3. hydroponic towers near the beds: glass column, green tiers, light core
    if (towers.length) {
      const glassGeo = new THREE.CylinderGeometry(0.42, 0.42, 1.9, 14, 1, true); glassGeo.translate(0, 1.05, 0)
      const glass = new THREE.InstancedMesh(glassGeo, new THREE.MeshPhysicalMaterial({ color: 0x9fd8c8, transparent: true, opacity: 0.28, roughness: 0.15, side: THREE.DoubleSide, depthWrite: false }), towers.length)
      const baseGeo = new THREE.CylinderGeometry(0.5, 0.55, 0.2, 14); baseGeo.translate(0, 0.1, 0)
      const bases = new THREE.InstancedMesh(baseGeo, this.metalDark, towers.length)
      const capGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.12, 14); capGeo.translate(0, 2.0, 0)
      const caps = new THREE.InstancedMesh(capGeo, this.metal, towers.length)
      const tierGeo = new THREE.TorusGeometry(0.3, 0.1, 6, 14); tierGeo.rotateX(Math.PI / 2)
      const tiers = new THREE.InstancedMesh(tierGeo, new THREE.MeshStandardMaterial({ color: 0x5aa86a, roughness: 0.9, flatShading: true }), towers.length * 3)
      const coreGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.7, 6); coreGeo.translate(0, 1.05, 0)
      const coreMat = new THREE.MeshStandardMaterial({ color: 0xffd0f0, emissive: 0xff7ad0, emissiveIntensity: 0.8 })
      coreMat.userData.glow = { day: 0.4, night: 2.0 }
      this.glowMats.push(coreMat)
      const cores = new THREE.InstancedMesh(coreGeo, coreMat, towers.length)
      towers.forEach((p, i) => {
        const h = hash(p.x, p.y)
        const x = p.x + 0.5, z = p.y + 0.5
        place(glass, i, x, 0, z, 1); place(bases, i, x, 0, z, 1); place(caps, i, x, 0, z, 1); place(cores, i, x, 0, z, 1)
        for (let k = 0; k < 3; k++) { place(tiers, i * 3 + k, x, 0.55 + k * 0.5, z, 1, h * 3 + k); c.setHex([0x5aa86a, 0x7fc5a0, 0x3f8a4c][(k + Math.floor(h * 3)) % 3]); tiers.setColorAt(i * 3 + k, c) }
      })
      addIM(bases); addIM(caps); addIM(tiers); addIM(cores, false); addIM(glass, false); this.noAO(glass)
    }
    // 4. grass blades on the regolith: crossed quads, swaying
    const soil: { x: number; y: number }[] = []
    for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) if (w.tiles[y * w.w + x] === 0) soil.push({ x, y })
    if (soil.length) {
      const per = 5
      const g1 = new THREE.PlaneGeometry(0.16, 0.34, 1, 2); g1.translate(0, 0.17, 0)
      const g2 = g1.clone(); g2.rotateY(Math.PI / 2)
      const bladeGeo = new THREE.BufferGeometry()
      const merged = [g1, g2]
      const pos: number[] = [], uv: number[] = [], idx: number[] = []
      let off = 0
      for (const g of merged) { const p = g.getAttribute('position'), u = g.getAttribute('uv'), ix = g.getIndex()!; for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); uv.push(u.getX(i), u.getY(i)) } for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off); off += p.count }
      bladeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); bladeGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); bladeGeo.setIndex(idx); bladeGeo.computeVertexNormals()
      const grassMat = this.swayMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide }), 0.35)
      const grass = new THREE.InstancedMesh(bladeGeo, grassMat, soil.length * per)
      soil.forEach((p, i) => {
        for (let k = 0; k < per; k++) {
          const h = hash(p.x * 11 + k, p.y * 7 + k * 3)
          const x = p.x + 0.1 + h * 0.8, z = p.y + 0.1 + ((h * 5) % 1) * 0.8
          place(grass, i * per + k, x, 0, z, 0.6 + ((h * 9) % 1) * 0.8, h * 6)
          c.setHex(h > 0.9 ? 0x6fe8d0 : [0x4a7a48, 0x5a8a56, 0x3f6a44, 0x6a8a5a][Math.floor(h * 4)]); grass.setColorAt(i * per + k, c)
        }
      })
      grass.castShadow = false
      grass.userData.grass = true
      addIM(grass, false)
    }
  }

  /** Animated water surface over the canal tiles. */
  buildWater() {
    const w = this.world
    const pos: number[] = [], uv: number[] = [], idx: number[] = []
    let vi = 0
    for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) {
      if (w.tiles[y * w.w + x] !== 2) continue
      for (const [dx, dz] of [[0, 0], [1, 0], [1, 1], [0, 1]]) { pos.push(x + dx, -0.12, y + dz); uv.push((x + dx) / 6, (y + dz) / 6) }
      idx.push(vi, vi + 2, vi + 1, vi, vi + 3, vi + 2); vi += 4
    }
    if (!vi) return
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals()
    const mat = new THREE.MeshPhysicalMaterial({ color: 0x2a7c9c, transparent: true, opacity: 0.82, roughness: 0.08, metalness: 0.05, normalMap: rippleNormal(), normalScale: new THREE.Vector2(0.5, 0.5), emissive: 0x1a6a8a, emissiveIntensity: 0.15, envMapIntensity: 1.4, clearcoat: 1, clearcoatRoughness: 0.05 })
    this.water = new THREE.Mesh(g, mat)
    this.water.receiveShadow = true
    this.noAO(this.water)
    this.scene.add(this.water)
    // glowing shore strips
    const edges: { x: number; y: number; side: number }[] = []
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w.w || y >= w.h ? 2 : w.tiles[y * w.w + x])
    for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) if (at(x, y) === 2) { if (at(x - 1, y) !== 2 && at(x - 1, y) !== 6) edges.push({ x, y, side: -1 }); if (at(x + 1, y) !== 2 && at(x + 1, y) !== 6) edges.push({ x, y, side: 1 }) }
    if (edges.length) {
      const stripMat = new THREE.MeshStandardMaterial({ color: 0x8fe8ff, emissive: 0x58c4ff, emissiveIntensity: 0.5 })
      stripMat.userData.glow = { day: 0.08, night: 1.2 }; stripMat.userData.keep = true
      this.glowMats.push(stripMat)
      const strips = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.05, 1), stripMat, edges.length)
      const m = new THREE.Matrix4()
      edges.forEach((e, i) => { m.makeTranslation(e.x + (e.side > 0 ? 0.97 : 0.03), 0.02, e.y + 0.5); strips.setMatrixAt(i, m) })
      this.scene.add(strips)
    }
  }

  /** Hydroponic beds: raised troughs per row of field tiles, plant rows and a grow-light strip. */
  buildFields() {
    const w = this.world
    this.fieldsGroup.clear()
    const runs: { x0: number; x1: number; y: number }[] = []
    for (let y = 0; y < w.h; y++) {
      let x = 0
      while (x < w.w) {
        if (w.tiles[y * w.w + x] !== 4) { x++; continue }
        const x0 = x; while (x < w.w && w.tiles[y * w.w + x] === 4) x++
        runs.push({ x0, x1: x, y })
      }
    }
    const soilMat = new THREE.MeshStandardMaterial({ color: 0x3f3226, roughness: 1 })
    const plantMat = new THREE.MeshStandardMaterial({ color: 0x5aa86a, roughness: 0.9, flatShading: true })
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffb4e8, emissive: 0xff7ad0, emissiveIntensity: 0.5 })
    lampMat.userData.glow = { day: 0.35, night: 2.0 }
    this.glowMats.push(lampMat)
    let plantCount = 0
    for (const r of runs) plantCount += Math.floor((r.x1 - r.x0) * 2.5)
    const plants = new THREE.InstancedMesh(new THREE.SphereGeometry(0.14, 7, 5), this.swayMaterial(plantMat, 0.05), Math.max(1, plantCount))
    const m = new THREE.Matrix4(), c = new THREE.Color()
    let pi = 0
    for (const r of runs) {
      const len = r.x1 - r.x0, cx = (r.x0 + r.x1) / 2, cz = r.y + 0.5
      const trough = new THREE.Mesh(new THREE.BoxGeometry(len - 0.1, 0.3, 0.78), this.metalDark); trough.position.set(cx, 0.15, cz); trough.castShadow = true; trough.receiveShadow = true; this.fieldsGroup.add(trough)
      const soil = new THREE.Mesh(new THREE.BoxGeometry(len - 0.2, 0.06, 0.62), soilMat); soil.position.set(cx, 0.3, cz); this.fieldsGroup.add(soil)
      const n = Math.floor(len * 2.5)
      for (let k = 0; k < n && pi < plantCount; k++) {
        const h = hash(r.x0 * 3 + k, r.y * 5)
        m.makeTranslation(r.x0 + 0.2 + (k + 0.5) * ((len - 0.4) / n), 0.42, cz + (h - 0.5) * 0.3); m.scale(new THREE.Vector3(0.7 + h * 0.6, 0.7 + h * 0.6, 0.7 + h * 0.6))
        plants.setMatrixAt(pi, m); c.setHex([0x5aa86a, 0x7fc5a0, 0x3f8a4c, 0x9ad07a][Math.floor(h * 4)]); plants.setColorAt(pi, c); pi++
      }
      for (const px of [r.x0 + 0.15, r.x1 - 0.15]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.9, 5), this.metal); post.position.set(px, 0.45, cz); this.fieldsGroup.add(post) }
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(len - 0.2, 0.03, 0.08), lampMat); lamp.position.set(cx, 0.9, cz); this.fieldsGroup.add(lamp)
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, len - 0.2, 5), this.metal); pipe.rotation.z = Math.PI / 2; pipe.position.set(cx, 0.86, cz + 0.1); this.fieldsGroup.add(pipe)
    }
    plants.instanceMatrix.needsUpdate = true; if (plants.instanceColor) plants.instanceColor.needsUpdate = true
    plants.castShadow = true
    this.fieldsGroup.add(plants)
  }

  buildDecor() {
    // fountain
    const well = new THREE.Group()
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.0, 0.35, 16, 1), new THREE.MeshStandardMaterial({ color: 0x8b939e, metalness: 0.4, roughness: 0.5 }))
    basin.position.y = 0.17
    const water = new THREE.Mesh(new THREE.CircleGeometry(0.82, 24), new THREE.MeshStandardMaterial({ color: 0x1f6f8f, emissive: 0x2aa3c8, emissiveIntensity: 0.5, roughness: 0.1 }))
    water.rotation.x = -Math.PI / 2; water.position.y = 0.34
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.12, 1.1, 8), new THREE.MeshStandardMaterial({ color: 0xbfe3ff, emissive: 0x9fd8ff, emissiveIntensity: 0.9, transparent: true, opacity: 0.8 }))
    column.position.y = 0.85
    well.add(basin, water, column)
    well.position.set(24.5, 0, 16.5)
    well.traverse(o => { o.castShadow = true })
    this.scene.add(well)
    // lamps
    for (const [lx, ly] of [[21.5, 13.5], [27.5, 13.5], [21.5, 19.5], [27.5, 19.5]]) {
      const g = new THREE.Group()
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.6, 6), new THREE.MeshStandardMaterial({ color: 0x8b939e, metalness: 0.6, roughness: 0.4 }))
      post.position.y = 0.8
      const bulbMat = new THREE.MeshStandardMaterial({ color: 0xdff3ff, emissive: 0xbfe3ff, emissiveIntensity: 0 })
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), bulbMat)
      bulb.position.y = 1.7
      const light = new THREE.PointLight(0xbfe3ff, 0, 7, 1.6)
      light.position.y = 1.7
      g.add(post, bulb, light)
      g.position.set(lx, 0, ly)
      this.scene.add(g)
      this.lamps.push({ light, bulb: bulbMat })
    }
  }

  buildDome() {
    const w = this.world
    const cx = w.w / 2, cz = w.h / 2
    const R = Math.hypot(w.w, w.h) / 2 + 3
    const geo = new THREE.SphereGeometry(R, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2)
    const mat = new THREE.MeshPhysicalMaterial({ color: 0x9cc8ff, transparent: true, opacity: 0.09, roughness: 0.75, metalness: 0, clearcoat: 0.15, clearcoatRoughness: 0.8, specularIntensity: 0.15, side: THREE.DoubleSide, depthWrite: false })
    this.dome = new THREE.Mesh(geo, mat)
    this.dome.position.set(cx, 0, cz)
    this.dome.renderOrder = 5
    this.noAO(this.dome)
    this.scene.add(this.dome)
    const frameGeo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(R * 1.003, 3), 1)
    const frameMat = new THREE.LineBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.14, clippingPlanes: [new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.2)] })
    this.domeFrame = new THREE.LineSegments(frameGeo, frameMat)
    this.domeFrame.position.set(cx, 0, cz)
    this.noAO(this.domeFrame)
    this.scene.add(this.domeFrame)
    // base ring
    const base = new THREE.Mesh(new THREE.TorusGeometry(R, 0.55, 8, 96), new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.7, roughness: 0.4 }))
    base.rotation.x = Math.PI / 2
    base.position.set(cx, 0.1, cz)
    this.scene.add(base)
    const strip = new THREE.Mesh(new THREE.TorusGeometry(R, 0.12, 6, 96), new THREE.MeshStandardMaterial({ color: 0x7fd6ff, emissive: 0x58c4ff, emissiveIntensity: 1.6 }))
    strip.rotation.x = Math.PI / 2
    strip.position.set(cx, 0.6, cz)
    this.scene.add(strip)
  }

  // ───────── region: neighbouring domes on the horizon, roads, rovers ─────────
  /** World-space centre of a dome; the active dome sits at the map centre. */
  private domePos(view: RegionView, id: string) {
    const w = this.world
    const me = view.domes.find(d => d.id === view.active) ?? view.domes[0]
    const d = view.domes.find(x => x.id === id) ?? me
    return new THREE.Vector3(w.w / 2 + (d.x - me.x), 0, w.h / 2 + (d.y - me.y))
  }

  setRegion(view: RegionView | null) {
    this.regionView = view
    if (!view) { this.regionGroup.clear(); this.regionKey = ''; for (const r of this.rovers) r.visible = false; return }
    const key = view.active + '|' + view.domes.map(d => `${d.id}:${d.population}${d.site ? 's' : ''}`).join(',') + '|' + view.links.length
    if (key !== this.regionKey) { this.regionKey = key; this.buildRegion(view) }
    this.syncRovers(view)
  }

  private buildRegion(view: RegionView) {
    const w = this.world
    const g = this.regionGroup
    g.clear()
    this.roads.clear()
    const R = Math.hypot(w.w, w.h) / 2 + 3
    const hull = new THREE.MeshPhysicalMaterial({ color: 0x9cc8ff, transparent: true, opacity: 0.11, roughness: 0.75, clearcoat: 0.15, side: THREE.DoubleSide, depthWrite: false })
    const frameMat = new THREE.LineBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.1 })
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.7, roughness: 0.4 })
    const stripMat = new THREE.MeshStandardMaterial({ color: 0x7fd6ff, emissive: 0x58c4ff, emissiveIntensity: 1.4 })
    const blockMat = new THREE.MeshStandardMaterial({ color: 0x5c6470, roughness: 0.7, metalness: 0.3 })
    const winMat = new THREE.MeshStandardMaterial({ color: 0xffd28a, emissive: 0xffb84a, emissiveIntensity: 1.2 })
    winMat.userData.glow = { day: 0.25, night: 1.6 }
    this.glowMats.push(winMat)
    for (const d of view.domes) {
      if (d.id === view.active) continue
      const p = this.domePos(view, d.id)
      if (d.site) {
        // a surveyed site: a ring of pegs, a mast with a blinking light, a few crates
        const pegMat = new THREE.MeshStandardMaterial({ color: 0xff9a5a, emissive: 0xff7a3a, emissiveIntensity: 1.5 })
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2
          const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1.4, 6), pegMat)
          peg.position.set(p.x + Math.cos(a) * R, 0.7, p.z + Math.sin(a) * R); g.add(peg)
        }
        const ringLine = new THREE.Mesh(new THREE.TorusGeometry(R, 0.08, 4, 64), new THREE.MeshBasicMaterial({ color: 0xff9a5a, transparent: true, opacity: 0.35 }))
        ringLine.rotation.x = Math.PI / 2; ringLine.position.set(p.x, 0.15, p.z); g.add(ringLine)
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 9, 6), this.metal); mast.position.set(p.x, 4.5, p.z); g.add(mast)
        const light = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), pegMat); light.position.set(p.x, 9.2, p.z); g.add(light)
        for (let i = 0; i < 5; i++) { const crate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1, 1.2), blockMat); crate.position.set(p.x + hash(i, 31) * 8 - 4, 0.5, p.z + hash(i, 37) * 8 - 4); crate.rotation.y = hash(i, 41); g.add(crate) }
        const label = makeSprite(`${d.name.toUpperCase()} · CONSTRUCTION SITE`, { font: '32px "Rubik Mono One", monospace', size: 32, color: '#ff9a5a', stroke: 'rgba(8,8,6,0.9)' }, 3.4)
        label.position.set(p.x, 12, p.z); g.add(label)
        continue
      }
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), hull)
      sphere.position.copy(p); sphere.renderOrder = 5; this.noAO(sphere); g.add(sphere)
      const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(R * 1.003, 2), 1), frameMat)
      frame.position.copy(p); this.noAO(frame); g.add(frame)
      const base = new THREE.Mesh(new THREE.TorusGeometry(R, 0.55, 8, 64), ringMat); base.rotation.x = Math.PI / 2; base.position.set(p.x, 0.1, p.z); g.add(base)
      const strip = new THREE.Mesh(new THREE.TorusGeometry(R, 0.12, 6, 64), stripMat); strip.rotation.x = Math.PI / 2; strip.position.set(p.x, 0.6, p.z); g.add(strip)
      // a coarse skyline inside: blocks sized by population, one reactor tower with a beacon
      const n = 10 + Math.round(d.population / 4)
      const salt = d.id.charCodeAt(0)
      for (let i = 0; i < n; i++) {
        const a = hash(i, 21 + salt) * Math.PI * 2, r = hash(i, 5 + salt) * R * 0.7
        const bw = 2 + hash(i, 9) * 4, bh = 1.5 + hash(i, 13 + salt) * 4, bd = 2 + hash(i, 17) * 4
        const box = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), blockMat)
        box.position.set(p.x + Math.cos(a) * r, bh / 2, p.z + Math.sin(a) * r); box.rotation.y = hash(i, 3) * Math.PI
        box.castShadow = true; g.add(box)
        const win = new THREE.Mesh(new THREE.BoxGeometry(bw * 0.7, 0.25, bd * 0.7), winMat)
        win.position.set(box.position.x, bh * 0.6, box.position.z); win.rotation.y = box.rotation.y; g.add(win)
      }
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2, 12, 10), blockMat); tower.position.set(p.x, 6, p.z); g.add(tower)
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), new THREE.MeshStandardMaterial({ color: 0xff6a4a, emissive: 0xff5a3a, emissiveIntensity: 2 })); beacon.position.set(p.x, 12.5, p.z); g.add(beacon)
      const label = makeSprite(`${d.name.toUpperCase()} · ${d.population}`, { font: '32px "Rubik Mono One", monospace', size: 32, color: '#9fd0ff', stroke: 'rgba(8,8,6,0.9)' }, 4)
      label.position.set(p.x, R + 4, p.z); g.add(label)
    }
    // roads: flat ribbons between the dome rings with lamp posts along the edges
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x2a2521, roughness: 1 })
    const postMat = new THREE.MeshStandardMaterial({ color: 0x6ad1ff, emissive: 0x4ab8ff, emissiveIntensity: 1.2 })
    for (const l of view.links) {
      const pa = this.domePos(view, l.a), pb = this.domePos(view, l.b)
      const dir = pb.clone().sub(pa); const len = dir.length(); dir.normalize()
      const a = pa.clone().add(dir.clone().multiplyScalar(R + 0.6)), b = pb.clone().sub(dir.clone().multiplyScalar(R + 0.6))
      this.roads.set(`${l.a}-${l.b}`, { a, b })
      const L = len - (R + 0.6) * 2
      if (L <= 0) continue
      const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(L, 2.6), roadMat)
      ribbon.rotation.x = -Math.PI / 2; ribbon.rotation.z = -Math.atan2(dir.z, dir.x)
      ribbon.position.copy(a.clone().add(b).multiplyScalar(0.5)); ribbon.position.y = 0.03
      ribbon.receiveShadow = true; g.add(ribbon)
      const posts = Math.floor(L / 9)
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 1.6, 0.25), postMat, posts * 2)
      const m = new THREE.Matrix4(), side = new THREE.Vector3(-dir.z, 0, dir.x)
      for (let i = 0; i < posts; i++) {
        const c = a.clone().add(dir.clone().multiplyScalar((i + 0.5) * 9))
        m.makeTranslation(c.x + side.x * 1.7, 0.8, c.z + side.z * 1.7); inst.setMatrixAt(i * 2, m)
        m.makeTranslation(c.x - side.x * 1.7, 0.8, c.z - side.z * 1.7); inst.setMatrixAt(i * 2 + 1, m)
      }
      g.add(inst)
    }
    if (!g.parent) this.scene.add(g)
    if (!this.roverPool.parent) this.scene.add(this.roverPool)
  }

  private makeRover() {
    const r = new THREE.Group()
    if (this.kitReady && this.useKit) {
      const m = kitInstance('rover'), mm = kitMeasure('rover')
      if (m && mm) { const sc = 2.4 / Math.max(mm.size.x, mm.size.z); m.scale.setScalar(sc); m.position.y = -mm.min.y * sc; m.rotation.y = Math.PI / 2; r.add(m); const head = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.2, 0.9), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c0, emissiveIntensity: 3 })); head.position.set(1.15, 0.6, 0); r.add(head); return r }
    }
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.8, 1.3), new THREE.MeshStandardMaterial({ color: 0xc9a25a, metalness: 0.5, roughness: 0.5 })); body.position.y = 0.75; body.castShadow = true; r.add(body)
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 1.1), new THREE.MeshStandardMaterial({ color: 0x9fd0ff, emissive: 0x3a7cc0, emissiveIntensity: 0.4, roughness: 0.2 })); cab.position.set(0.5, 1.4, 0); r.add(cab)
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.2, 0.9), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c0, emissiveIntensity: 3 })); head.position.set(1.15, 0.75, 0); r.add(head)
    for (const [x, z] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) { const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.35, 10), this.rubber); wheel.rotation.x = Math.PI / 2; wheel.position.set(x, 0.4, z); r.add(wheel) }
    const dust = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 4), new THREE.MeshBasicMaterial({ color: 0x6a5a50, transparent: true, opacity: 0.35 })); dust.position.set(-1.4, 0.4, 0); r.add(dust)
    return r
  }

  private syncRovers(view: RegionView) {
    while (this.rovers.length < view.travelers.length) { const r = this.makeRover(); this.rovers.push(r); this.roverPool.add(r) }
    for (let i = 0; i < this.rovers.length; i++) {
      const r = this.rovers[i], t = view.travelers[i]
      if (!t) { r.visible = false; continue }
      const road = this.roads.get(`${t.from}-${t.to}`) ?? this.roads.get(`${t.to}-${t.from}`)
      if (!road) { r.visible = false; continue }
      const forward = this.roads.has(`${t.from}-${t.to}`)
      const from = forward ? road.a : road.b, to = forward ? road.b : road.a
      const dir = to.clone().sub(from)
      const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(0.7)
      r.position.copy(from).addScaledVector(dir, t.progress).add(side)
      r.rotation.y = -Math.atan2(dir.z, dir.x)
      r.visible = true
    }
  }

  // ───────── mosaic look ─────────
  initMosaic() {
    const w = this.world
    const center = new THREE.Vector3(w.w / 2, 0, w.h / 2)
    const R = Math.hypot(w.w, w.h) / 2 + 3
    this.mosaicU = makeMosaicUniforms(center, R)
    this.pixels = makePixels(center, R)
    this.noAO(this.pixels.points)
    this.scene.add(this.pixels.points)
    this.setMosaic(this.mosaicOn)
  }

  setMosaic(on: boolean) {
    this.mosaicOn = on
    try { localStorage.setItem('mosaic', on ? '1' : '0') } catch { /* noop */ }
    if (!this.mosaicU || !this.pixels) return
    this.mosaicU.uMosaic.value = on ? 1 : 0
    this.pixels.points.visible = on
    this.renderer.toneMappingExposure = on ? 0.95 : 1.2
    for (const o of this.trees) if (o.userData.grass) o.visible = !on
    if (on) this.patchMosaic()
  }

  /** Injects the mosaic shader into every standard material in the scene that does not carry it yet. */
  patchMosaic() {
    if (!this.mosaicU) return
    const u = this.mosaicU
    this.scene.traverse(o => {
      const m = o as THREE.Mesh
      if (!m.isMesh || m === this.dome) return
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      for (const mat of mats) applyMosaic(mat, u)
    })
  }

  // ───────── glTF kit ─────────
  /** Builds a building from the kit recipe; returns false if the recipe or models are missing. */
  addKit(group: THREE.Group, b: Building, W: number, D: number, windows: THREE.MeshStandardMaterial[]): boolean {
    const recipe = RECIPES[b.type]
    if (!recipe) return false
    const seed = hash(b.x * 3 + 1, b.y * 5 + 2)
    const parts = recipe(seed)
    // the door side decides which way the main model faces
    const doorSide = b.door.y >= b.y + b.h ? 0 : b.door.y < b.y ? Math.PI : b.door.x < b.x ? Math.PI / 2 : -Math.PI / 2
    parts[0] = { ...parts[0], rot: (parts[0].rot ?? 0) + doorSide }
    const top = kitAssemble(group, parts, W, D)
    if (top === null) { group.clear(); return false }
    // the accent stripe takes the building's colour; a lit strip over the door keeps the night look
    const accent = b.type === 'house' ? ACCENT[Math.floor(hash(b.x, b.y) * ACCENT.length)] : TYPE_ACCENT[b.type] ?? 0x5cc8ff
    group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat.name === ACCENT_MATERIAL) { const sm = mat as THREE.MeshStandardMaterial; sm.color.setHex(accent).multiplyScalar(0.85); sm.emissive = new THREE.Color(accent); sm.emissiveIntensity = 0; sm.userData.glow = { day: 0.05, night: 0.45 }; this.glowMats.push(sm) } })
    const doorLight = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.5 })
    const dl = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 0.06), doorLight)
    const cx = b.x + W / 2, cz = b.y + D / 2
    const dx = THREE.MathUtils.clamp(b.door.x + 0.5 - cx, -W / 2 + 0.4, W / 2 - 0.4), dz = THREE.MathUtils.clamp(b.door.y + 0.5 - cz, -D / 2 + 0.4, D / 2 - 0.4)
    if (doorSide === 0) dl.position.set(dx, 0.95, D / 2 + 0.02)
    else if (doorSide === Math.PI) dl.position.set(dx, 0.95, -D / 2 - 0.02)
    else { dl.position.set(doorSide > 0 ? -W / 2 - 0.02 : W / 2 + 0.02, 0.95, dz); dl.rotation.y = Math.PI / 2 }
    group.add(dl)
    windows.push(doorLight)
    // the chapel's dark dome becomes glass that glows at night
    if (b.type === 'church') group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat.name === 'dark') { const sm = mat as THREE.MeshStandardMaterial; sm.color.setHex(0x9fd0ff); sm.transparent = true; sm.opacity = 0.55; sm.roughness = 0.12; sm.metalness = 0; sm.emissive = new THREE.Color(0xdff3ff); sm.userData.glow = { day: 0.05, night: 0.7 }; this.glowMats.push(sm) } })
    group.userData.labelY = top + 0.6
    return true
  }

  /** Once the kit is in: rebuild buildings, swap the rocks outside and the rovers. */
  onKitLoaded() {
    for (const v of this.builds.values()) this.scene.remove(v.group)
    this.builds.clear()
    this.refreshBuildings()
    if (this.rocks) this.rocks.visible = false
    this.kitRocks.clear()
    const w = this.world, cx = w.w / 2, cz = w.h / 2, R = 36
    const names = ['rock', 'rock_largeA', 'rock_largeB', 'rocks_smallA', 'rocks_smallB', 'meteor', 'meteor_half', 'rock_crystals', 'rock_crystalsLargeA', 'craterLarge']
    for (let i = 0; i < 120; i++) {
      const name = names[Math.floor(hash(i, 23) * names.length)]
      const m = kitInstance(name), mm = kitMeasure(name)
      if (!m || !mm) continue
      const a = hash(i, 7) * Math.PI * 2, d = R + 4 + hash(i, 3) * 90
      const sc = (0.8 + hash(i, 11) * 2.2) / Math.max(0.5, mm.size.x)
      m.scale.setScalar(sc)
      m.position.set(cx + Math.cos(a) * d, -mm.min.y * sc - 0.02, cz + Math.sin(a) * d)
      m.rotation.y = hash(i, 5) * Math.PI * 2
      if (name.includes('crystals')) m.traverse(o => { const mesh = o as THREE.Mesh; if (mesh.isMesh) { const mat = mesh.material as THREE.MeshStandardMaterial; if (mat.color && mat.color.r > 0.5 && mat.color.g < 0.7) { mat.emissive = new THREE.Color(0xff7a3a); mat.emissiveIntensity = 0.8 } } })
      this.kitRocks.add(m)
    }
    // the airlock gate at the exit
    const exit = w.places.exit?.[0]
    const gate = kitInstance('gate_simple'), gm = kitMeasure('gate_simple')
    if (exit && gate && gm) { const sc = 2.6 / Math.max(gm.size.x, gm.size.z); gate.scale.setScalar(sc); gate.position.set(exit.x + 0.5, -gm.min.y * sc, exit.y + 0.5); gate.rotation.y = Math.PI / 2; this.kitRocks.add(gate) }
    if (!this.kitRocks.parent) this.scene.add(this.kitRocks)
    for (const r of this.rovers) this.roverPool.remove(r)
    this.rovers = []
    if (this.regionView) this.syncRovers(this.regionView)
  }

  // ───────── buildings ─────────
  buildKey(b: Building) { return `${b.site ? 's' : 'b'}${b.burned ? 'x' : ''}${b.site ? Math.round((b.progress ?? 0) * 20) : ''}` }

  addBuilding(b: Building) {
    const old = this.builds.get(b.id)
    if (old) { this.scene.remove(old.group); old.group.traverse(o => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose() }) }
    const group = new THREE.Group()
    const W = b.w, D = b.h
    const cx = b.x + W / 2, cz = b.y + D / 2
    group.position.set(cx, 0, cz)
    const windows: THREE.MeshStandardMaterial[] = []
    const doorSide = b.door.y >= b.y + b.h ? 'front' : b.door.y < b.y ? 'back' : b.door.x < b.x ? 'left' : 'right'
    const wallH = WALL_H[b.type] ?? 1
    const wallColor = b.burned && !b.site ? 0x3a3330 : WALL[b.type] ?? 0xd9c6a5
    const roofColor = b.type === 'house' ? [0xa0533c, 0x8c5a3a, 0x7d4a4a, 0x9a6a3a][Math.floor(hash(b.x, b.y) * 4)] : ROOF[b.type]

    if (this.kitReady && this.useKit && !b.site && !b.burned && this.addKit(group, b, W, D, windows)) {
      // assembled from the glTF kit
    } else if (b.site) {
      const p = b.progress ?? 0
      const slab = new THREE.Mesh(new THREE.BoxGeometry(W - 0.1, 0.12, D - 0.1), new THREE.MeshStandardMaterial({ color: b.reason === 'rebuild' ? 0x3a3532 : 0x6e5e3f, roughness: 1 }))
      slab.position.y = 0.06
      group.add(slab)
      const frameH = Math.max(0.05, Math.min(1, p / 0.7)) * wallH
      const frame = new THREE.Mesh(new THREE.BoxGeometry(W - 0.25, frameH, D - 0.25), new THREE.MeshStandardMaterial({ color: 0x9a7a52, roughness: 1 }))
      frame.position.y = 0.12 + frameH / 2
      frame.castShadow = true
      group.add(frame)
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, wallH + 0.3, 0.14), new THREE.MeshStandardMaterial({ color: 0x6a4a2f }))
        post.position.set(sx * (W / 2 - 0.15), (wallH + 0.3) / 2 + 0.12, sz * (D / 2 - 0.15))
        post.visible = p > 0.1
        group.add(post)
      }
      if (p > 0.7) {
        const a = (p - 0.7) / 0.3
        const roof = new THREE.Mesh(W >= D ? gableGeometry(W + 0.3, D + 0.3, 0.7 * a) : gableGeometry(D + 0.3, W + 0.3, 0.7 * a), new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.9, transparent: true, opacity: 0.5 + a * 0.5 }))
        if (W < D) roof.rotation.y = Math.PI / 2
        roof.position.y = 0.12 + wallH
        group.add(roof)
      }
      // log pile
      for (let i = 0; i < 3; i++) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.2, 6), new THREE.MeshStandardMaterial({ color: 0x8a6a45 }))
        log.rotation.z = Math.PI / 2
        log.position.set(W / 2 + 0.5, 0.1 + i * 0.18, -0.3 + i * 0.1)
        group.add(log)
      }
      // progress bar
      const bar = new THREE.Mesh(new THREE.BoxGeometry(W * p, 0.05, 0.1), new THREE.MeshStandardMaterial({ color: 0xf0a742, emissive: 0xf0a742, emissiveIntensity: 0.9 }))
      bar.position.set(-W / 2 + (W * p) / 2, 0.15, D / 2 + 0.25)
      group.add(bar)
    } else if (b.type === 'house' && !b.burned) {
      this.addPod(group, b, W, D, windows, ACCENT[Math.floor(hash(b.x, b.y) * ACCENT.length)])
    } else if (!b.burned && b.type !== 'house') {
      this.addPublic(group, b, W, D, windows)
    } else if (b.type === 'market') {
      const posts = new THREE.MeshStandardMaterial({ color: 0x5a6270, metalness: 0.5, roughness: 0.5 })
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.12, wallH, 0.12), posts); p.position.set(sx * (W / 2 - 0.2), wallH / 2, sz * (D / 2 - 0.2)); group.add(p) }
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(W + 0.3, 0.1, D + 0.3), new THREE.MeshStandardMaterial({ color: 0xff8c3a, roughness: 0.6 }))
      canopy.position.y = wallH; group.add(canopy)
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(W + 0.32, 0.04, 0.12), new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0xffb347, emissiveIntensity: 0.6 }))
      stripe.position.set(0, wallH + 0.02, D / 2 + 0.12); group.add(stripe)
      const crateMat = new THREE.MeshStandardMaterial({ color: 0x6f7780, roughness: 0.7, metalness: 0.3 })
      const crateA = new THREE.MeshStandardMaterial({ color: 0xffb347, roughness: 0.7 })
      const crates = [[-1.2, 0.3, 0.6, 0.6, crateMat], [-0.5, 0.25, 0.5, 0.5, crateA], [-1.2, 0.9, 0.5, 0.5, crateA], [0.6, 0.3, 0.6, 0.6, crateMat], [1.2, 0.25, 0.5, 0.5, crateMat], [0.7, 0.9, 0.5, 0.5, crateA]] as const
      for (const [x, y, sw, sh, m] of crates) { const c = new THREE.Mesh(new THREE.BoxGeometry(sw, sh, sw), m); c.position.set(x, y, 0); group.add(c) }
      const counter = new THREE.Mesh(new THREE.BoxGeometry(W - 0.6, 0.45, 0.4), new THREE.MeshStandardMaterial({ color: 0x8b939e, metalness: 0.4 }))
      counter.position.set(0, 0.22, D / 2 - 0.4); group.add(counter)
      const screen = new THREE.MeshStandardMaterial({ color: 0x0a2a3a, emissive: 0x58c4ff, emissiveIntensity: 0.9 })
      const sc = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 0.05), screen); sc.position.set(0, wallH - 0.35, D / 2 + 0.12); group.add(sc)
      windows.push(screen)
    } else {
      const accent = b.type === 'house' ? ACCENT[Math.floor(hash(b.x, b.y) * ACCENT.length)] : TYPE_ACCENT[b.type] ?? 0x5cc8ff
      const isCyl = b.type === 'mill'
      const wallGeo = isCyl ? new THREE.CylinderGeometry(Math.min(W, D) * 0.42, Math.min(W, D) * 0.48, wallH, 16) : new THREE.BoxGeometry(W - 0.15, wallH, D - 0.15)
      const seed = hash(b.x * 11 + 1, b.y * 17 + 3)
      const label = b.type === 'house' ? `M-${b.id.replace(/\D/g, '').padStart(2, '0')}` : b.type === 'mill' ? 'RX-1' : b.type === 'forge' ? 'SHOP' : b.type === 'guard' ? 'SEC' : undefined
      const hazard = b.type === 'forge' || b.type === 'mill'
      const wallMat = (units: number) => {
        const t = wallTexture({ type: b.type, wUnits: units, hUnits: wallH, base: wallColor, accent, seed, label, hazard })
        return new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(0.7, 0.7), roughnessMap: t.rough, roughness: 1, metalness: 0.22, envMapIntensity: 0.8 })
      }
      const plain = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.7, metalness: 0.2 })
      let wallMaterial: THREE.Material | THREE.Material[]
      if (isCyl) wallMaterial = wallMat(Math.PI * Math.min(W, D) * 0.9)
      else if (b.burned) wallMaterial = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.95 })
      else { const mx = wallMat(D - 0.15), mz = wallMat(W - 0.15); wallMaterial = [mx, mx, plain, plain, mz, mz] }
      const walls = new THREE.Mesh(wallGeo, wallMaterial)
      walls.position.y = wallH / 2
      group.add(walls)
      // base skirt
      const skirt = new THREE.Mesh(isCyl ? new THREE.CylinderGeometry(Math.min(W, D) * 0.52, Math.min(W, D) * 0.52, 0.18, 12) : new THREE.BoxGeometry(W - 0.02, 0.18, D - 0.02), new THREE.MeshStandardMaterial({ color: 0x4a515a, roughness: 0.6, metalness: 0.4 }))
      skirt.position.y = 0.09
      group.add(skirt)
      if (!b.burned) {
        // accent stripe around the walls
        const stripe = new THREE.Mesh(isCyl ? new THREE.CylinderGeometry(Math.min(W, D) * 0.43, Math.min(W, D) * 0.43, 0.08, 12) : new THREE.BoxGeometry(W - 0.11, 0.08, D - 0.11), new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.35 }))
        stripe.position.y = wallH * 0.82
        group.add(stripe)
        // flat roof slab
        const rt = roofTexture(W, D, roofColor, seed)
        const roofMat = new THREE.MeshStandardMaterial({ map: rt.map, normalMap: rt.normal, normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: rt.rough, roughness: 1, metalness: 0.3, envMapIntensity: 0.8 })
        const roofSide = new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.6, metalness: 0.3 })
        const roof = new THREE.Mesh(isCyl ? new THREE.CylinderGeometry(Math.min(W, D) * 0.46, Math.min(W, D) * 0.46, 0.14, 16) : new THREE.BoxGeometry(W - 0.05, 0.14, D - 0.05), isCyl ? roofMat : [roofSide, roofSide, roofMat, roofSide, roofSide, roofSide])
        roof.position.y = wallH + 0.07
        group.add(roof)
        // roof gear: solar panel + vent
        if (!isCyl && b.type !== 'church') {
          const panel = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.8, W - 1.2), 0.06, Math.max(0.6, D - 1.4)), new THREE.MeshStandardMaterial({ color: 0x14345a, roughness: 0.2, metalness: 0.6 }))
          panel.position.set(-0.15, wallH + 0.2, 0.1)
          panel.rotation.x = -0.12
          group.add(panel)
          const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.35, 8), new THREE.MeshStandardMaterial({ color: 0x8b939e, metalness: 0.5, roughness: 0.4 }))
          vent.position.set(W / 2 - 0.4, wallH + 0.3, -D / 2 + 0.4)
          group.add(vent)
        }
      } else {
        for (let i = 0; i < 5; i++) {
          const beam = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, D - 0.3), new THREE.MeshStandardMaterial({ color: 0x1f1b19 }))
          beam.position.set(-W / 2 + 0.3 + i * (W - 0.6) / 4, wallH + 0.1 + hash(i, b.x) * 0.3, 0)
          beam.rotation.z = (hash(i, b.y) - 0.5) * 0.6
          group.add(beam)
        }
      }
      // door
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.08), new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.5, roughness: 0.4 }))
      const dx = b.door.x + 0.5 - cx, dz = b.door.y + 0.5 - cz
      if (doorSide === 'front') door.position.set(THREE.MathUtils.clamp(dx, -W / 2 + 0.4, W / 2 - 0.4), 0.4, D / 2 - 0.06)
      else if (doorSide === 'back') door.position.set(THREE.MathUtils.clamp(dx, -W / 2 + 0.4, W / 2 - 0.4), 0.4, -D / 2 + 0.06)
      else if (doorSide === 'left') { door.position.set(-W / 2 + 0.06, 0.4, THREE.MathUtils.clamp(dz, -D / 2 + 0.4, D / 2 - 0.4)); door.rotation.y = Math.PI / 2 }
      else { door.position.set(W / 2 - 0.06, 0.4, THREE.MathUtils.clamp(dz, -D / 2 + 0.4, D / 2 - 0.4)); door.rotation.y = Math.PI / 2 }
      group.add(door)
      const doorLight = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.4 })
      const dl = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.05), doorLight)
      dl.position.copy(door.position); dl.position.y = 0.86; dl.rotation.copy(door.rotation)
      group.add(dl)
      windows.push(doorLight)
      // window strips on front & back
      if (!b.burned && !isCyl) {
        const n = Math.max(1, W - 1)
        for (const side of [1, -1]) for (let i = 0; i < n; i++) {
          const wx = -W / 2 + (i + 1) * (W / (n + 1))
          if (Math.abs(wx - door.position.x) < 0.5 && ((side === 1 && doorSide === 'front') || (side === -1 && doorSide === 'back'))) continue
          const mat = new THREE.MeshStandardMaterial({ color: 0x1d2b3a, emissive: 0xffb04a, emissiveIntensity: 0, roughness: 0.2, metalness: 0.2 })
          const win = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.26, 0.06), mat)
          win.position.set(wx, wallH * 0.5, side * (D / 2 - 0.06))
          group.add(win)
          windows.push(mat)
        }
      }
      // type details
      if (b.type === 'church') {
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 2.4, 6), new THREE.MeshStandardMaterial({ color: 0xb8c0c8, metalness: 0.7, roughness: 0.3 }))
        mast.position.y = wallH + 1.2; group.add(mast)
        const beaconM = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdff3ff, emissiveIntensity: 2.2 })
        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), beaconM); beacon.position.y = wallH + 2.45; group.add(beacon)
        const halo = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.03, 6, 32), new THREE.MeshStandardMaterial({ color: 0xdff3ff, emissive: 0xdff3ff, emissiveIntensity: 1.2 }))
        halo.rotation.x = Math.PI / 2; halo.position.y = wallH + 1.9; group.add(halo)
        const glass = new THREE.Mesh(new THREE.BoxGeometry(W - 0.6, 0.6, D - 0.6), new THREE.MeshPhysicalMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.35, roughness: 0.1 }))
        glass.position.y = wallH + 0.4; group.add(glass)
      }
      if (b.type === 'mill') {
        const r0 = Math.min(W, D) * 0.48
        for (let i = 0; i < 6; i++) {
          const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, wallH * 0.8, 0.5), new THREE.MeshStandardMaterial({ color: 0x5a6270, metalness: 0.6, roughness: 0.4 }))
          const a = (i / 6) * Math.PI * 2
          fin.position.set(Math.cos(a) * (r0 + 0.2), wallH * 0.45, Math.sin(a) * (r0 + 0.2)); fin.rotation.y = -a
          group.add(fin)
        }
        const core = new THREE.Mesh(new THREE.CylinderGeometry(r0 * 0.5, r0 * 0.5, 0.5, 12), new THREE.MeshStandardMaterial({ color: 0x0a2a3a, emissive: 0x58c4ff, emissiveIntensity: 1.6 }))
        core.position.y = wallH + 0.3; group.add(core)
        const ringR = new THREE.Mesh(new THREE.TorusGeometry(r0 * 0.9, 0.06, 8, 40), new THREE.MeshStandardMaterial({ color: 0x58c4ff, emissive: 0x58c4ff, emissiveIntensity: 1.4 }))
        ringR.rotation.x = Math.PI / 2; ringR.position.y = wallH + 0.7; ringR.name = 'sails'
        group.add(ringR)
      }
      if (b.type === 'tavern') {
        const signM = new THREE.MeshStandardMaterial({ color: 0xff4fd8, emissive: 0xff4fd8, emissiveIntensity: 1.5 })
        const sign = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.28, 0.06), signM)
        sign.position.set(0, wallH + 0.45, D / 2 + 0.05); group.add(sign)
        const pole = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.4, 0.06), new THREE.MeshStandardMaterial({ color: 0x5a6270 })); pole.position.set(0, wallH + 0.2, D / 2 + 0.05); group.add(pole)
        windows.push(signM)
      }
      if (b.type === 'forge') {
        const glow = new THREE.MeshStandardMaterial({ color: 0xff6a2a, emissive: 0xff5a1a, emissiveIntensity: 1.2 })
        const gm = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.7, 0.06), glow); gm.position.set(W / 2 - 0.9, 0.42, D / 2 - 0.04); group.add(gm)
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.4, 8), new THREE.MeshStandardMaterial({ color: 0x8b939e, metalness: 0.6 })); pipe.position.set(-W / 2 + 0.3, wallH + 0.5, -D / 2 + 0.3); group.add(pipe)
      }
      if (b.type === 'guard') {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 6), new THREE.MeshStandardMaterial({ color: 0x8b939e })); pole.position.set(W / 2 - 0.4, wallH + 0.7, 0); group.add(pole)
        const beaconM = new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0xff2a2a, emissiveIntensity: 1.6 })
        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), beaconM); beacon.position.set(W / 2 - 0.4, wallH + 1.35, 0); beacon.name = 'beacon'; group.add(beacon)
      }
      if (b.type === 'school') {
        const dish = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.15, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0xdfe4e8, side: THREE.DoubleSide }))
        dish.position.set(-W / 2 + 0.6, wallH + 0.55, 0); dish.rotation.x = -0.9; group.add(dish)
      }
      if (b.type === 'bakery') {
        for (let i = 0; i < 2; i++) { const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 8), new THREE.MeshStandardMaterial({ color: 0xb8c0c8, metalness: 0.6 })); pipe.position.set(-W / 2 + 0.4 + i * 0.35, wallH + 0.35, D / 2 - 0.4); group.add(pipe) }
      }
    }
    if (false) this.addGreebles(group, b, W, D, WALL_H[b.type] ?? 1, b.type === 'house' ? ACCENT[Math.floor(hash(b.x, b.y) * ACCENT.length)] : TYPE_ACCENT[b.type] ?? 0x5cc8ff)
    group.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true } })
    // label
    let label: THREE.Sprite | null = null
    const isHouse = b.type === 'house'
    const text = b.site ? (b.reason === 'rebuild' ? 'rebuilding' : 'construction') : isHouse ? (b.family ?? '') : b.name
    if (text) {
      label = makeSprite(text, { font: isHouse ? '500 30px "IBM Plex Mono", monospace' : '32px "Rubik Mono One", monospace', size: isHouse ? 30 : 32, color: isHouse ? '#ffd98a' : '#ffb84a', stroke: 'rgba(8,8,6,0.9)' }, isHouse ? 0.62 : 0.85)
      label.position.set(0, group.userData.labelY ?? (b.site ? 0.6 : (PUBLIC_LABEL_Y[b.type] ?? wallH + 1.1) + (b.type === 'house' && !b.burned ? 0.9 : 0)), 0)
      label.material.opacity = isHouse ? 0.8 : 0.95
      group.add(label)
    }
    const lights: THREE.PointLight[] = []
    if (!b.site && !b.burned) {
      const neon: Partial<Record<string, [number, number, number]>> = { tavern: [0xff4fd8, 7, 9], forge: [0xff6a2a, 4, 7], mill: [0x58c4ff, 6, 10], church: [0xdff3ff, 3, 9], market: [0xffb347, 3, 8], guard: [0xff3b3b, 2, 6] }
      const spec = neon[b.type]
      if (spec) {
        const l = new THREE.PointLight(spec[0], 0, spec[2], 1.7)
        l.position.set(0, wallH + 0.6, D / 2 + 0.8)
        if (b.type === 'mill') l.position.set(0, wallH + 1, 0)
        group.add(l); lights.push(l)
        ;(l as unknown as { peak: number }).peak = spec[1]
      }
    }
    this.scene.add(group)
    this.builds.set(b.id, { id: b.id, group, windows, lights, label, key: this.buildKey(b) })
  }

  // ───────── habitat pods ─────────
  /** A family habitat: rounded hull, barrel roof with ribs, portholes, airlock, lit interiors, extensions and signs of life. */
  addPod(group: THREE.Group, b: Building, W: number, D: number, windows: THREE.MeshStandardMaterial[], accent: number) {
    const r = ((): (() => number) => { let a = Math.floor(hash(b.x * 7 + 5, b.y * 3 + 11) * 1e6) | 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } })()
    const doorSide = b.door.y >= b.y + b.h ? 'front' : b.door.y < b.y ? 'back' : b.door.x < b.x ? 'left' : 'right'
    const cx = b.x + W / 2, cz = b.y + D / 2
    const add = (m: THREE.Object3D) => { m.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true } }); group.add(m) }
    const age = r() // 0 new … 1 old
    const hullColor = new THREE.Color(0xcdc7bd).lerp(new THREE.Color(0x9d968a), age * 0.7).getHex()
    const hull = new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.62 + age * 0.3, metalness: 0.1, envMapIntensity: 0.5 })
    const accentMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5, metalness: 0.4 })
    const glowMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.6 })
    const dark = this.metalDark
    const along = W >= D // barrel axis along x when wider than deep
    const L = (along ? W : D) - 0.3, S = (along ? D : W) - 0.3
    const bodyH = 0.72
    // skirt + lower hull
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(W - 0.05, 0.14, D - 0.05), dark); skirt.position.y = 0.07; add(skirt)
    const body = new THREE.Mesh(new RoundedBoxGeometry(W - 0.3, bodyH, D - 0.3, 3, 0.14), hull)
    body.position.y = 0.14 + bodyH / 2; add(body)
    // hull texture strip: panel seams around the lower hull
    const seamTex = wallTexture({ type: 'house', wUnits: L, hUnits: bodyH, base: hullColor, accent, seed: age })
    const band = new THREE.Mesh(new THREE.BoxGeometry(W - 0.29, bodyH - 0.2, D - 0.29), new THREE.MeshStandardMaterial({ map: seamTex.map, normalMap: seamTex.normal, normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: seamTex.rough, roughness: 1, metalness: 0.15, transparent: true, opacity: 0.9 }))
    band.position.y = 0.14 + bodyH / 2; add(band)
    // barrel roof
    const rad = S / 2
    const ySq = 0.62
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, L, 24, 1, false, 0, Math.PI), hull)
    barrel.rotation.z = Math.PI / 2; if (!along) barrel.rotation.y = Math.PI / 2
    barrel.rotation.order = 'YZX'
    barrel.scale.set(1, 1, ySq); barrel.position.y = 0.14 + bodyH
    // cylinder with thetaLength π opens the half toward +x after rotation; orient so the curved side faces up
    barrel.rotation.set(0, along ? 0 : Math.PI / 2, Math.PI / 2, 'YZX')
    barrel.scale.set(1, 1, 1)
    add(barrel)
    const topY = 0.14 + bodyH + rad * 0.98
    // ribs along the barrel
    const ribs = 3 + Math.floor(r() * 2)
    for (let i = 0; i < ribs; i++) {
      const rib = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.03, rad * 1.03, 0.1, 24, 1, true, 0, Math.PI), i === Math.floor(ribs / 2) ? glowMat : dark)
      rib.rotation.set(0, along ? 0 : Math.PI / 2, Math.PI / 2, 'YZX')
      const t = -L / 2 + (i + 0.5) * (L / ribs)
      rib.position.set(along ? t : 0, 0.14 + bodyH, along ? 0 : t)
      add(rib)
    }
    // solar strip on top of the barrel
    const strip = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.02, rad * 1.02, L * 0.55, 24, 1, true, Math.PI * 0.35, Math.PI * 0.3), new THREE.MeshStandardMaterial({ color: 0x14345a, roughness: 0.25, metalness: 0.6, side: THREE.DoubleSide }))
    strip.rotation.set(0, along ? 0 : Math.PI / 2, Math.PI / 2, 'YZX'); strip.position.y = 0.14 + bodyH; add(strip)
    // portholes on the long sides of the lower hull, lit interiors
    const winMat = (k: number) => { const t = windowTexture(k); const m = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.15, roughness: 0.2, metalness: 0.1 }); windows.push(m); return m }
    const nWin = Math.max(1, Math.round(L / 1.1))
    for (const side of [1, -1]) {
      for (let i = 0; i < nWin; i++) {
        const t = -L / 2 + (i + 0.5) * (L / nWin)
        const px = along ? t : side * (S / 2 + 0.02), pz = along ? side * (S / 2 + 0.02) : t
        const isDoorWall = (along && ((side === 1 && doorSide === 'front') || (side === -1 && doorSide === 'back'))) || (!along && ((side === 1 && doorSide === 'right') || (side === -1 && doorSide === 'left')))
        const doorT = along ? b.door.x + 0.5 - cx : b.door.y + 0.5 - cz
        if (isDoorWall && Math.abs(t - doorT) < 0.7) continue
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.03, 8, 20), dark)
        const glass = new THREE.Mesh(new THREE.CircleGeometry(0.17, 20), winMat(Math.floor(r() * 5)))
        for (const m of [ring, glass]) { m.position.set(px, 0.14 + bodyH * 0.55, pz); if (along) { m.rotation.y = side > 0 ? 0 : Math.PI } else { m.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2 } }
        add(ring); group.add(glass)
      }
    }
    // big round window on the barrel ends
    for (const end of [1, -1]) {
      const isDoorEnd = (along && ((end === 1 && doorSide === 'right') || (end === -1 && doorSide === 'left'))) || (!along && ((end === 1 && doorSide === 'front') || (end === -1 && doorSide === 'back')))
      if (isDoorEnd) continue
      const px = along ? end * (L / 2 + 0.02) : 0, pz = along ? 0 : end * (L / 2 + 0.02)
      const ring = new THREE.Mesh(new THREE.TorusGeometry(rad * 0.42, 0.035, 8, 24), dark)
      const glass = new THREE.Mesh(new THREE.CircleGeometry(rad * 0.4, 24), winMat(Math.floor(r() * 5)))
      for (const m of [ring, glass]) { m.position.set(px, 0.14 + bodyH + rad * 0.42, pz); m.rotation.y = along ? (end > 0 ? Math.PI / 2 : -Math.PI / 2) : (end > 0 ? 0 : Math.PI) }
      add(ring); group.add(glass)
    }
    // airlock on the door side
    const dx = b.door.x + 0.5 - cx, dz = b.door.y + 0.5 - cz
    const lock = new THREE.Group()
    const lockBody = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.95, 0.5, 2, 0.1), hull); lockBody.position.y = 0.14 + 0.475; lock.add(lockBody)
    const doorPanel = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.78, 0.06), dark); doorPanel.position.set(0, 0.14 + 0.42, 0.26); lock.add(doorPanel)
    const doorLight = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.05, 0.05), glowMat); doorLight.position.set(0, 0.14 + 0.9, 0.27); lock.add(doorLight)
    const mat = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.03, 0.4), new THREE.MeshStandardMaterial({ color: 0x4a3f36, roughness: 1 })); mat.position.set(0, 0.015, 0.55); lock.add(mat)
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.03), new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.9 })); plate.position.set(0.36, 0.14 + 0.75, 0.26); lock.add(plate)
    if (doorSide === 'front') { lock.position.set(THREE.MathUtils.clamp(dx, -W / 2 + 0.6, W / 2 - 0.6), 0, D / 2 - 0.35) }
    else if (doorSide === 'back') { lock.position.set(THREE.MathUtils.clamp(dx, -W / 2 + 0.6, W / 2 - 0.6), 0, -D / 2 + 0.35); lock.rotation.y = Math.PI }
    else if (doorSide === 'left') { lock.position.set(-W / 2 + 0.35, 0, THREE.MathUtils.clamp(dz, -D / 2 + 0.6, D / 2 - 0.6)); lock.rotation.y = -Math.PI / 2 }
    else { lock.position.set(W / 2 - 0.35, 0, THREE.MathUtils.clamp(dz, -D / 2 + 0.6, D / 2 - 0.6)); lock.rotation.y = Math.PI / 2 }
    add(lock)
    // planters by the airlock
    if (r() < 0.7) {
      const pl = new THREE.Group()
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.13, 0.26, 8), dark); pot.position.y = 0.13; pl.add(pot)
      const bush = new THREE.Mesh(new THREE.SphereGeometry(0.19, 8, 6), new THREE.MeshStandardMaterial({ color: [0x3f8a4c, 0x5aa86a, 0x7fc5a0][Math.floor(r() * 3)], roughness: 0.9, flatShading: true })); bush.position.y = 0.36; pl.add(bush)
      pl.position.copy(lock.position); pl.position.x += doorSide === 'front' || doorSide === 'back' ? 0.62 : 0; pl.position.z += doorSide === 'left' || doorSide === 'right' ? 0.62 : 0
      add(pl)
    }
    // extension on a side that is not the door side
    const sides = (['front', 'back', 'left', 'right'] as const).filter(sd => sd !== doorSide)
    const extSide = sides[Math.floor(r() * sides.length)]
    const extPos = (depth: number) => extSide === 'front' ? new THREE.Vector3(0, 0, D / 2 + depth / 2 - 0.1) : extSide === 'back' ? new THREE.Vector3(0, 0, -D / 2 - depth / 2 + 0.1) : extSide === 'left' ? new THREE.Vector3(-W / 2 - depth / 2 + 0.1, 0, 0) : new THREE.Vector3(W / 2 + depth / 2 - 0.1, 0, 0)
    const extRot = extSide === 'front' ? 0 : extSide === 'back' ? Math.PI : extSide === 'left' ? -Math.PI / 2 : Math.PI / 2
    const kind = Math.floor(r() * 4)
    const ext = new THREE.Group()
    if (kind === 0) { // annex pod
      const an = new THREE.Mesh(new RoundedBoxGeometry(1.3, 0.7, 0.7, 2, 0.12), hull); an.position.y = 0.14 + 0.35; ext.add(an)
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 1.3, 16, 1, false, 0, Math.PI), hull); cap.rotation.set(0, 0, Math.PI / 2, 'YZX'); cap.position.y = 0.14 + 0.7; ext.add(cap)
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.8, 6), this.metal); ant.position.set(0.45, 0.14 + 0.7 + 0.5, 0); ext.add(ant)
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0xff2a2a, emissiveIntensity: 1.5 })); tip.position.set(0.45, 0.14 + 0.7 + 0.92, 0); tip.name = 'blink'; ext.add(tip)
    } else if (kind === 1) { // terrace with an awning and laundry
      const deck = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.8), this.metal); deck.position.y = 0.16; ext.add(deck)
      for (const sx of [-0.7, 0.7]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 6), dark); post.position.set(sx, 0.7, 0.3); ext.add(post) }
      const awning = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.04, 0.9), new THREE.MeshStandardMaterial({ color: accent, roughness: 0.8, side: THREE.DoubleSide })); awning.position.set(0, 1.25, 0.05); awning.rotation.x = 0.15; ext.add(awning)
      const rail = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.03, 0.03), this.metal); rail.position.set(0, 0.6, 0.38); ext.add(rail)
      const line = new THREE.Group()
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1.3, 4), dark); rope.rotation.z = Math.PI / 2; line.add(rope)
      for (let i = 0; i < 3; i++) { const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.3), new THREE.MeshStandardMaterial({ color: [accent, 0xf2eee6, 0x7fa5c9, 0xd98c9a][Math.floor(r() * 4)], side: THREE.DoubleSide, roughness: 0.9 })); cloth.position.set(-0.45 + i * 0.45, -0.17, 0); line.add(cloth) }
      line.position.set(0, 1.0, 0.25); line.name = 'laundry'; ext.add(line)
      const chair = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), accentMat); chair.position.set(-0.5, 0.35, -0.1); ext.add(chair)
    } else if (kind === 2) { // greenhouse
      const glass = new THREE.Mesh(new RoundedBoxGeometry(1.4, 0.8, 0.8, 2, 0.08), new THREE.MeshPhysicalMaterial({ color: 0x7fb8a6, transparent: true, opacity: 0.3, roughness: 0.25, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.4 })); glass.position.y = 0.14 + 0.4; ext.add(glass)
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.05, 0.82), this.metal); frame.position.y = 0.14 + 0.8; ext.add(frame)
      for (let i = 0; i < 4; i++) { const plant = new THREE.Mesh(new THREE.SphereGeometry(0.16, 7, 5), new THREE.MeshStandardMaterial({ color: [0x3f8a4c, 0x5aa86a, 0x7fc5a0][i % 3], roughness: 0.9, flatShading: true })); plant.position.set(-0.5 + i * 0.33, 0.14 + 0.35, (i % 2 ? 0.15 : -0.15)); ext.add(plant) }
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.03, 0.1), new THREE.MeshStandardMaterial({ color: 0xffb4e8, emissive: 0xff7ad0, emissiveIntensity: 1.2 })); lamp.position.y = 0.14 + 0.72; ext.add(lamp)
      windows.push(lamp.material as THREE.MeshStandardMaterial)
    } else { // second tier: a smaller pod on top
      const up = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.55, rad * 0.55, L * 0.55, 16, 1, false, 0, Math.PI), hull)
      up.rotation.set(0, along ? 0 : Math.PI / 2, Math.PI / 2, 'YZX'); up.position.set(along ? -L * 0.15 : 0, topY - 0.05, along ? 0 : -L * 0.15); add(up)
      const base = new THREE.Mesh(new THREE.BoxGeometry(along ? L * 0.55 : rad * 1.1, 0.12, along ? rad * 1.1 : L * 0.55), dark); base.position.copy(up.position); base.position.y -= 0.06; add(base)
      const win = new THREE.Mesh(new THREE.CircleGeometry(rad * 0.22, 16), winMat(2)); win.position.copy(up.position); win.position.y += rad * 0.22; if (along) { win.position.x += L * 0.28; win.rotation.y = Math.PI / 2 } else { win.position.z += L * 0.28 }; group.add(win)
    }
    if (kind !== 3) { ext.position.copy(extPos(0.8)); ext.rotation.y = extRot; add(ext) }
    // vent with a puff of steam on one end of the barrel
    const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.3, 8), dark); vent.position.set(along ? L / 2 - 0.35 : 0.3, topY - 0.05, along ? 0.3 : L / 2 - 0.35); add(vent)
    // rust and patches on old pods
    if (age > 0.6) for (let i = 0; i < 3; i++) {
      const patch = new THREE.Mesh(new THREE.BoxGeometry(0.3 + r() * 0.3, 0.25, 0.02), new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 1, metalness: 0.3 }))
      const side = r() < 0.5 ? 1 : -1
      if (along) patch.position.set(-L / 2 + r() * L, 0.14 + 0.2 + r() * 0.3, side * (S / 2 + 0.01)); else { patch.position.set(side * (S / 2 + 0.01), 0.14 + 0.2 + r() * 0.3, -L / 2 + r() * L); patch.rotation.y = Math.PI / 2 }
      add(patch)
    }
  }

  // ───────── public buildings ─────────
  winMat(windows: THREE.MeshStandardMaterial[], kind: number, dayGlow = 0.15) {
    const t = windowTexture(kind)
    const m = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: dayGlow, roughness: 0.2, metalness: 0.1 })
    windows.push(m)
    return m
  }
  glowMaterial(color: number, day: number, night: number) {
    const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: day })
    m.userData.glow = { day, night }; m.userData.keep = true
    this.glowMats.push(m)
    return m
  }

  addPublic(group: THREE.Group, b: Building, W: number, D: number, windows: THREE.MeshStandardMaterial[]) {
    const r = ((): (() => number) => { let a = Math.floor(hash(b.x * 13 + 1, b.y * 17 + 9) * 1e6) | 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } })()
    const doorSide = b.door.y >= b.y + b.h ? 'front' : b.door.y < b.y ? 'back' : b.door.x < b.x ? 'left' : 'right'
    const cx = b.x + W / 2, cz = b.y + D / 2
    const add = (m: THREE.Object3D, shadow = true) => { m.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = shadow; o.receiveShadow = true } }); group.add(m) }
    const accent = TYPE_ACCENT[b.type] ?? 0x5cc8ff
    const composite = new THREE.MeshStandardMaterial({ color: 0xc9c3b8, roughness: 0.65, metalness: 0.1, envMapIntensity: 0.5 })
    const compositeDark = new THREE.MeshStandardMaterial({ color: 0x6f7780, roughness: 0.6, metalness: 0.3 })
    const accentMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5, metalness: 0.4 })
    const glow = this.glowMaterial(accent, 0.5, 1.8)
    const metal = this.metal, dark = this.metalDark
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(W - 0.05, 0.14, D - 0.05), dark); skirt.position.y = 0.07; add(skirt)
    // rotate the whole design so its "front" faces the door side
    const inner = new THREE.Group()
    const rot = doorSide === 'front' ? 0 : doorSide === 'back' ? Math.PI : doorSide === 'left' ? -Math.PI / 2 : Math.PI / 2
    inner.rotation.y = rot
    // dimensions in the rotated frame: fw across the door wall, fd depth
    const fw = doorSide === 'front' || doorSide === 'back' ? W : D, fd = doorSide === 'front' || doorSide === 'back' ? D : W
    const doorOff = doorSide === 'front' ? (b.door.x + 0.5 - cx) : doorSide === 'back' ? -(b.door.x + 0.5 - cx) : doorSide === 'left' ? (b.door.y + 0.5 - cz) : -(b.door.y + 0.5 - cz)
    const dx = THREE.MathUtils.clamp(doorOff, -fw / 2 + 0.7, fw / 2 - 0.7)
    const hazard = (len: number, y: number, z: number, x = 0) => { const n = Math.max(2, Math.round(len / 0.3)); for (let i = 0; i < n; i++) { const st = new THREE.Mesh(new THREE.BoxGeometry(len / n, 0.1, 0.04), new THREE.MeshStandardMaterial({ color: i % 2 ? 0x2b2b2b : 0xe0b83a, roughness: 0.7 })); st.position.set(x - len / 2 + (i + 0.5) * (len / n), y, z); inner.add(st) } }
    const stringLights = (x0: number, x1: number, y: number, z: number, n: number) => { const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, x1 - x0, 4), dark); rope.rotation.z = Math.PI / 2; rope.position.set((x0 + x1) / 2, y, z); inner.add(rope); for (let i = 0; i < n; i++) { const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), this.glowMaterial([0xffb347, 0xff6fd8, 0x5fd8ff][i % 3], 0.4, 2.2)); bulb.position.set(x0 + (i + 0.5) * ((x1 - x0) / n), y - 0.06 - Math.sin(i) * 0.02, z); inner.add(bulb) } }

    switch (b.type) {
      case 'mill': { // reactor tower
        const R = Math.min(fw, fd) * 0.36
        const tower = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.12, 3.1, 20), composite); tower.position.y = 0.14 + 1.55; inner.add(tower)
        for (let i = 0; i < 8; i++) { const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.6, 0.42), compositeDark); const a = (i / 8) * Math.PI * 2; fin.position.set(Math.cos(a) * (R + 0.15), 0.14 + 1.45, Math.sin(a) * (R + 0.15)); fin.rotation.y = -a; inner.add(fin) }
        for (const y of [0.9, 1.9, 2.9]) { const ring = new THREE.Mesh(new THREE.TorusGeometry(R + 0.22, 0.05, 8, 40), this.glowMaterial(0x58c4ff, 0.7, 2.2)); ring.rotation.x = Math.PI / 2; ring.position.y = 0.14 + y; inner.add(ring) }
        for (let i = 0; i < 6; i++) { const slit = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.4, 0.06), this.glowMaterial(0x9fe8ff, 0.9, 2.6)); const a = (i / 6) * Math.PI * 2 + 0.4; slit.position.set(Math.cos(a) * (R + 0.02), 0.14 + 1.6, Math.sin(a) * (R + 0.02)); slit.rotation.y = -a + Math.PI / 2; inner.add(slit) }
        const cap = new THREE.Mesh(new THREE.SphereGeometry(R * 0.95, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), compositeDark); cap.position.y = 0.14 + 3.1; inner.add(cap)
        const halo = new THREE.Mesh(new THREE.TorusGeometry(R * 0.7, 0.06, 8, 40), this.glowMaterial(0x58c4ff, 1.0, 2.4)); halo.rotation.x = Math.PI / 2; halo.position.y = 0.14 + 3.55; halo.name = 'sails'; inner.add(halo)
        const core = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.9, 10), this.glowMaterial(0xdff8ff, 1.2, 3)); core.position.y = 0.14 + 3.75; inner.add(core)
        for (let i = 0; i < 3; i++) { const a = i * 2.1 + 0.5; const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.4, 8), metal); pipe.position.set(Math.cos(a) * (R + 0.7), 0.14 + 0.5, Math.sin(a) * (R + 0.7)); pipe.rotation.z = Math.PI / 2; pipe.rotation.y = -a; inner.add(pipe) }
        const base = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.55, R + 0.7, 0.3, 20), dark); base.position.y = 0.14 + 0.15; inner.add(base)
        hazard(R * 2 + 1.2, 0.14 + 0.32, R + 0.72)
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.95, 0.08), dark); door.position.set(dx * 0.3, 0.14 + 0.62, R + 0.7); inner.add(door)
        const dl = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.05, 0.05), glow); dl.position.set(dx * 0.3, 0.14 + 1.14, R + 0.72); inner.add(dl)
        break
      }
      case 'tavern': { // bar with a dome and a terrace
        const bw = fw - 0.3, bd = fd - 1.3, bh = 1.2
        const body = new THREE.Mesh(new RoundedBoxGeometry(bw, bh, bd, 3, 0.16), composite); body.position.set(0, 0.14 + bh / 2, -0.5); inner.add(body)
        const rib = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.04, 0.08, bd + 0.04), this.glowMaterial(0xff4fd8, 0.6, 1.8)); rib.position.set(0, 0.14 + bh * 0.82, -0.5); inner.add(rib)
        const dome = new THREE.Mesh(new THREE.SphereGeometry(Math.min(bw, bd) * 0.42, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: 0xff9ae8, transparent: true, opacity: 0.45, roughness: 0.15, envMapIntensity: 0.6 })); dome.position.set(0, 0.14 + bh, -0.5); inner.add(dome); this.noAO(dome)
        const domeRing = new THREE.Mesh(new THREE.TorusGeometry(Math.min(bw, bd) * 0.42, 0.05, 8, 32), dark); domeRing.rotation.x = Math.PI / 2; domeRing.position.set(0, 0.14 + bh, -0.5); inner.add(domeRing)
        // wide window strip with the bar interior
        const win = new THREE.Mesh(new THREE.BoxGeometry(bw - 1.2, 0.5, 0.06), this.winMat(windows, 1, 0.25)); win.position.set(0.3, 0.14 + 0.65, -0.5 + bd / 2 + 0.01); inner.add(win)
        const frame = new THREE.Mesh(new THREE.BoxGeometry(bw - 1.1, 0.58, 0.04), dark); frame.position.set(0.3, 0.14 + 0.65, -0.5 + bd / 2 - 0.01); inner.add(frame)
        // door on the front
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.95, 0.08), dark); door.position.set(dx, 0.14 + 0.48, -0.5 + bd / 2 + 0.02); inner.add(door)
        const dl = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.05, 0.05), glow); dl.position.set(dx, 0.14 + 1.0, -0.5 + bd / 2 + 0.04); inner.add(dl)
        // terrace
        const deckZ = -0.5 + bd / 2 + 0.6
        const deck = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.06, 1.1), metal); deck.position.set(0, 0.17, deckZ); inner.add(deck)
        for (const sx of [-bw / 2 + 0.15, bw / 2 - 0.15]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), dark); post.position.set(sx, 0.95, deckZ + 0.45); inner.add(post) }
        stringLights(-bw / 2 + 0.15, bw / 2 - 0.15, 1.7, deckZ + 0.45, 7)
        for (const tx of [-bw / 2 + 0.7, bw / 2 - 0.7]) {
          const table = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.06, 0.05, 10), metal); table.position.set(tx, 0.55, deckZ); inner.add(table)
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.35, 6), dark); leg.position.set(tx, 0.37, deckZ); inner.add(leg)
          for (const [ox, oz] of [[-0.35, 0], [0.35, 0], [0, 0.35]]) { const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.3, 8), accentMat); stool.position.set(tx + ox, 0.35, deckZ + oz); inner.add(stool) }
        }
        const rail = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.03, 0.03), metal); rail.position.set(0, 0.6, deckZ + 0.53); inner.add(rail)
        // neon sign + holo
        const sign = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.28, 0.06), this.glowMaterial(0xff4fd8, 1.2, 2.2)); sign.position.set(0, 0.14 + bh + 0.35, -0.5 + bd / 2 + 0.05); inner.add(sign)
        const pole = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.4, 0.06), dark); pole.position.set(0, 0.14 + bh + 0.15, -0.5 + bd / 2 + 0.05); inner.add(pole)
        const { tex, aspect } = textTexture('ORBIT BAR', { font: '700 64px "Rubik Mono One", monospace', size: 64, color: '#ff8af0', pad: 20 })
        const holo = new THREE.Mesh(new THREE.PlaneGeometry(1.8 * aspect * 0.32, 0.58), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, color: 0xff4fd8 }))
        holo.position.set(0, 0.14 + bh + 1.0, -0.5 + bd / 2 + 0.2); holo.name = 'holo'; this.noAO(holo); inner.add(holo)
        const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.4, 8), dark); vent.position.set(-bw / 2 + 0.5, 0.14 + bh + 0.2, -0.5 - bd / 2 + 0.5); inner.add(vent)
        break
      }
      case 'market': { // cargo hangar: barrel vault, ramp, crane, containers
        const bw = fw - 0.3, bd = fd - 0.3, wallH = 1.0
        for (const sx of [-1, 1]) { const wall = new THREE.Mesh(new THREE.BoxGeometry(0.2, wallH, bd), compositeDark); wall.position.set(sx * (bw / 2 - 0.1), 0.14 + wallH / 2, 0); inner.add(wall) }
        const back = new THREE.Mesh(new THREE.BoxGeometry(bw, wallH, 0.2), compositeDark); back.position.set(0, 0.14 + wallH / 2, -bd / 2 + 0.1); inner.add(back)
        const vault = new THREE.Mesh(new THREE.CylinderGeometry(bw / 2, bw / 2, bd, 24, 1, true, 0, Math.PI), composite); vault.rotation.set(0, Math.PI / 2, Math.PI / 2, 'YZX'); vault.scale.set(1, 1, 0.55); vault.rotation.set(0, Math.PI / 2, Math.PI / 2, 'YZX'); vault.position.y = 0.14 + wallH; inner.add(vault)
        const vaultEnd = new THREE.Mesh(new THREE.CircleGeometry(bw / 2, 24, 0, Math.PI), compositeDark); vaultEnd.position.set(0, 0.14 + wallH, -bd / 2); vaultEnd.scale.set(1, 0.55, 1); vaultEnd.rotation.y = Math.PI; inner.add(vaultEnd)
        for (let i = 0; i < 4; i++) { const rib = new THREE.Mesh(new THREE.CylinderGeometry(bw / 2 + 0.03, bw / 2 + 0.03, 0.1, 24, 1, true, 0, Math.PI), dark); rib.rotation.set(0, Math.PI / 2, Math.PI / 2, 'YZX'); rib.scale.set(1, 1, 0.55); rib.position.set(0, 0.14 + wallH, -bd / 2 + (i + 0.5) * (bd / 4)); inner.add(rib) }
        // rolling door half open
        const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(bw - 0.4, 0.5, 0.08), accentMat); doorFrame.position.set(0, 0.14 + wallH + bw * 0.55 * 0.5 - 0.25, bd / 2 - 0.05); doorFrame.scale.set(1, 1, 1); inner.add(doorFrame)
        hazard(bw - 0.4, 0.14 + wallH + 0.02, bd / 2 + 0.03)
        // ramp
        const ramp = new THREE.Mesh(new THREE.BoxGeometry(bw * 0.6, 0.12, 1.0), metal); ramp.position.set(0, 0.16, bd / 2 + 0.5); ramp.rotation.x = 0.1; inner.add(ramp)
        // crane beam with hook
        const beam = new THREE.Mesh(new THREE.BoxGeometry(bw - 0.6, 0.1, 0.16), accentMat); beam.position.set(0, 0.14 + wallH + 0.25, 0); inner.add(beam)
        const trolley = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.22), dark); trolley.position.set(bw * 0.2, 0.14 + wallH + 0.15, 0); inner.add(trolley)
        const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.5, 4), dark); cable.position.set(bw * 0.2, 0.14 + wallH - 0.15, 0); inner.add(cable)
        const hook = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.02, 6, 12), metal); hook.position.set(bw * 0.2, 0.14 + wallH - 0.42, 0); inner.add(hook)
        // containers inside and outside
        const cols = [0xff8c3a, 0x6f7780, 0x5cc8ff, 0xffd166, 0x7fe0a0]
        const crate = (x: number, y: number, z: number, w2: number, h2: number, d2: number, col: number, ry = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, d2), new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.35 })); m.position.set(x, y, z); m.rotation.y = ry; inner.add(m); const stripe = new THREE.Mesh(new THREE.BoxGeometry(w2 + 0.01, 0.05, d2 + 0.01), dark); stripe.position.set(x, y, z); stripe.rotation.y = ry; inner.add(stripe) }
        crate(-bw / 2 + 0.7, 0.14 + 0.3, -bd / 2 + 0.7, 0.9, 0.6, 0.6, cols[0]); crate(-bw / 2 + 0.7, 0.14 + 0.85, -bd / 2 + 0.7, 0.7, 0.5, 0.5, cols[1])
        crate(bw / 2 - 0.8, 0.14 + 0.28, -bd / 2 + 1.0, 0.8, 0.56, 0.8, cols[2]); crate(0.2, 0.14 + 0.25, -0.3, 0.6, 0.5, 0.6, cols[3], 0.3)
        crate(bw / 2 + 0.55, 0.14 + 0.3, bd / 2 - 0.4, 0.7, 0.6, 0.7, cols[Math.floor(r() * 5)], r()); crate(-bw / 2 - 0.5, 0.14 + 0.25, bd / 2 + 0.2, 0.5, 0.5, 0.5, cols[4], r())
        // counter with a screen
        const counter = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.45, 0.4), compositeDark); counter.position.set(-0.6, 0.14 + 0.22, bd / 2 - 0.9); inner.add(counter)
        const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.45), new THREE.MeshStandardMaterial({ map: screenTexture(0), emissiveMap: screenTexture(0), emissive: 0xffffff, emissiveIntensity: 1.0 })); scr.position.set(-0.6, 0.14 + 0.85, bd / 2 - 1.1); inner.add(scr); windows.push(scr.material as THREE.MeshStandardMaterial)
        const lampBar = new THREE.Mesh(new THREE.BoxGeometry(bw - 0.8, 0.05, 0.12), this.glowMaterial(0xffd7a0, 0.6, 2.0)); lampBar.position.set(0, 0.14 + wallH + 0.05, 0.6); inner.add(lampBar)
        const { tex, aspect } = textTexture('DEPOT', { font: '700 64px "Rubik Mono One", monospace', size: 64, color: '#ffd7a0', pad: 20 })
        const holo = new THREE.Mesh(new THREE.PlaneGeometry(1.4 * aspect * 0.32, 0.5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, color: 0xffb347 }))
        holo.position.set(0, 0.14 + wallH + bw * 0.3 + 0.5, bd / 2 + 0.3); holo.name = 'holo'; this.noAO(holo); inner.add(holo)
        break
      }
      case 'bakery': { // food unit: rounded block, big chimney with steam, serving window
        const bw = fw - 0.3, bd = fd - 0.3, bh = 1.1
        const body = new THREE.Mesh(new RoundedBoxGeometry(bw, bh, bd, 3, 0.14), composite); body.position.y = 0.14 + bh / 2; inner.add(body)
        const rib = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.04, 0.08, bd + 0.04), this.glowMaterial(0xffd166, 0.5, 1.6)); rib.position.y = 0.14 + bh * 0.85; inner.add(rib)
        const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 1.1, 12), metal); chimney.position.set(-bw / 2 + 0.6, 0.14 + bh + 0.5, -bd / 2 + 0.6); inner.add(chimney)
        const chimCap = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.1, 12), dark); chimCap.position.set(-bw / 2 + 0.6, 0.14 + bh + 1.05, -bd / 2 + 0.6); inner.add(chimCap)
        for (let i = 0; i < 3; i++) { const puff = new THREE.Mesh(new THREE.SphereGeometry(0.18 + i * 0.06, 8, 6), new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 - i * 0.08, roughness: 1 })); puff.position.set(-bw / 2 + 0.6 + i * 0.12, 0.14 + bh + 1.25 + i * 0.28, -bd / 2 + 0.6); puff.name = 'steam' + i; this.noAO(puff); inner.add(puff) }
        for (let i = 0; i < 2; i++) { const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.6, 12), metal); tank.position.set(bw / 2 - 0.5 - i * 0.55, 0.14 + bh + 0.3, -bd / 2 + 0.5); inner.add(tank) }
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, bw - 1.2, 8), metal); pipe.rotation.z = Math.PI / 2; pipe.position.set(0, 0.14 + bh + 0.1, -bd / 2 + 0.5); inner.add(pipe)
        // steamy windows
        for (let i = 0; i < 3; i++) { const win = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.34, 0.06), this.winMat(windows, i === 1 ? 4 : 1, 0.3)); win.position.set(-bw / 2 + 0.7 + i * ((bw - 1.4) / 2), 0.14 + bh * 0.55, bd / 2 + 0.01); if (Math.abs(win.position.x - dx) < 0.5) continue; inner.add(win) }
        // serving hatch with counter and menu screen
        const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.06), this.winMat(windows, 1, 0.3)); hatch.position.set(dx + 0.9 > bw / 2 - 0.5 ? dx - 0.9 : dx + 0.9, 0.14 + 0.6, bd / 2 + 0.02); inner.add(hatch)
        const counter = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.35), metal); counter.position.set(hatch.position.x, 0.14 + 0.36, bd / 2 + 0.2); inner.add(counter)
        const menu = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.34), new THREE.MeshStandardMaterial({ map: screenTexture(2), emissiveMap: screenTexture(2), emissive: 0xffffff, emissiveIntensity: 1.0 })); menu.position.set(hatch.position.x, 0.14 + 1.0, bd / 2 + 0.04); inner.add(menu); windows.push(menu.material as THREE.MeshStandardMaterial)
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.9, 0.08), dark); door.position.set(dx, 0.14 + 0.45, bd / 2 + 0.02); inner.add(door)
        const dl = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.05), glow); dl.position.set(dx, 0.14 + 0.95, bd / 2 + 0.04); inner.add(dl)
        const awning = new THREE.Mesh(new THREE.BoxGeometry(bw - 0.4, 0.04, 0.7), new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.8 })); awning.position.set(0, 0.14 + bh - 0.05, bd / 2 + 0.35); awning.rotation.x = 0.18; inner.add(awning)
        break
      }
      case 'forge': { // workshop: sawtooth roof, open garage, welding light, parts
        const bw = fw - 0.3, bd = fd - 0.3, bh = 1.15
        const body = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), compositeDark); body.position.y = 0.14 + bh / 2; inner.add(body)
        const seamTex = wallTexture({ type: 'forge', wUnits: bw, hUnits: bh, base: 0x6f7780, accent: 0xff7a1a, seed: 0.42, label: 'SHOP', hazard: true })
        const skin = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.02, bh - 0.02, bd + 0.02), new THREE.MeshStandardMaterial({ map: seamTex.map, normalMap: seamTex.normal, normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: seamTex.rough, roughness: 1, metalness: 0.3 })); skin.position.y = 0.14 + bh / 2; inner.add(skin)
        const teeth = 3
        for (let i = 0; i < teeth; i++) {
          const x = -bw / 2 + (i + 0.5) * (bw / teeth)
          const slope = new THREE.Mesh(gableGeometry(bw / teeth, bd - 0.1, 0.5), compositeDark); slope.rotation.y = Math.PI / 2; slope.scale.set(1, 1, 1); slope.position.set(x, 0.14 + bh, 0); inner.add(slope)
          const sky = new THREE.Mesh(new THREE.PlaneGeometry(bw / teeth - 0.15, 0.42), this.glowMaterial(0x9fe8ff, 0.4, 1.2)); sky.position.set(x, 0.14 + bh + 0.25, -0.02); sky.rotation.x = -0.6; inner.add(sky)
        }
        // open garage door with an orange glow inside
        const opening = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.95, 0.12), this.glowMaterial(0xff6a2a, 1.0, 2.0)); opening.position.set(dx, 0.14 + 0.48, bd / 2 - 0.02); inner.add(opening)
        const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.12, 0.16), accentMat); lintel.position.set(dx, 0.14 + 1.0, bd / 2 + 0.02); inner.add(lintel)
        hazard(1.7, 0.14 + 0.04, bd / 2 + 0.06, dx)
        const spark = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), this.glowMaterial(0xdff8ff, 2.5, 4)); spark.position.set(dx - 0.4, 0.14 + 0.35, bd / 2 - 0.3); spark.name = 'weld'; inner.add(spark)
        // crane arm and parts
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 1.6), accentMat); arm.position.set(bw / 2 - 0.3, 0.14 + bh + 0.3, bd / 2 - 0.2); inner.add(arm)
        const mast = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.2, 0.14), dark); mast.position.set(bw / 2 - 0.3, 0.14 + bh - 0.2, bd / 2 - 0.9); inner.add(mast)
        const gear = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.08, 6, 12), metal); gear.position.set(-bw / 2 - 0.4, 0.3, bd / 2 - 0.6); gear.rotation.x = Math.PI / 2 + 0.3; inner.add(gear)
        for (let i = 0; i < 2; i++) { const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.55, 10), new THREE.MeshStandardMaterial({ color: i ? 0xc9a227 : 0x5a6270, metalness: 0.4, roughness: 0.5 })); barrel.position.set(-bw / 2 - 0.4 + i * 0.45, 0.28, bd / 2 + 0.2); inner.add(barrel) }
        const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.9, 8), dark); vent.position.set(-bw / 2 + 0.4, 0.14 + bh + 0.6, -bd / 2 + 0.4); inner.add(vent)
        break
      }
      case 'church': { // chapel: slender tower with a stained-glass strip, portico, beacon
        const bw = fw - 0.6, bd = fd - 0.6
        const hall = new THREE.Mesh(new RoundedBoxGeometry(bw, 1.5, bd, 3, 0.2), composite); hall.position.y = 0.14 + 0.75; inner.add(hall)
        const hallRoof = new THREE.Mesh(new THREE.SphereGeometry(Math.min(bw, bd) * 0.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), composite); hallRoof.scale.set(1, 0.45, 1); hallRoof.position.y = 0.14 + 1.5; inner.add(hallRoof)
        const tower = new THREE.Mesh(new RoundedBoxGeometry(1.2, 4.2, 1.2, 3, 0.18), composite); tower.position.set(-bw / 2 + 0.7, 0.14 + 2.1, -bd / 2 + 0.7); inner.add(tower)
        const glassTex = stainedGlassTexture()
        const glassMat = new THREE.MeshStandardMaterial({ map: glassTex, emissiveMap: glassTex, emissive: 0xffffff, emissiveIntensity: 0.4, roughness: 0.2 }); windows.push(glassMat)
        const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 3.4), glassMat); strip.position.set(-bw / 2 + 0.7, 0.14 + 2.2, -bd / 2 + 0.7 + 0.61); inner.add(strip)
        const strip2 = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 3.4), glassMat); strip2.position.set(-bw / 2 + 0.7 + 0.61, 0.14 + 2.2, -bd / 2 + 0.7); strip2.rotation.y = Math.PI / 2; inner.add(strip2)
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 1.2, 6), metal); mast.position.set(-bw / 2 + 0.7, 0.14 + 4.2 + 0.6, -bd / 2 + 0.7); inner.add(mast)
        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), this.glowMaterial(0xdff3ff, 1.2, 2.4)); beacon.position.set(-bw / 2 + 0.7, 0.14 + 4.2 + 1.25, -bd / 2 + 0.7); inner.add(beacon)
        const halo = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.03, 6, 32), this.glowMaterial(0xdff3ff, 0.8, 1.6)); halo.rotation.x = Math.PI / 2; halo.position.set(-bw / 2 + 0.7, 0.14 + 4.2 + 0.9, -bd / 2 + 0.7); inner.add(halo)
        // big front window with a warm interior + portico
        const front = new THREE.Mesh(new THREE.BoxGeometry(bw - 1.6, 0.8, 0.06), this.winMat(windows, 4, 0.2)); front.position.set(0.4, 0.14 + 0.85, bd / 2 + 0.01); inner.add(front)
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.08), dark); door.position.set(dx, 0.14 + 0.55, bd / 2 + 0.03); inner.add(door)
        const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 1.0), composite); canopy.position.set(dx, 0.14 + 1.3, bd / 2 + 0.5); inner.add(canopy)
        for (const sx of [-0.65, 0.65]) { const col = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 8), composite); col.position.set(dx + sx, 0.14 + 0.66, bd / 2 + 0.9); inner.add(col) }
        const steps = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.5), compositeDark); steps.position.set(dx, 0.05, bd / 2 + 1.1); inner.add(steps)
        const dl = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.04, 0.04), this.glowMaterial(0xdff3ff, 0.6, 1.6)); dl.position.set(dx, 0.14 + 1.24, bd / 2 + 0.06); inner.add(dl)
        break
      }
      case 'school': { // school: glass front, colourful stripes, playground
        const bw = fw - 0.3, bd = fd - 0.3, bh = 1.1
        const body = new THREE.Mesh(new RoundedBoxGeometry(bw, bh, bd, 3, 0.14), composite); body.position.y = 0.14 + bh / 2; inner.add(body)
        const glassWall = new THREE.Mesh(new THREE.BoxGeometry(bw - 0.6, bh - 0.3, 0.08), new THREE.MeshPhysicalMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.4, roughness: 0.1, envMapIntensity: 0.6 })); glassWall.position.set(0, 0.14 + bh / 2 + 0.05, bd / 2 + 0.02); inner.add(glassWall); this.noAO(glassWall)
        const inside = new THREE.Mesh(new THREE.BoxGeometry(bw - 0.7, 0.6, 0.06), this.winMat(windows, 1, 0.3)); inside.position.set(0, 0.14 + 0.55, bd / 2 - 0.08); inner.add(inside)
        const cols = [0xff6b9a, 0xffd166, 0x5cc8ff, 0x7fe0a0]
        for (let i = 0; i < 4; i++) { const st = new THREE.Mesh(new THREE.BoxGeometry(0.18, bh - 0.4, 0.04), new THREE.MeshStandardMaterial({ color: cols[i], roughness: 0.7 })); st.position.set(-bw / 2 + 0.4 + i * 0.3, 0.14 + bh / 2, -bd / 2 - 0.01); inner.add(st) }
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.08), dark); door.position.set(dx, 0.14 + 0.45, bd / 2 + 0.06); inner.add(door)
        const dl = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.05, 0.05), glow); dl.position.set(dx, 0.14 + 0.95, bd / 2 + 0.08); inner.add(dl)
        const dish = new THREE.Mesh(new THREE.ConeGeometry(0.38, 0.14, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0xdfe4e8, side: THREE.DoubleSide })); dish.position.set(-bw / 2 + 0.6, 0.14 + bh + 0.45, -bd / 2 + 0.6); dish.rotation.x = -0.9; inner.add(dish)
        const dishPost = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6), metal); dishPost.position.set(-bw / 2 + 0.6, 0.14 + bh + 0.2, -bd / 2 + 0.6); inner.add(dishPost)
        // playground: climbing dome and a swing frame beside the school
        const play = new THREE.Group()
        const domeG = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), new THREE.MeshStandardMaterial({ color: 0xffd166, wireframe: true })); domeG.position.y = 0.35; domeG.scale.set(1, 0.7, 1); play.add(domeG)
        const swingTop = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.06), accentMat); swingTop.position.set(1.4, 1.0, 0); play.add(swingTop)
        for (const sx of [0.9, 1.9]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.0, 5), accentMat); leg.position.set(sx, 0.5, 0); play.add(leg) }
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.04, 0.12), dark); seat.position.set(1.4, 0.45, 0); seat.name = 'swing'; play.add(seat)
        for (const sx of [1.27, 1.53]) { const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.55, 4), dark); rope.position.set(sx, 0.72, 0); play.add(rope) }
        play.position.set(bw / 2 + 0.6, 0, bd / 2 - 0.3)
        inner.add(play)
        break
      }
      case 'guard': { // security post: bunker with a watchtower, barrier and searchlight
        const bw = fw - 0.3, bd = fd - 0.3, bh = 1.0
        const body = new THREE.Mesh(new RoundedBoxGeometry(bw, bh, bd, 3, 0.1), compositeDark); body.position.y = 0.14 + bh / 2; inner.add(body)
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.04, 0.1, bd + 0.04), this.glowMaterial(0xff3b3b, 0.5, 1.6)); stripe.position.y = 0.14 + bh * 0.8; inner.add(stripe)
        const slit = new THREE.Mesh(new THREE.BoxGeometry(bw - 0.8, 0.22, 0.06), this.winMat(windows, 2, 0.35)); slit.position.set(0.3, 0.14 + 0.62, bd / 2 + 0.01); inner.add(slit)
        const towerX = -bw / 2 + 0.55, towerZ = -bd / 2 + 0.55
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 2.0, 12), compositeDark); shaft.position.set(towerX, 0.14 + 1.0, towerZ); inner.add(shaft)
        const cabin = new THREE.Mesh(new RoundedBoxGeometry(1.0, 0.7, 1.0, 2, 0.1), composite); cabin.position.set(towerX, 0.14 + 2.35, towerZ); inner.add(cabin)
        const cabinGlass = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.3, 1.02), new THREE.MeshPhysicalMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.5, roughness: 0.1 })); cabinGlass.position.set(towerX, 0.14 + 2.4, towerZ); inner.add(cabinGlass); this.noAO(cabinGlass)
        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), this.glowMaterial(0xff2a2a, 1.6, 2.6)); beacon.position.set(towerX, 0.14 + 2.85, towerZ); beacon.name = 'beacon'; inner.add(beacon)
        const search = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.4, 12, 1, true), this.glowMaterial(0xfff2c0, 1.2, 3.0)); search.position.set(towerX + 0.55, 0.14 + 2.55, towerZ + 0.2); search.rotation.z = -Math.PI / 2 - 0.4; search.name = 'search'; inner.add(search)
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.08), dark); door.position.set(dx, 0.14 + 0.45, bd / 2 + 0.02); inner.add(door)
        const dl = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.05, 0.05), this.glowMaterial(0xff3b3b, 0.6, 1.6)); dl.position.set(dx, 0.14 + 0.95, bd / 2 + 0.04); inner.add(dl)
        // barrier gate by the door
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.7, 0.18), dark); post.position.set(dx + 0.9, 0.35, bd / 2 + 0.7); inner.add(post)
        const armG = new THREE.Group()
        const n = 6
        for (let i = 0; i < n; i++) { const seg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.08), new THREE.MeshStandardMaterial({ color: i % 2 ? 0xff3b3b : 0xf2eee6, roughness: 0.6 })); seg.position.x = -0.15 - i * 0.3; armG.add(seg) }
        armG.position.set(dx + 0.9, 0.7, bd / 2 + 0.7); armG.rotation.z = 0.9; armG.name = 'barrier'; inner.add(armG)
        const cam = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.28), dark); cam.position.set(bw / 2 - 0.3, 0.14 + bh + 0.15, bd / 2 - 0.2); cam.rotation.y = 0.5; inner.add(cam)
        const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 1.0, 6), metal); antenna.position.set(bw / 2 - 0.4, 0.14 + bh + 0.5, -bd / 2 + 0.4); inner.add(antenna)
        break
      }
    }
    add(inner)
  }

  // ───────── greebles ─────────
  addGreebles(group: THREE.Group, b: Building, W: number, D: number, wallH: number, accent: number) {
    const r = ((): (() => number) => { let a = Math.floor(hash(b.x * 5 + 2, b.y * 9 + 7) * 1e6) | 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } })()
    const doorSide = b.door.y >= b.y + b.h ? 'front' : b.door.y < b.y ? 'back' : b.door.x < b.x ? 'left' : 'right'
    const isCyl = b.type === 'mill'
    const accentMat = new THREE.MeshStandardMaterial({ color: accent, metalness: 0.5, roughness: 0.4 })
    const add = (m: THREE.Mesh) => { m.castShadow = true; m.receiveShadow = true; group.add(m) }
    // 1. pipe along a side wall (not the door side), with elbow up to the roof and a valve
    if (!isCyl && r() < 0.8) {
      const side = doorSide === 'left' ? 1 : doorSide === 'right' ? -1 : r() < 0.5 ? 1 : -1
      const x = side * (W / 2 + 0.06)
      const len = D - 0.6
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, len, 8), this.metal)
      pipe.rotation.x = Math.PI / 2; pipe.position.set(x, 0.32, 0); add(pipe)
      const up = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, wallH - 0.2, 8), this.metal)
      up.position.set(x, 0.32 + (wallH - 0.2) / 2, len / 2); add(up)
      const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), this.metal); elbow.position.set(x, 0.32, len / 2); add(elbow)
      for (const z of [-len / 3, len / 4]) { const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.08), this.metalDark); clamp.position.set(x - side * 0.03, 0.32, z); add(clamp) }
      const valve = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.02, 6, 16), accentMat); valve.position.set(x + side * 0.12, 0.32, -len / 4); valve.rotation.y = Math.PI / 2; add(valve)
    }
    // 2. utility box with a fan on a wall
    if (!isCyl && r() < 0.6) {
      const back = doorSide === 'front' ? -1 : 1
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.22), this.metalDark)
      box.position.set(-W / 2 + 0.5 + r() * (W - 1), wallH * 0.55, back * (D / 2 + 0.1)); add(box)
      const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.04, 12), this.metal)
      fan.rotation.x = Math.PI / 2; fan.position.copy(box.position); fan.position.z += back * 0.12; add(fan)
      const grill = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.012, 4, 20), this.metalDark); grill.position.copy(fan.position); grill.position.z += back * 0.03; add(grill)
    }
    // 3. roof gear: antenna mast, tank, exhaust stack
    const roofY = wallH + 0.14
    const gear = r()
    if (gear < 0.4) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 1.1, 6), this.metal); mast.position.set(-W / 2 + 0.35, roofY + 0.55, D / 2 - 0.35); add(mast)
      const dish = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.1, 14, 1, true), new THREE.MeshStandardMaterial({ color: 0xdfe4e8, side: THREE.DoubleSide, metalness: 0.4, roughness: 0.5 }))
      dish.position.set(-W / 2 + 0.35, roofY + 1.0, D / 2 - 0.35); dish.rotation.x = -0.9; dish.rotation.y = r() * 3; add(dish)
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0xff2a2a, emissiveIntensity: 1.5 })); tip.position.set(-W / 2 + 0.35, roofY + 1.12, D / 2 - 0.35); tip.name = 'blink'; group.add(tip)
    } else if (gear < 0.7 && !isCyl) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.5, 12), this.metal); tank.position.set(W / 2 - 0.5, roofY + 0.45, -D / 2 + 0.5); add(tank)
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.22, 5), this.metalDark); leg.position.set(W / 2 - 0.5 + sx * 0.18, roofY + 0.11, -D / 2 + 0.5 + sz * 0.18); add(leg) }
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.285, 0.015, 6, 20), accentMat); band.rotation.x = Math.PI / 2; band.position.set(W / 2 - 0.5, roofY + 0.45, -D / 2 + 0.5); add(band)
    } else {
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.7, 8), this.metalDark); stack.position.set(W / 2 - 0.45, roofY + 0.35, D / 2 - 0.45); add(stack)
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.12, 8), this.metal); cap.position.set(W / 2 - 0.45, roofY + 0.76, D / 2 - 0.45); add(cap)
    }
    // 4. crates and barrels beside the door
    if (r() < 0.75) {
      const dx = b.door.x + 0.5 - (b.x + W / 2), dz = b.door.y + 0.5 - (b.y + D / 2)
      let px = dx, pz = dz
      if (doorSide === 'front' || doorSide === 'back') { px = dx + (dx < 0 ? 1 : -1) * 0.9; pz = (doorSide === 'front' ? 1 : -1) * (D / 2 + 0.35) }
      else { pz = dz + (dz < 0 ? 1 : -1) * 0.9; px = (doorSide === 'right' ? 1 : -1) * (W / 2 + 0.35) }
      const crateMat = new THREE.MeshStandardMaterial({ color: r() < 0.5 ? 0x6f7780 : accent, roughness: 0.7, metalness: 0.3 })
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.4, 0.42), crateMat); c1.position.set(px, 0.2, pz); c1.rotation.y = r() * 0.5; add(c1)
      if (r() < 0.6) { const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.32, 0.34), this.metalDark); c2.position.set(px, 0.56, pz); c2.rotation.y = r() * 0.8; add(c2) }
      if (r() < 0.5) { const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.5, 10), new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.4, roughness: 0.5 })); barrel.position.set(px + 0.5, 0.25, pz); add(barrel); const ring = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.012, 4, 16), this.metalDark); ring.rotation.x = Math.PI / 2; ring.position.set(px + 0.5, 0.4, pz); add(ring) }
    }
    // 5. holographic sign for the bar
    if (b.type === 'tavern') {
      const { tex, aspect } = textTexture('ORBIT BAR', { font: '700 64px "Rubik Mono One", monospace', size: 64, color: '#ff8af0', pad: 20 })
      const holo = new THREE.Mesh(new THREE.PlaneGeometry(1.8 * aspect * 0.32, 0.58), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, color: 0xff4fd8 }))
      holo.position.set(0, wallH + 1.25, D / 2 + 0.2); holo.name = 'holo'
      this.noAO(holo)
      group.add(holo)
      const emitter = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.12), this.metalDark); emitter.position.set(0, wallH + 0.9, D / 2 + 0.2); add(emitter)
    }
    if (b.type === 'market') {
      const { tex, aspect } = textTexture('DEPOT', { font: '700 64px "Rubik Mono One", monospace', size: 64, color: '#ffd7a0', pad: 20 })
      const holo = new THREE.Mesh(new THREE.PlaneGeometry(1.4 * aspect * 0.32, 0.5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, color: 0xffb347 }))
      holo.position.set(0, wallH + 0.9, D / 2 + 0.3); holo.name = 'holo'
      this.noAO(holo)
      group.add(holo)
    }
  }

  buildCables() {
    for (const c of this.cables.children) { const m = c as THREE.Mesh; m.geometry.dispose() }
    this.cables.clear()
    const bs = this.world.buildings.filter(b => !b.site && !b.burned)
    const done = new Set<string>()
    for (const a of bs) {
      const ax = a.x + a.w / 2, az = a.y + a.h / 2
      let best: Building | null = null, bd = 99
      for (const o of bs) {
        if (o === a) continue
        const d = Math.hypot(o.x + o.w / 2 - ax, o.y + o.h / 2 - az)
        if (d > 3 && d < 10 && d < bd && !done.has(o.id + a.id)) { bd = d; best = o }
      }
      if (!best || hash(a.x + best.x, a.y + best.y) < 0.35) continue
      done.add(a.id + best.id)
      const ha = (WALL_H[a.type] ?? 1) + 0.15, hb = (WALL_H[best.type] ?? 1) + 0.15
      const p0 = new THREE.Vector3(ax + (best.x + best.w / 2 > ax ? a.w / 2 - 0.2 : -a.w / 2 + 0.2), ha, az)
      const p1 = new THREE.Vector3(best.x + best.w / 2 + (ax > best.x + best.w / 2 ? best.w / 2 - 0.2 : -best.w / 2 + 0.2), hb, best.y + best.h / 2)
      const mid = p0.clone().lerp(p1, 0.5); mid.y = Math.min(ha, hb) - 0.55 - bd * 0.04
      const curve = new THREE.QuadraticBezierCurve3(p0, mid, p1)
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 14, 0.028, 5, false), this.rubber)
      tube.castShadow = true
      this.cables.add(tube)
      for (const p of [p0, p1]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 5), this.metal); post.position.copy(p); post.position.y -= 0.15; this.cables.add(post) }
    }
  }

  buildProps() {
    this.props.clear()
    const add = (m: THREE.Object3D) => { m.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true } }); this.props.add(m) }
    // benches next to the lamps
    for (const [lx, ly, rot] of [[22.4, 13.6, 0], [26.6, 13.6, 0], [22.4, 19.4, Math.PI], [26.6, 19.4, Math.PI]]) {
      const g = new THREE.Group()
      const seat = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 0.4), this.metal); seat.position.y = 0.42; g.add(seat)
      const back = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.3, 0.05), this.metal); back.position.set(0, 0.62, -0.17); g.add(back)
      for (const sx of [-0.45, 0.45]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.36), this.metalDark); leg.position.set(sx, 0.21, 0); g.add(leg) }
      g.position.set(lx, 0, ly); g.rotation.y = rot
      add(g)
    }
    // info kiosk with a screen
    const kiosk = new THREE.Group()
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.4, 0.3), this.metalDark); body.position.y = 0.7; kiosk.add(body)
    const screenMat = new THREE.MeshStandardMaterial({ color: 0x0a2a3a, emissive: 0x58c4ff, emissiveIntensity: 1.2 })
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.03), screenMat); screen.position.set(0, 1.0, 0.16); screen.name = 'screen'; kiosk.add(screen)
    kiosk.position.set(27.3, 0, 17.6); kiosk.rotation.y = -Math.PI / 2
    add(kiosk)
    // planters with a shrub at two corners
    for (const [px, pz] of [[21.4, 16.5], [27.6, 15.4]]) {
      const g = new THREE.Group()
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.26, 0.4, 8), this.metalDark); pot.position.y = 0.2; g.add(pot)
      const bush = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), new THREE.MeshStandardMaterial({ color: 0x3f7a3c, roughness: 0.9, flatShading: true })); bush.position.y = 0.6; g.add(bush)
      g.position.set(px, 0, pz)
      add(g)
    }
    // bins by the bar and the market
    for (const [px, pz] of [[22.6, 22.4], [29.2, 14.2]]) {
      const bin = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.16, 0.5, 8), this.metal); bin.position.set(px, 0.25, pz); add(bin)
      const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 8), this.metalDark); lid.position.set(px, 0.52, pz); add(lid)
    }
  }

  buildDrones() {
    const w = this.world
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Group()
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.34), this.metalDark); g.add(body)
      const rotors: THREE.Mesh[] = []
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.03), this.metal); arm.position.set(sx * 0.2, 0.04, sz * 0.2); arm.rotation.y = sx * sz > 0 ? Math.PI / 4 : -Math.PI / 4; g.add(arm)
        const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.015, 10), new THREE.MeshStandardMaterial({ color: 0x9aa3ab, transparent: true, opacity: 0.6 })); rotor.position.set(sx * 0.28, 0.07, sz * 0.28); g.add(rotor); rotors.push(rotor)
      }
      const lamp = new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: i === 1 ? 0x58c4ff : 0xff2a2a, emissiveIntensity: 2 })
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), lamp); light.position.y = -0.07; g.add(light)
      g.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true })
      this.scene.add(g)
      this.drones.push({ group: g, rotors, lamp, phase: i * 2.1, rx: 9 + i * 4, rz: 6 + i * 3, speed: 0.00022 + i * 0.00005, h: 4.2 + i * 0.9 })
    }
    void w
  }

  syncMap() {
    const w = this.world
    if (w.mapVersion === this.mapVersion) return
    if (w.dirty.length) { this.buildGround(); this.buildTrees(); this.buildFields(); w.dirty.length = 0 }
    const ids = new Set(w.buildings.map(b => b.id))
    for (const [id, v] of this.builds) if (!ids.has(id)) { this.scene.remove(v.group); this.builds.delete(id) }
    let changed = false
    for (const b of w.buildings) {
      const v = this.builds.get(b.id)
      if (!v || v.key !== this.buildKey(b)) { this.addBuilding(b); changed = true }
    }
    if (changed) this.buildCables()
    this.mapVersion = w.mapVersion
  }
  refreshBuildings() { this.mapVersion = -1; this.syncMap() }

  // ───────── characters ─────────
  makeView(c: Character): CharView {
    const group = new THREE.Group()
    const child = c.role === 'child'
    const s = child ? 0.72 : c.role === 'old' ? 0.94 : 1
    const skin = [0xe8c4a0, 0xd9b08c, 0xf0d2b4, 0xc9976e][Math.floor(c.seed * 4)]
    const hairC = c.role === 'old' ? 0xc9c4b4 : [0x3a2a1a, 0x5a3a20, 0x1f1a16, 0x8a5a2a, 0xb08a4a][Math.floor((c.seed * 7) % 1 * 5)]
    const suit = c.role === 'healer' ? 0xe8ecef : c.role === 'priest' ? 0x2f2f3a : c.color
    const pants = c.role === 'healer' ? 0xc9d3dc : c.role === 'priest' ? 0x2f2f3a : [0x2b2f36, 0x3a3f46, 0x4a4238, 0x2e3a4a][Math.floor((c.seed * 13) % 1 * 4)]
    const mk = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, transparent: true })
    const suitMat = mk(suit), pantsMat = mk(pants), skinMat = mk(skin), hairMat = mk(hairC), shoeMat = mk(0x1c1f24)
    const mats = [suitMat, pantsMat, skinMat, hairMat, shoeMat]
    const box = (w: number, h: number, d: number, m: THREE.Material, pivotTop = false) => {
      const g = new THREE.BoxGeometry(w, h, d)
      if (pivotTop) g.translate(0, -h / 2, 0)
      const mesh = new THREE.Mesh(g, m); mesh.castShadow = true
      return mesh
    }
    // legs (pivot at the hip)
    const legL = new THREE.Group(), legR = new THREE.Group()
    for (const [leg, sx] of [[legL, -1], [legR, 1]] as const) {
      const l = box(0.13 * s, 0.44 * s, 0.14 * s, pantsMat, true)
      const shoe = box(0.15 * s, 0.07 * s, 0.2 * s, shoeMat); shoe.position.set(0, -0.44 * s, 0.03 * s)
      leg.add(l, shoe)
      leg.position.set(sx * 0.09 * s, 0.46 * s, 0)
      group.add(leg)
    }
    // torso
    const torso = new THREE.Group()
    const body = box(0.36 * s, 0.42 * s, 0.22 * s, suitMat)
    body.position.y = 0.21 * s
    torso.add(body)
    const belt = box(0.37 * s, 0.05 * s, 0.23 * s, shoeMat); belt.position.y = 0.03 * s; torso.add(belt)
    if (c.role === 'elder') { const sash = box(0.08 * s, 0.44 * s, 0.24 * s, mk(0xd6b26a)); sash.position.set(-0.1 * s, 0.21 * s, 0); sash.rotation.z = 0.25; torso.add(sash) }
    if (c.role === 'smith' || c.role === 'carpenter') { const tool = box(0.05 * s, 0.16 * s, 0.05 * s, mk(0x8b939e)); tool.position.set(0.12 * s, 0.02 * s, 0.12 * s); tool.rotation.x = 0.4; torso.add(tool) }
    torso.position.y = 0.46 * s
    group.add(torso)
    // arms (pivot at the shoulder)
    const armL = new THREE.Group(), armR = new THREE.Group()
    for (const [arm, sx] of [[armL, -1], [armR, 1]] as const) {
      const a = box(0.1 * s, 0.4 * s, 0.1 * s, suitMat, true)
      const hand = box(0.09 * s, 0.09 * s, 0.09 * s, skinMat); hand.position.y = -0.42 * s
      arm.add(a, hand)
      arm.position.set(sx * 0.24 * s, 0.86 * s, 0)
      group.add(arm)
    }
    if (c.role === 'guard') { const baton = box(0.04 * s, 0.32 * s, 0.04 * s, shoeMat); baton.position.set(0, -0.5 * s, 0.05 * s); armR.add(baton) }
    // head
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * s, 0.06 * s, 0.08 * s, 6), skinMat); neck.position.y = 0.9 * s; group.add(neck)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17 * s, 10, 8), skinMat)
    head.position.y = 1.07 * s; head.castShadow = true
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.18 * s, 10, 6, 0, Math.PI * 2, 0, c.name.sex === 'f' ? Math.PI * 0.62 : Math.PI * 0.45), hairMat)
    hair.position.y = 1.09 * s
    group.add(head, hair)
    if (c.role === 'guard') { const helm = new THREE.Mesh(new THREE.SphereGeometry(0.19 * s, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), new THREE.MeshStandardMaterial({ color: 0x4f6e8c, metalness: 0.5, roughness: 0.4, transparent: true })); helm.position.y = 1.1 * s; group.add(helm); mats.push(helm.material as THREE.MeshStandardMaterial) }
    if (c.role === 'old') torso.rotation.x = 0.14
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 1.4 * s, 6), new THREE.MeshBasicMaterial({ visible: false }))
    hit.position.y = 0.7 * s
    hit.userData.id = c.id
    group.add(hit)
    this.hitMeshes.push(hit)
    const label = makeSprite(c.name.nom, { font: '500 30px "IBM Plex Mono", monospace', size: 30, color: '#ffd98a', stroke: 'rgba(8,8,6,0.95)' }, 0.42)
    label.position.y = -0.05
    label.visible = false
    group.add(label)
    this.scene.add(group)
    const v: CharView = { id: c.id, group, body, head, hair, torso, legL, legR, armL, armR, s, mats, emoji: null, emojiText: '', label, hit }
    this.views.set(c.id, v)
    return v
  }

  /** Pose the figure for the current tick: walk cycle, breathing, activity gestures. */
  animate(v: CharView, c: Character, walking: boolean, now: number) {
    const t = now / 1000
    const ph = t * 9 + c.seed * 10
    const k = c.activity.kind
    let lL = 0, lR = 0, aL = 0, aR = 0, aLz = 0, aRz = 0, lean = 0, bob = 0, crouch = 1
    if (walking) {
      const sw = Math.sin(ph)
      lL = sw * 0.62; lR = -sw * 0.62
      aL = -sw * 0.5; aR = sw * 0.5
      bob = Math.abs(Math.cos(ph)) * 0.05
      lean = 0.08
    } else {
      const br = Math.sin(t * 1.6 + c.seed * 5)
      aL = br * 0.04; aR = -br * 0.04
      if (k === 'talk') { aR = -0.7 + Math.sin(t * 4 + c.seed) * 0.3; aRz = -0.35; aL = Math.sin(t * 2.5) * 0.15 }
      else if (k === 'work' || k === 'build') { const h = Math.sin(t * 5 + c.seed * 3); aR = -1.1 + h * 0.6; aL = -0.9 + h * 0.4; lean = 0.18 }
      else if (k === 'eat' || k === 'drink') { aR = -1.7 + Math.sin(t * 2) * 0.12; aRz = -0.55 }
      else if (k === 'quarrel') { aR = -0.9 + Math.sin(t * 5) * 0.4; aRz = -0.5; aL = -0.5; lean = 0.12 }
      else if (k === 'fight') { const p = Math.sin(t * 12 + c.seed); aR = -1.3 + p * 0.5; aL = -1.3 - p * 0.5; lean = 0.25; bob = Math.abs(p) * 0.04 }
      else if (k === 'pray') { aR = -0.95; aL = -0.95; aRz = -0.45; aLz = 0.45; lean = 0.2 }
      else if (k === 'play') { const j = Math.max(0, Math.sin(t * 4 + c.seed * 7)); bob = j * 0.18; aR = -2.4 * j; aL = -2.4 * j; lL = -j * 0.6; lR = -j * 0.6 }
      else if (k === 'steal') { crouch = 0.86; aR = -0.7; aL = -0.7; lean = 0.35 }
      else if (k === 'help' || k === 'court') { aR = -0.6; aL = -0.6; aRz = -0.2; aLz = 0.2 }
      else if (k === 'watch') { aR = -0.3; aRz = -0.2 }
      else if (k === 'think') { aR = -1.5; aRz = -0.6 }
      else if (k === 'rest' && c.activity.label.includes('bench')) { lL = -1.4; lR = -1.4; aR = -0.5; aL = -0.5 }
      else if (k === 'sick') { lean = 0.3 }
    }
    v.legL.rotation.x = lL; v.legR.rotation.x = lR
    v.armL.rotation.x = aL; v.armR.rotation.x = aR
    v.armL.rotation.z = aLz; v.armR.rotation.z = aRz
    v.torso.rotation.x = lean + (c.role === 'old' ? 0.14 : 0)
    v.group.scale.y = crouch
    const breathe = walking ? 1 : 1 + Math.sin(t * 1.6 + c.seed * 5) * 0.015
    v.torso.scale.set(1, breathe, 1)
    v.group.position.y += bob
    v.head.rotation.y = Math.sin(t * 0.7 + c.seed * 9) * 0.25
    v.hair.rotation.y = v.head.rotation.y
  }

  setEmoji(v: CharView, text: string, scale: number) {
    if (v.emojiText !== text) {
      if (v.emoji) { v.group.remove(v.emoji); v.emoji.material.dispose(); v.emoji = null }
      if (text) {
        v.emoji = makeSprite(text, { font: '48px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif', size: 48, color: '#fff', pad: 4 }, 0.75)
        v.emoji.position.y = 1.62 * scale
        v.group.add(v.emoji)
      }
      v.emojiText = text
    }
  }

  // ───────── frame ─────────
  frame() {
    if (this.destroyed) return
    const w = this.world
    this.syncMap()
    const { lastTickAt, tickMs } = this.getTiming()
    const now = performance.now()
    this.clock = now
    const alpha = tickMs > 0 ? Math.min(1, (now - lastTickAt) / tickMs) : 1
    const showLabels = this.zoomPx > 30
    const seen = new Set<string>()
    this.ring.visible = false
    this.link.visible = false
    for (const c of w.chars) {
      if (c.left || !c.alive) { const v = this.views.get(c.id); if (v) v.group.visible = false; continue }
      seen.add(c.id)
      let v = this.views.get(c.id)
      if (!v) v = this.makeView(c)
      v.group.visible = true
      const x = lerp(c.prev.x, c.pos.x, alpha) + 0.5, z = lerp(c.prev.y, c.pos.y, alpha) + 0.5
      const walking = c.path.length > 0 || c.prev.x !== c.pos.x || c.prev.y !== c.pos.y
      v.group.position.set(x, 0, z)
      if (walking) { const dx = c.pos.x - c.prev.x, dz = c.pos.y - c.prev.y; if (dx || dz) v.group.rotation.y = Math.atan2(dx, dz) }
      else if (c.activity.with) { const o = w.chars.find(z2 => z2.id === c.activity.with); if (o) v.group.rotation.y = Math.atan2(o.pos.x - c.pos.x, o.pos.y - c.pos.y) }
      this.animate(v, c, walking, now)
      const s = v.s
      const inside = !walking && c.activity.place !== null && c.activity.place !== 'square' && c.activity.place !== 'fields' && c.activity.place !== 'forest' && c.activity.place !== 'road' && c.activity.place !== 'target' && !['rest', 'idle', 'watch', 'help', 'build', 'play'].includes(c.activity.kind)
      const isSel = this.selected === c.id
      const op = inside && !isSel ? 0.35 : 1
      for (const m of v.mats) m.opacity = op
      const em = statusEmoji(c)
      this.setEmoji(v, em, s)
      if (v.emoji) v.emoji.visible = this.zoomPx > 12 || isSel
      v.label.visible = showLabels || isSel || this.hovered === c.id
      if (isSel) {
        this.ring.visible = true
        const p = (Math.sin(now / 260) + 1) / 2
        this.ring.position.set(x, 0.03, z)
        this.ring.scale.setScalar(1 + p * 0.25)
        this.ringMat.opacity = 0.6 + p * 0.4
      }
      if ((c.activity.kind === 'talk' || c.activity.kind === 'quarrel' || c.activity.kind === 'court' || c.activity.kind === 'fight') && c.activity.with) {
        const o = w.chars.find(z2 => z2.id === c.activity.with)
        if (o && (isSel || this.hovered === c.id)) {
          const ox = lerp(o.prev.x, o.pos.x, alpha) + 0.5, oz = lerp(o.prev.y, o.pos.y, alpha) + 0.5
          const col = c.activity.kind === 'quarrel' || c.activity.kind === 'fight' ? 0xd5623b : c.activity.kind === 'court' ? 0xe39aa8 : 0xd6b26a
          ;(this.link.material as THREE.LineBasicMaterial).color.setHex(col)
          this.link.geometry.setFromPoints([new THREE.Vector3(x, 1.2, z), new THREE.Vector3(ox, 1.2, oz)])
          this.link.visible = true
        }
      }
    }
    for (const [id, v] of this.views) if (!seen.has(id)) v.group.visible = false

    // day / night
    const h = hourOf(w.t) + (w.t % 60) / 60
    let nightF = 0
    if (h < 5) nightF = 1
    else if (h < 8) nightF = 1 - (h - 5) / 3
    else if (h < 17) nightF = 0
    else if (h < 22) nightF = (h - 17) / 5
    else nightF = 1
    const sunAngle = ((h - 6) / 12) * Math.PI // 0 at 6:00, π at 18:00
    const sunEl = Math.sin(sunAngle)
    const cx = w.w / 2, cz = w.h / 2
    this.sun.position.set(cx + Math.cos(sunAngle) * 60, 20 + Math.max(0, sunEl) * 70, cz + 30)
    this.sun.target.position.set(cx, 0, cz)
    this.sun.target.updateMatrixWorld()
    const dayI = Math.max(0, sunEl)
    this.sun.intensity = dayI * 2.4
    const warm = new THREE.Color(0xff9a5a), noon = new THREE.Color(0xfff3dc)
    this.sun.color.copy(noon).lerp(warm, Math.pow(1 - Math.min(1, dayI * 1.6), 2))
    this.moon.position.set(cx - 40, 60, cz - 30); this.moon.target.position.set(cx, 0, cz); this.moon.target.updateMatrixWorld()
    this.moon.intensity = nightF * 0.2
    this.hemi.intensity = 0.12 + (1 - nightF) * 0.85
    this.hemi.color.setHex(0x9fc3e0).lerp(new THREE.Color(0x24304f), nightF)
    this.hemi.groundColor.setHex(0x3b4a2e).lerp(new THREE.Color(0x0e1218), nightF)
    this.ambient.intensity = 0.1 + nightF * 0.02
    const flicker = 0.85 + Math.sin(now / 130) * 0.08 + Math.sin(now / 47) * 0.05
    for (const l of this.lamps) { l.light.intensity = nightF * 3.2 * flicker; l.bulb.emissiveIntensity = nightF * 2.4 }
    for (const b of w.buildings) {
      const v = this.builds.get(b.id)
      if (!v) continue
      const glow = b.site || b.burned ? 0 : nightF * 1.6 * (0.8 + hash(b.x, b.y) * 0.4)
      for (const m of v.windows) m.emissiveIntensity = glow
      for (const l of v.lights) l.intensity = (0.15 + nightF * 0.85) * ((l as unknown as { peak: number }).peak ?? 3) * (0.9 + Math.sin(now / 300 + b.x) * 0.1)
      if (b.type === 'mill') { const sails = v.group.getObjectByName('sails'); if (sails) sails.rotation.z = now / 2200 }
      if (b.type === 'guard') { const bc = v.group.getObjectByName('beacon') as THREE.Mesh | undefined; if (bc) (bc.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.6 + Math.max(0, Math.sin(now / 400)) * 2 }
    }
    // the dome dissolves as the camera zooms in
    const zoomRatio = this.zoomPx / this.fitZoomPx
    const targetFade = 1 - THREE.MathUtils.clamp((zoomRatio - 1.25) / 1.1, 0, 1)
    this.domeFade = lerp(this.domeFade, targetFade, 0.12)
    const df = this.domeFade
    ;(this.dome.material as THREE.MeshPhysicalMaterial).opacity = (0.07 + nightF * 0.06) * df
    ;(this.domeFrame.material as THREE.LineBasicMaterial).opacity = (0.09 + nightF * 0.1) * df
    this.dome.visible = df > 0.02
    this.domeFrame.visible = df > 0.02
    this.bloom.strength = 0.3 + nightF * 0.4
    this.uTime.value = now / 1000
    for (const gm of this.glowMats) { const g = gm.userData.glow as { day: number; night: number } | undefined; if (g) gm.emissiveIntensity = g.day + (g.night - g.day) * nightF }
    ;(this.ground.material as THREE.MeshPhysicalMaterial).emissiveIntensity = 0.15 + nightF * 0.7
    if (this.water) { const wm = this.water.material as THREE.MeshPhysicalMaterial; if (wm.normalMap) { wm.normalMap.offset.x = now / 60000; wm.normalMap.offset.y = now / 90000 } }
    ;(this.scene.fog as THREE.FogExp2).color.setHex(0x151d28).lerp(new THREE.Color(0x05070d), nightF)
    ;(this.scene.fog as THREE.FogExp2).density = 0.0019 + nightF * 0.0016
    this.scene.background = (this.scene.fog as THREE.FogExp2).color
    this.scene.environmentIntensity = 0.28 * (1 - nightF) + 0.03
    this.grade.uniforms.night.value = nightF
    this.grade.uniforms.time.value = now / 1000
    this.tilt.uniforms.strength.value = 1.2 + (1 - Math.min(1, this.zoomPx / this.fitZoomPx / 2)) * 1.6
    // mosaic: loose pixels drift off the rim; new materials get the shader as they appear
    if (this.mosaicOn && this.pixels && this.mosaicU) {
      this.mosaicU.uTime.value = now / 1000
      if (++this.mosaicFrame % 45 === 0) this.patchMosaic()
      const R = this.mosaicU.uRadius.value, c = this.mosaicU.uCenter.value
      const pp = this.pixels.points.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = pp.array as Float32Array, base = this.pixels.base, dir = this.pixels.dir
      const t = now / 1000
      for (let i = 0; i < arr.length; i += 3) {
        const cycle = 22 + (i % 17), ph = ((t + i * 0.37) % cycle) / cycle
        arr[i] = base[i] + dir[i] * ph * 40
        arr[i + 1] = base[i + 1] + dir[i + 1] * ph * 40 + Math.sin(t * 0.7 + i) * 0.3
        arr[i + 2] = base[i + 2] + dir[i + 2] * ph * 40
        // keep a quiet band just inside the rim so pixels seem to peel off the mosaic
        const dd = Math.hypot(arr[i] - c.x, arr[i + 2] - c.z) / R
        if (dd < 0.92) arr[i + 1] = -50
      }
      pp.needsUpdate = true
      ;(this.pixels.points.material as THREE.PointsMaterial).opacity = 0.55 + nightF * 0.35
    }
    // dust motes drift
    const mp = this.motes.geometry.getAttribute('position') as THREE.BufferAttribute
    const arr = mp.array as Float32Array
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] = this.motesBase[i] + Math.sin(now / 4000 + i) * 0.6
      arr[i + 1] = this.motesBase[i + 1] + Math.sin(now / 2600 + i * 0.7) * 0.4
      arr[i + 2] = this.motesBase[i + 2] + Math.cos(now / 3500 + i * 0.3) * 0.6
    }
    mp.needsUpdate = true
    ;(this.motes.material as THREE.PointsMaterial).opacity = 0.35 + nightF * 0.3

    // fire
    const fireOn = w.events.some(e => e.id === 'fire')
    this.fire.visible = fireOn
    this.fireLight.intensity = 0
    if (fireOn) {
      const burning = w.buildings.find(b => b.burned || (b.site && b.reason === 'rebuild' && (b.progress ?? 0) < 0.3))
      if (burning) {
        const bx = burning.x + burning.w / 2, bz = burning.y + burning.h / 2
        while (this.fire.children.length < 10) {
          const f = new THREE.Mesh(new THREE.SphereGeometry(0.25, 6, 5), new THREE.MeshStandardMaterial({ color: 0xff8c2a, emissive: 0xff7a1a, emissiveIntensity: 2.2, transparent: true, opacity: 0.85 }))
          f.layers.set(1)
          this.fire.add(f)
        }
        this.fire.children.forEach((f, i) => {
          const hh = hash(i, Math.floor(now / 90) + i)
          f.position.set(bx + (hh - 0.5) * burning.w, 0.6 + ((hh * 5) % 1) * 1.6, bz + (((hh * 3) % 1) - 0.5) * burning.h)
          f.scale.setScalar(0.6 + hh * 0.9)
        })
        this.fireLight.position.set(bx, 1.6, bz)
        this.fireLight.intensity = 6 + Math.sin(now / 60) * 2
      }
    }

    // drones patrol above the streets
    const cxw = w.w / 2, czw = w.h / 2
    for (const d of this.drones) {
      const t = now * d.speed + d.phase
      const x = cxw + Math.cos(t) * d.rx + Math.sin(t * 2.3) * 1.5, z = czw + Math.sin(t) * d.rz + Math.cos(t * 1.7) * 1.2
      const nx = cxw + Math.cos(t + 0.02) * d.rx + Math.sin((t + 0.02) * 2.3) * 1.5, nz = czw + Math.sin(t + 0.02) * d.rz + Math.cos((t + 0.02) * 1.7) * 1.2
      d.group.position.set(x, d.h + Math.sin(now / 900 + d.phase) * 0.25, z)
      d.group.rotation.y = Math.atan2(nx - x, nz - z)
      d.group.rotation.z = -0.12
      for (const rt of d.rotors) rt.rotation.y = now / 25
      d.lamp.emissiveIntensity = Math.sin(now / 250 + d.phase) > 0.6 ? 3 : 0.3
    }
    for (const v of this.builds.values()) {
      const blink = v.group.getObjectByName('blink') as THREE.Mesh | undefined
      if (blink) (blink.material as THREE.MeshStandardMaterial).emissiveIntensity = Math.sin(now / 500 + v.group.position.x) > 0.7 ? 2.5 : 0.2
      const weld = v.group.getObjectByName('weld') as THREE.Mesh | undefined
      if (weld) { const on = Math.sin(now / 40) > 0.3 && Math.sin(now / 900) > -0.2; (weld.material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 4 + Math.random() * 3 : 0.2 }
      for (let i = 0; i < 3; i++) { const puff = v.group.getObjectByName('steam' + i) as THREE.Mesh | undefined; if (puff) { const ph = ((now / 1800) + i * 0.33) % 1; puff.position.y = puff.userData.y0 ?? (puff.userData.y0 = puff.position.y); puff.position.y = puff.userData.y0 + ph * 0.9; puff.scale.setScalar(0.6 + ph * 1.2); (puff.material as THREE.MeshStandardMaterial).opacity = (1 - ph) * 0.35 } }
      const swing = v.group.getObjectByName('swing'); if (swing) swing.position.x = 1.4 + Math.sin(now / 600) * 0.12
      const search = v.group.getObjectByName('search'); if (search) search.rotation.y = Math.sin(now / 2500) * 0.9
      const laundry = v.group.getObjectByName('laundry')
      if (laundry) laundry.rotation.x = Math.sin(now / 700 + v.group.position.x) * 0.18
      const holo = v.group.getObjectByName('holo') as THREE.Mesh | undefined
      if (holo) { (holo.material as THREE.MeshBasicMaterial).opacity = (0.55 + nightF * 0.3) * (0.85 + Math.sin(now / 90) * 0.06 + (Math.sin(now / 1300) > 0.97 ? -0.4 : 0)); holo.position.y += Math.sin(now / 700) * 0.0006 }
    }
    // camera follow
    if (this.camTarget) {
      const tx = this.camTarget.x, tz = this.camTarget.y
      this.target.x = lerp(this.target.x, tx, 0.1); this.target.z = lerp(this.target.z, tz, 0.1)
      this.updateCamera()
      if (Math.abs(this.target.x - tx) < 0.02 && Math.abs(this.target.z - tz) < 0.02) this.camTarget = null
    }
    this.aoCamera.copy(this.camera)
    this.aoCamera.layers.set(0)
    this.composer.render()
  }

  charDesc(id: string) {
    const c = this.world.chars.find(x => x.id === id)
    if (!c) return ''
    return `${roleLabel(c)}, ${c.age} · ${c.activity.label}`
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    cancelAnimationFrame(this.raf)
    this.resizeObs?.disconnect()
    try {
      this.scene.traverse(o => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); const mat = m.material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mat)) mat.forEach(x => x.dispose()); else mat?.dispose() })
      this.composer?.dispose()
      this.renderer?.dispose()
      if (this.canvas?.parentNode) this.canvas.parentNode.removeChild(this.canvas)
    } catch { /* not initialised */ }
  }
}
