/**
 * Lanes as ONE instanced ribbon carrying a shader-side current.
 *
 * Every lane is the same base strip of quads, instanced once per lane. The
 * vertex shader evaluates the lane's bowed curve, expands the strip to a
 * constant pixel width in screen space, and the fragment shader paints an
 * asymmetric travelling comet along it. One draw call, one geometry, one
 * material — and the only per-frame upload is 4 floats per lane.
 */
import * as THREE from 'three'

import { byId, colorUnder, lanes } from './graph'
import type { Lens } from './graph'
import { hash01 } from './layout'

/* ── physics of the current ──────────────────────────────────────────────────
 * Spacing and speed are in WORLD units, not per-lane fractions. That is the
 * whole trick: every pulse on the map travels at the same velocity and sits the
 * same distance behind the one in front, so 30 lanes of wildly different length
 * read as one circulatory system instead of 30 unrelated loops.
 */
const SPACING = 9.0
const SPEED = 5.6
/** Cycles per second. `uFlow` is this integrated and wrapped into [0,1). */
const RATE = SPEED / SPACING

/** Sag as a fraction of chord length. Structure stays taut; relations arc. */
const BOW_SPINE = 0.03
const BOW_ROUTE = 0.1

export interface FlowSkin {
  /** true → additive glow. false → ink on paper. */
  night: boolean
  bg: number
  fogNear: number
  fogFar: number
  /** Colour the pulse core is pulled toward: near-white at night, ink on sand. */
  hot: number
  hotMix: number
  /** Alpha of the always-on hairline. This is the "much more subtle" dial. */
  threadA: number
  coreA: number
  glowA: number
  /** Hairline / core / glow half-value half-widths, in CSS pixels. */
  hair: number
  core: number
  glow: number
  /** Total ribbon width in CSS pixels. Must exceed 2 * glow. */
  width: number
}

export const FLOW_SKIN: Record<'night' | 'day', FlowSkin> = {
  night: {
    night: true,
    bg: 0x050811,
    fogNear: 46,
    fogFar: 130,
    hot: 0xf2f6ff,
    hotMix: 0.55,
    threadA: 0.075,
    coreA: 0.95,
    glowA: 0.22,
    hair: 0.62,
    core: 1.5,
    glow: 3.4,
    width: 8,
  },
  day: {
    night: false,
    bg: 0xe8e0d0,
    fogNear: 50,
    fogFar: 140,
    // On sand the core goes DOWN, not up: additive light on a light ground is
    // invisible, so the pulse reads as ink soaking into paper.
    hot: 0x0d1220,
    hotMix: 0.5,
    threadA: 0.16,
    coreA: 0.8,
    glowA: 0.16,
    hair: 0.6,
    core: 1.4,
    glow: 3.0,
    width: 7,
  },
}

const vertexShader = /* glsl */ `
  attribute vec3 iA;
  attribute vec3 iB;
  attribute vec3 iBow;
  attribute vec3 iColA;
  attribute vec3 iColB;
  attribute vec4 iMeta;   // x cycles along lane, y phase, z seed, w spine flag
  attribute vec4 iState;  // x energy, y direction, z thread, w sparse

  uniform vec2  uResolution;
  uniform float uWidth;
  uniform float uTaper;
  uniform float uFlow;
  uniform float uFogNear;
  uniform float uFogFar;

  varying float vS;
  varying float vSide;
  varying float vHalf;
  varying float vHead;
  varying float vSeed;
  varying float vDepth;
  varying vec3  vColA;
  varying vec3  vColB;
  varying vec4  vState;

  void main() {
    // The base strip smuggles its two parameters through the position
    // attribute, so three still has the attribute it wants, at no extra cost.
    float s    = position.x;
    float side = position.y;

    // Quadratic Bezier, plus its exact derivative. Both are three mixes.
    vec3 c  = mix(iA, iB, 0.5) + iBow;
    vec3 p  = mix(mix(iA, c, s), mix(c, iB, s), s);
    vec3 dp = 2.0 * ((1.0 - s) * (c - iA) + s * (iB - c));

    vec4 mv    = modelViewMatrix * vec4(p, 1.0);
    vec4 clip  = projectionMatrix * mv;
    vec4 dClip = projectionMatrix * (modelViewMatrix * vec4(dp, 0.0));

    // Exact screen-space tangent: d(clip.xy / clip.w)/ds by the quotient rule.
    // Cheaper and better conditioned than projecting a nearby sample point.
    float w2  = max(clip.w * clip.w, 1e-6);
    vec2 ndcD = (dClip.xy * clip.w - clip.xy * dClip.w) / w2;

    float aspect = uResolution.x / uResolution.y;
    vec2  dpx    = vec2(ndcD.x * aspect, ndcD.y);
    float dl     = length(dpx);
    vec2  nrm    = dl > 1e-7 ? vec2(-dpx.y, dpx.x) / dl : vec2(0.0, 1.0);

    // Constant CSS-pixel width — a hairline must stay a hairline at every zoom.
    // A gentle taper with depth hands back the size cue that constant width
    // would otherwise throw away.
    float depth  = -mv.z;
    float halfPx = uWidth * 0.5 * mix(1.0, uTaper, smoothstep(uFogNear * 0.35, uFogFar, depth));

    vec2 offset = vec2(nrm.x / aspect, nrm.y) * (halfPx * 2.0 / uResolution.y) * side;
    clip.xy += offset * clip.w;
    gl_Position = clip;

    vS     = s;
    vSide  = side;
    vHalf  = halfPx;
    // NOT fract()-ed here: wrapping in the vertex shader would tear the
    // interpolation. The fragment shader wraps per pixel instead.
    vHead  = s * iMeta.x + iMeta.y - uFlow * iState.y;
    vSeed  = iMeta.z;
    vDepth = depth;
    vColA  = iColA;
    vColB  = iColB;
    vState = iState;
  }
`

const fragmentShader = /* glsl */ `
  uniform float uHair;
  uniform float uCore;
  uniform float uGlow;
  uniform float uTailK;
  uniform float uNoseK;
  uniform float uThreadA;
  uniform float uCoreA;
  uniform float uGlowA;
  uniform float uHotMix;
  uniform float uSlow;
  uniform vec3  uHot;
  uniform vec3  uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying float vS;
  varying float vSide;
  varying float vHalf;
  varying float vHead;
  varying float vSeed;
  varying float vDepth;
  varying vec3  vColA;
  varying vec3  vColB;
  varying vec4  vState;

  void main() {
    float r = abs(vSide) * vHalf;               // pixels from the centreline

    // ── along the lane: an asymmetric comet, not a blob ────────────────────
    // x is cycles BEHIND the head. A near-vertical nose and a long exponential
    // wake give the pulse a direction the eye reads instantly.
    float x    = fract(vHead);
    float tail = exp2(-x * uTailK);
    float nose = exp2(-(1.0 - x) * uNoseK);
    float env  = tail + nose - tail * nose;     // screen union: C0 at the wrap

    // Idle lanes are gated by a slow standing wave, so the resting map breathes
    // instead of marching. Active lanes (sparse → 0) get the clean train.
    float gate = mix(1.0, 0.5 + 0.5 * sin(vS * 1.7 - uSlow + vSeed * 6.2831853), vState.w);
    float e    = vState.x * env * gate;

    // ── across the lane: three lobes sharing one ribbon ────────────────────
    float thread = exp2(-(r * r) / (uHair * uHair)) * vState.z;
    float core   = exp2(-(r * r) / (uCore * uCore)) * e;
    float glow   = exp2(-(r * r) / (uGlow * uGlow)) * e;

    float aT = thread * uThreadA;
    float aC = core * uCoreA;
    float aG = glow * uGlowA;
    float cov = aT + aC + aG;
    if (cov < 0.0015) discard;                  // most of the ribbon is empty

    // Source → target gradient, with the head leaning toward its destination.
    vec3 hue = mix(vColA, vColB, clamp(vS + 0.16 * e, 0.0, 1.0));
    vec3 rad = hue * (aT + aG) + mix(hue, uHot, uHotMix) * aC;

    float fogK = smoothstep(uFogNear, uFogFar, vDepth);

    #ifdef ADDITIVE
      // Fog must ATTENUATE additive radiance. Mixing toward the fog colour
      // would make distant lanes brighter as they recede.
      gl_FragColor = vec4(rad * (1.0 - fogK), 1.0);
    #else
      gl_FragColor = vec4(mix(rad / cov, uFogColor, fogK), min(cov, 1.0) * (1.0 - fogK * 0.85));
    #endif

    #include <colorspace_fragment>
  }
`

export interface LaneFlow {
  mesh: THREE.Mesh
  /** Call from the ResizeObserver. Width is in CSS pixels. */
  setResolution(w: number, h: number): void
  /** Same inputs as the old paintLanes/applyStates pair. */
  setSelection(sel: string | null, hov: string | null): void
  /** dt in seconds. */
  update(dt: number): void
  dispose(): void
}

interface LaneState {
  energy: number
  energyTo: number
  thread: number
  threadTo: number
  sparse: number
  sparseTo: number
  dir: number
  dirWanted: number
}

function baseStrip(seg: number) {
  const pos = new Float32Array((seg + 1) * 2 * 3)
  for (let i = 0; i <= seg; i++) {
    const s = i / seg
    const a = i * 2 * 3
    pos[a] = s
    pos[a + 1] = -1
    pos[a + 3] = s
    pos[a + 4] = 1
  }
  const idx = new Uint16Array(seg * 6)
  for (let i = 0; i < seg; i++) {
    const a = i * 2
    idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6)
  }
  return { pos, idx }
}

export function buildLaneFlow(lens: Lens, skin: FlowSkin): LaneFlow {
  const n = lanes.length
  // The only thing that scales with lane count. Arcs need resolution; at 300
  // lanes nobody can see the difference between 22 and 12 segments.
  const seg = n > 160 ? 12 : 22
  const width = n > 160 ? skin.width * 0.75 : skin.width

  const { pos, idx } = baseStrip(seg)
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setIndex(new THREE.BufferAttribute(idx, 1))
  geometry.instanceCount = n

  const iA = new Float32Array(n * 3)
  const iB = new Float32Array(n * 3)
  const iBow = new Float32Array(n * 3)
  const iColA = new Float32Array(n * 3)
  const iColB = new Float32Array(n * 3)
  const iMeta = new Float32Array(n * 4)
  const iState = new Float32Array(n * 4)

  const A = new THREE.Vector3()
  const B = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const nrm = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const alt = new THREE.Vector3(1, 0, 0)
  const q = new THREE.Quaternion()
  const col = new THREE.Color()

  lanes.forEach((l, i) => {
    const from = byId.get(l.from)!
    const to = byId.get(l.to)!
    A.set(from.x, from.y, from.z)
    B.set(to.x, to.y, to.z)
    iA.set([A.x, A.y, A.z], i * 3)
    iB.set([B.x, B.y, B.z], i * 3)

    dir.copy(B).sub(A)
    const len = dir.length() || 1
    dir.divideScalar(len)

    // Any perpendicular, then rolled around the lane by a hashed angle so the
    // arcs never line up into a comb.
    nrm.copy(dir).cross(Math.abs(dir.y) > 0.94 ? alt : up)
    if (nrm.lengthSq() < 1e-8) nrm.copy(alt)
    nrm.normalize()
    const key = `${l.from}>${l.to}`
    q.setFromAxisAngle(dir, hash01(key + '#roll') * Math.PI * 2)
    nrm.applyQuaternion(q)
    const sag = len * (l.spine ? BOW_SPINE : BOW_ROUTE)
    iBow.set([nrm.x * sag, nrm.y * sag, nrm.z * sag], i * 3)

    col.set(colorUnder(from, lens))
    iColA.set([col.r, col.g, col.b], i * 3)
    col.set(colorUnder(to, lens))
    iColB.set([col.r, col.g, col.b], i * 3)

    // cycles = how many pulse-spacings fit on this lane. Deliberately not an
    // integer and deliberately not clamped: a lane shorter than the spacing
    // simply has a gap sometimes, which is what real spacing looks like.
    iMeta.set([len / SPACING, hash01(key + '#phase'), hash01(key + '#seed'), l.spine ? 1 : 0], i * 4)
  })

  geometry.setAttribute('iA', new THREE.InstancedBufferAttribute(iA, 3))
  geometry.setAttribute('iB', new THREE.InstancedBufferAttribute(iB, 3))
  geometry.setAttribute('iBow', new THREE.InstancedBufferAttribute(iBow, 3))
  geometry.setAttribute('iColA', new THREE.InstancedBufferAttribute(iColA, 3))
  geometry.setAttribute('iColB', new THREE.InstancedBufferAttribute(iColB, 3))
  geometry.setAttribute('iMeta', new THREE.InstancedBufferAttribute(iMeta, 4))

  const stateAttr = new THREE.InstancedBufferAttribute(iState, 4)
  stateAttr.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('iState', stateAttr)

  const uniforms: Record<string, THREE.IUniform> = {
    uResolution: { value: new THREE.Vector2(1, 1) },
    uWidth: { value: width },
    uTaper: { value: 0.62 },
    uFlow: { value: 0 },
    uSlow: { value: 0 },
    uHair: { value: skin.hair },
    uCore: { value: skin.core },
    uGlow: { value: skin.glow },
    // 6 → the wake fades over a sixth of the gap; 34 → a two-pixel nose.
    uTailK: { value: 6.0 },
    uNoseK: { value: 34.0 },
    uThreadA: { value: skin.threadA },
    uCoreA: { value: skin.coreA },
    uGlowA: { value: skin.glowA },
    uHotMix: { value: skin.hotMix },
    uHot: { value: new THREE.Color(skin.hot) },
    uFogColor: { value: new THREE.Color(skin.bg) },
    uFogNear: { value: skin.fogNear },
    uFogFar: { value: skin.fogFar },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    defines: skin.night ? { ADDITIVE: 1 } : {},
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    // fog:true would make three write into uniforms.fogColor/fogNear/fogFar,
    // which a ShaderMaterial does not have unless UniformsLib.fog is merged in
    // — it throws. We need custom fog for the additive case anyway.
    fog: false,
    blending: skin.night ? THREE.AdditiveBlending : THREE.NormalBlending,
  })

  const mesh = new THREE.Mesh(geometry, material)
  // `position` holds strip parameters, not coordinates, so the derived bounds
  // are meaningless. Lanes span the whole map; culling them buys nothing.
  mesh.frustumCulled = false
  mesh.renderOrder = -1

  const state: LaneState[] = lanes.map((l) => ({
    energy: 0,
    energyTo: l.spine ? 0.035 : 0.06,
    thread: 1,
    threadTo: 1,
    sparse: 1,
    sparseTo: 1,
    dir: 1,
    dirWanted: 1,
  }))

  let flow = 0
  let slow = 0

  return {
    mesh,

    setResolution(w, h) {
      ;(uniforms.uResolution.value as THREE.Vector2).set(Math.max(1, w), Math.max(1, h))
    },

    setSelection(sel, hov) {
      const anchor = sel ?? hov
      for (let i = 0; i < n; i++) {
        const l = lanes[i]
        const st = state[i]
        if (!anchor) {
          // Resting map: barely-there hairlines, and the spine recedes so the
          // cross-routes carry the eye.
          st.energyTo = l.spine ? 0.035 : 0.06
          st.threadTo = l.spine ? 0.8 : 1
          st.sparseTo = 1
          continue
        }
        const touches = l.from === anchor || l.to === anchor
        if (touches) {
          st.energyTo = sel ? 1 : 0.5
          st.threadTo = 1.3
          st.sparseTo = 0
          st.dirWanted = l.from === anchor ? 1 : -1
        } else {
          st.energyTo = 0
          st.threadTo = sel ? 0.22 : 0.7
          st.sparseTo = 1
        }
      }
    },

    update(dt) {
      const d = Math.min(dt, 0.1)
      flow = (flow + d * RATE) % 1
      slow = (slow + d * 0.35) % (Math.PI * 2)
      uniforms.uFlow.value = flow
      uniforms.uSlow.value = slow

      const k = 1 - Math.exp(-d * 6)
      for (let i = 0; i < n; i++) {
        const st = state[i]
        // A pulse train cannot reverse mid-flight, so hold the lane dark until
        // it is faint enough for the flip to be invisible.
        const flipping = st.dirWanted !== st.dir
        const target = flipping ? 0 : st.energyTo
        st.energy += (target - st.energy) * k
        if (flipping && st.energy < 0.1) st.dir = st.dirWanted
        st.thread += (st.threadTo - st.thread) * k
        st.sparse += (st.sparseTo - st.sparse) * k

        const o = i * 4
        iState[o] = st.energy
        iState[o + 1] = st.dir
        iState[o + 2] = st.thread
        iState[o + 3] = st.sparse
      }
      stateAttr.needsUpdate = true
    },

    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
