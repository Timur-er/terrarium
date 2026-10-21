/**
 * The «mosaic» look: every surface is laid with tiny tiles in world space, the colour is washed toward white,
 * and geometry dissolves into square cells past the dome rim, where loose pixels drift off into space.
 * Implemented as a shader injection on standard materials, switchable without recompiling (uMosaic uniform).
 */
import * as THREE from 'three'

export interface MosaicUniforms {
  uMosaic: { value: number }
  uCenter: { value: THREE.Vector3 }
  uRadius: { value: number }
  uCells: { value: number }
  uDissolveCells: { value: number }
  uTime: { value: number }
}

export function makeMosaicUniforms(center: THREE.Vector3, radius: number): MosaicUniforms {
  return { uMosaic: { value: 0 }, uCenter: { value: center.clone() }, uRadius: { value: radius }, uCells: { value: 5 }, uDissolveCells: { value: 3 }, uTime: { value: 0 } }
}

const HEAD = `
uniform float uMosaic; uniform vec3 uCenter; uniform float uRadius; uniform float uCells; uniform float uDissolveCells;
varying vec3 vMPos;
float mosaicHash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.17, 0.23)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
`

const VERT = `#include <worldpos_vertex>
{
  vec4 mp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    mp = instanceMatrix * mp;
  #endif
  vMPos = (modelMatrix * mp).xyz;
}`

const FRAG = `#include <normal_fragment_maps>
if (uMosaic > 0.5) {
  // dissolve into square cells beyond the rim
  vec3 cell = floor(vMPos * uDissolveCells);
  float h = mosaicHash(cell);
  float d = distance(vMPos.xz, uCenter.xz) / uRadius;
  float edge = clamp((d - 0.9) / 0.28, 0.0, 1.0);
  if (h < edge * edge) discard;
  // tiles: grid lines in world space, blended by the dominant normal
  vec3 nw = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]) * normal.x + vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]) * normal.y + vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) * normal.z);
  vec3 wgt = pow(abs(nw), vec3(4.0)); wgt /= (wgt.x + wgt.y + wgt.z + 1e-4);
  vec3 p = vMPos * uCells;
  vec3 fw = fwidth(p) + 1e-4;
  vec3 f = abs(fract(p) - 0.5);
  float lw = 0.075;
  vec3 line = smoothstep(vec3(0.5 - lw) - fw, vec3(0.5 - lw) + fw, f);
  float grout = max(line.y, line.z) * wgt.x + max(line.x, line.z) * wgt.y + max(line.x, line.y) * wgt.z;
  float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  vec3 tile = mix(diffuseColor.rgb, vec3(lum), 0.78);
  tile = mix(tile, vec3(0.78, 0.79, 0.82), 0.6);
  tile *= 0.9 + 0.12 * mosaicHash(floor(p));
  // tiles thin out toward the rim too, showing dark grout between them
  float worn = smoothstep(0.75, 1.05, d) * step(mosaicHash(floor(p) + 7.0), 0.35 + edge);
  tile = mix(tile, tile * 0.35, worn);
  // when tiles get smaller than a pixel the grid averages into a slightly darker surface instead of vanishing
  float tiny = clamp(max(fw.x, max(fw.y, fw.z)) * 2.0, 0.0, 1.0);
  grout = mix(grout, 0.3, tiny);
  diffuseColor.rgb = mix(tile, tile * 0.3, grout);
}`

/** Injects the mosaic shader into a material once; returns false if the material cannot carry it. */
export function applyMosaic(mat: THREE.Material, u: MosaicUniforms): boolean {
  const m = mat as THREE.MeshStandardMaterial
  if (!m.isMeshStandardMaterial || m.userData.mosaic) return false
  // lit things keep their colour: screens, windows, accent stripes, lamps
  if (m.userData.glow || (m.emissiveIntensity > 0.9 && m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 1.2)) { m.userData.mosaic = 'skip'; return false }
  m.userData.mosaic = true
  const prev = m.onBeforeCompile
  const prevKey = m.customProgramCacheKey ? m.customProgramCacheKey() : ''
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer)
    shader.uniforms.uMosaic = u.uMosaic; shader.uniforms.uCenter = u.uCenter; shader.uniforms.uRadius = u.uRadius
    shader.uniforms.uCells = u.uCells; shader.uniforms.uDissolveCells = u.uDissolveCells
    shader.vertexShader = 'varying vec3 vMPos;\n' + shader.vertexShader.replace('#include <worldpos_vertex>', VERT)
    shader.fragmentShader = HEAD + shader.fragmentShader.replace('#include <normal_fragment_maps>', FRAG)
  }
  m.customProgramCacheKey = () => 'mosaic|' + prevKey
  m.needsUpdate = true
  return true
}

/** Loose pixels drifting away from the rim of the dome into space. */
export function makePixels(center: THREE.Vector3, R: number): { points: THREE.Points; base: Float32Array; dir: Float32Array } {
  const n = 1400
  const pos = new Float32Array(n * 3), dir = new Float32Array(n * 3), col = new Float32Array(n * 3)
  const palette = [[0.96, 0.96, 0.98], [0.96, 0.96, 0.98], [0.62, 0.8, 1.0], [1.0, 0.72, 0.3], [0.55, 0.6, 0.7]]
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, el = Math.random() * 0.9
    const rr = R * (0.9 + Math.random() * 0.9)
    pos[i * 3] = center.x + Math.cos(a) * Math.cos(el) * rr
    pos[i * 3 + 1] = Math.sin(el) * rr * 0.8 + 0.3
    pos[i * 3 + 2] = center.z + Math.sin(a) * Math.cos(el) * rr
    const sp = 0.4 + Math.random() * 1.2
    dir[i * 3] = Math.cos(a) * Math.cos(el) * sp; dir[i * 3 + 1] = (Math.sin(el) * 0.5 + 0.15) * sp; dir[i * 3 + 2] = Math.sin(a) * Math.cos(el) * sp
    const c = palette[Math.floor(Math.random() * palette.length)]
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const mat = new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false })
  const points = new THREE.Points(g, mat)
  points.frustumCulled = false
  return { points, base: pos.slice(), dir }
}
