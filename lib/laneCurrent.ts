/**
 * Lanes, and the current that runs through them.
 *
 * One InstancedBufferGeometry, one ShaderMaterial, one Mesh, one draw call, at
 * any lane count. Each lane is a quadratic Bézier expanded in the vertex shader
 * to a constant CSS-pixel-wide ribbon, so a hairline stays a hairline at every
 * zoom. The current is not objects sliding along the line: it is an analytic
 * function of arc position, time and per-lane phase, evaluated per pixel inside
 * that ribbon, so the thread itself brightens and swells as the pulse passes.
 *
 * COLOUR SPACE — read before touching any alpha in here. Lane colours are
 * authored in DISPLAY space (`setStyle(css, LinearSRGBColorSpace)` stores the
 * raw hex fractions, and three's sRGB→linear conversion is then a no-op) and
 * the fragment shader deliberately OMITS `#include <colorspace_fragment>`. So
 * every alpha below is literally what the framebuffer receives. Authoring in
 * linear and letting the renderer encode would push a 0.014 hairline out at
 * 31/255 instead of 4/255 — an eightfold error in the toe, which is exactly
 * where "barely there" lives. This is only correct while
 * `renderer.outputColorSpace` stays SRGBColorSpace and `renderer.toneMapping`
 * stays NoToneMapping. Both are the defaults and Starmap.tsx never changes
 * them; if either changes, this file has to change with it.
 */
import * as THREE from 'three'

import { byId, colorUnder, lanes, placed } from './graph'
import type { Lens } from './graph'
import { hash01 } from './layout'

/* ── physics, in world units ───────────────────────────────────────────────
 * SPACING and SPEED are world quantities, never per-lane fractions. That is
 * the whole trick: `cycles = laneLength / SPACING` falls out, so every pulse on
 * the map travels at one velocity and sits one gap behind the one in front, and
 * 37 lanes spanning 0.5 to 23 world units read as one circulatory system
 * instead of 37 unrelated loops. The reference's `t = 0.4 * elapsed % 1` is a
 * per-lane normalised period, which makes short lanes strobe and long ones
 * crawl.
 */
const SPACING = 9.0
const SPEED = 5.2
/** Cycles per second. `uFlow` is this, integrated in a double and wrapped. */
const RATE = SPEED / SPACING

/** Ribbon segments per lane. Needed for CURVATURE only — see the vertex shader. */
const SEG_NEAR = 14
const SEG_FAR = 8
const SEG_SWITCH = 160

/** A lane shorter than this cannot hold a travelling pulse; it glows instead. */
const CARRY_LO = 1.8
const CARRY_HI = 5.0
/** Lanes at or above this carry factor are eligible for an idle pulse. */
const CARRIER_MIN = 0.9

/** Idle current: an ABSOLUTE budget. 300 lanes must not be busier than 37. */
const IDLE_ENERGY = 0.13
const IDLE_SWAP = 3.4

/** Route bow, as a fraction of chord. The spine never bows. */
const BOW_BASE = 0.045
const BOW_HUB = 0.075

/** Easing time constants, seconds. Rise fast, decay slow. */
const TAU_UP = 0.13
const TAU_DOWN = 0.34

export interface LaneSkin {
  additive: boolean
  bg: number
  fogNear: number
  fogFar: number
  /** Comet core tint: near-white on navy, near-black ink on sand. */
  hot: number
  hotMix: number
  /** Display-space alpha of a resting hairline at thread = 1. */
  threadA: number
  coreA: number
  glowA: number
  /** Gaussian half-widths in CSS px. Never take `hair` below 0.55 — see risks. */
  hair: number
  core: number
  glow: number
  /** Ribbon width in CSS px. Must comfortably contain the glow lobe. */
  width: number
}

export const LANE_SKIN: Record<'night' | 'day', LaneSkin> = {
  night: {
    additive: true,
    bg: 0x050811,
    fogNear: 46,
    fogFar: 130,
    hot: 0xeaf1ff,
    hotMix: 0.42,
    threadA: 0.06,
    coreA: 0.72,
    glowA: 0.16,
    hair: 0.62,
    core: 1.5,
    glow: 3.0,
    width: 9,
  },
  day: {
    // Additive light on sand saturates before it reads, so on the light skin the
    // current runs DOWN, not up: the pulse is ink soaking into paper. Normal
    // blending with an un-premultiplied colour/coverage pair gives exact alpha
    // control and no saturation ceiling.
    additive: false,
    bg: 0xe8e0d0,
    fogNear: 50,
    fogFar: 140,
    hot: 0x141a24,
    hotMix: 0.55,
    threadA: 0.15,
    coreA: 0.58,
    glowA: 0.13,
    hair: 0.6,
    core: 1.4,
    glow: 2.8,
    width: 8,
  },
}

/* ── thread weights (multipliers on skin.threadA) ─────────────────────────── */
const T_IDLE_SPINE = 0.8
const T_IDLE_ROUTE = 1.0
const T_HOVER_NEAR = 2.2
const T_SEL_INCIDENT = 3.0
const T_SEL_NEAR = 1.4
const T_SEL_FAR = 0.28

const VERTEX = /* glsl */ `
  attribute vec3 iA;
  attribute vec3 iB;
  attribute vec3 iC;      // quadratic Bezier control; == midpoint on the spine
  attribute vec3 iColA;
  attribute vec3 iColB;
  attribute vec4 iMeta;   // x cycles, y phase, z carry, w spine flag
  attribute vec2 iState;  // x energy, y thread

  uniform vec2  uResolution;   // CSS pixels
  uniform float uWidth;
  uniform float uTaper;
  uniform float uFlow;
  uniform float uFogNear;
  uniform float uFogFar;

  varying float vSide;
  varying float vHalf;
  varying float vHead;
  varying float vCarry;
  varying float vEdge;
  varying float vDepth;
  varying float vEnergy;
  varying float vThread;
  varying vec3  vHue;

  void main() {
    // The template smuggles its two parameters through 'position', so three has
    // the attribute it wants for bookkeeping at no extra cost.
    float s    = position.x;
    float side = position.y;

    // Quadratic Bezier and its exact derivative — three mixes and one lerp.
    // Subdivision buys CURVATURE only: vHead is linear in s, so even a
    // two-vertex segment gives the fragment shader full per-pixel resolution of
    // the travelling band. That is why SEG can be cut freely at scale.
    vec3 p  = mix( mix( iA, iC, s ), mix( iC, iB, s ), s );
    vec3 dp = 2.0 * ( ( 1.0 - s ) * ( iC - iA ) + s * ( iB - iC ) );

    vec4 mv    = modelViewMatrix * vec4( p, 1.0 );
    vec4 clip  = projectionMatrix * mv;
    vec4 dClip = projectionMatrix * ( modelViewMatrix * vec4( dp, 0.0 ) );

    // Exact screen-space tangent by the quotient rule: d(clip.xy/clip.w)/ds.
    // Better conditioned than projecting a nearby sample point, and it removes
    // an epsilon from the tuning surface.
    float invW2 = 1.0 / max( clip.w * clip.w, 1e-8 );
    vec2  ndcD  = ( dClip.xy * clip.w - clip.xy * dClip.w ) * invW2;

    float aspect = uResolution.x / max( uResolution.y, 1.0 );
    vec2  dpx    = vec2( ndcD.x * aspect, ndcD.y );
    float dl     = length( dpx );
    vec2  nrm    = dl > 1e-7 ? vec2( -dpx.y, dpx.x ) / dl : vec2( 0.0, 1.0 );

    // Constant CSS-pixel width, with a gentle taper that hands back the depth
    // cue a fixed width would otherwise throw away.
    float depth  = -mv.z;
    float halfPx = uWidth * 0.5 * mix( 1.0, uTaper, smoothstep( uFogNear * 0.35, uFogFar, depth ) );

    vec2 off = vec2( nrm.x / aspect, nrm.y ) * ( halfPx * 2.0 / max( uResolution.y, 1.0 ) ) * side;
    // step() collapses the offset behind the camera rather than letting a
    // negative w flip the ribbon's sign for a segment.
    clip.xy += off * clip.w * step( 1e-5, clip.w );
    gl_Position = clip;

    vSide  = side;
    vHalf  = halfPx;
    // Deliberately NOT fract()-ed here: wrapping in the vertex stage would tear
    // the interpolation. The fragment shader wraps per pixel.
    vHead  = s * iMeta.x + iMeta.y - uFlow;
    vCarry = iMeta.z;
    // Pixels of screen travel per unit of s, i.e. roughly the lane's on-screen
    // length. A lane pointing at the camera cannot show a pulse travel, only
    // alias, so it falls back to a steady glow instead.
    vEdge  = smoothstep( 28.0, 90.0, dl * uResolution.y * 0.5 );
    vDepth = depth;
    vEnergy = iState.x;
    vThread = iState.y;
    // Display-space gradient, so a lane states the relation between two
    // coloured bodies without going muddy in the middle.
    vHue   = mix( iColA, iColB, s );
  }
`

const FRAGMENT = /* glsl */ `
  uniform float uHair;
  uniform float uCore;
  uniform float uGlow;
  uniform float uNucK;
  uniform float uWakeK;
  uniform float uThreadA;
  uniform float uCoreA;
  uniform float uGlowA;
  uniform float uHotMix;
  uniform float uGate;
  uniform vec3  uHot;
  uniform vec3  uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying float vSide;
  varying float vHalf;
  varying float vHead;
  varying float vCarry;
  varying float vEdge;
  varying float vDepth;
  varying float vEnergy;
  varying float vThread;
  varying vec3  vHue;

  void main() {
    float r = abs( vSide ) * vHalf;   // pixels from the centreline

    // ── along the lane ─────────────────────────────────────────────────────
    // The head sits at the cycle wrap. 'a' is cycles ahead of it, so (1 - a) is
    // cycles behind it: the wake exists ONLY behind, which is what makes a
    // single still frame read as directional current rather than a sliding
    // blob. Reverse the two and the comet points backwards.
    float a       = fract( vHead );
    float dHead   = min( a, 1.0 - a );                    // cycles from the head
    float nucleus = exp2( -dHead * dHead * uNucK );        // tight, C1 at the wrap
    float wake    = exp2( -( 1.0 - a ) * uWakeK );         // long, behind only

    // A lane too short to hold a whole pulse, or one seen nearly end-on, glows
    // steadily instead of strobing — a moving band a few pixels long can only
    // alias. One mix each, no branch, graceful in both directions.
    float m     = vCarry * vEdge;
    float eCore = vEnergy * uGate * mix( 1.0, max( nucleus, wake * 0.30 ), m );
    float eGlow = vEnergy * uGate * mix( 1.0, min( 1.0, wake * 0.85 + nucleus * 0.5 ), m );

    // ── across the lane ────────────────────────────────────────────────────
    // Three Gaussian lobes share one fixed-width ribbon. Only the amplitudes
    // move, so the thread visibly SWELLS as the pulse passes with no geometry
    // change — and the Gaussian gives real antialiasing that a 1px line cannot.
    // The nucleus drives the narrow core and the wake drives the wide skirt, so
    // the head is a compact bright point and the coma spreads out behind it.
    // The window makes sure the quad's own edge is never visible.
    float win = 1.0 - smoothstep( 0.70, 1.0, abs( vSide ) );
    float rr  = r * r;
    float aT  = exp2( -rr / ( uHair * uHair ) ) * vThread * uThreadA;
    float aC  = exp2( -rr / ( uCore * uCore ) ) * eCore * uCoreA;
    float aG  = exp2( -rr / ( uGlow * uGlow ) ) * eGlow * uGlowA;

    float cov = ( aT + aC + aG ) * win;
    if ( cov < 0.0015 ) discard;

    vec3 rad = ( vHue * ( aT + aG ) + mix( vHue, uHot, uHotMix ) * aC ) * win;

    float fogK = smoothstep( uFogNear, uFogFar, vDepth );

    #ifdef LANE_ADDITIVE
      // Fog must ATTENUATE additive radiance. Mixing toward the fog colour
      // would ADD the background and make distant lanes brighter as they
      // recede. Alpha stays 1 so blendFuncSeparate(SRC_ALPHA, ONE, ...) makes
      // the add exact and all the fog lives in rgb.
      gl_FragColor = vec4( rad * ( 1.0 - fogK ), 1.0 );
    #else
      // Un-premultiply into a straight colour plus coverage: a proper weighted
      // average of the lane hue and the ink, with exact alpha control and no
      // saturation ceiling on a light ground.
      gl_FragColor = vec4( mix( rad / max( cov, 1e-4 ), uFogColor, fogK ),
                           min( cov, 1.0 ) * ( 1.0 - fogK * 0.85 ) );
    #endif

    // NOTE: <colorspace_fragment> is deliberately absent. See the file header.
  }
`

export interface LaneArrival {
  id: string
  strength: number
}

export interface LaneCurrent {
  mesh: THREE.Mesh
  /** Node ids a pulse landed on this frame. Read in the same frame; cleared per update. */
  arrivals: LaneArrival[]
  /** CSS pixels, straight from the ResizeObserver. */
  setResolution(w: number, h: number): void
  /** Hover lifts threads only; current is reserved for a click. */
  setStates(sel: string | null, hov: string | null): void
  update(dt: number, flying: boolean): void
  dispose(): void
}

interface LaneRt {
  energy: number
  energyTo: number
  thread: number
  threadTo: number
  /** fract(cycles + phase - flow) last frame, for arrival detection. */
  arr: number
  carry: number
  to: string
}

const UP = new THREE.Vector3(0, 1, 0)
const ALT = new THREE.Vector3(1, 0, 0)

/** Display-space colour: the raw hex fractions, with no sRGB→linear step. */
function displayColor(css: string, out: THREE.Color): THREE.Color {
  return out.setStyle(css, THREE.LinearSRGBColorSpace)
}

function smooth01(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Distance from the origin to segment AB, exact (clamped projection). */
function originToSegment(a: THREE.Vector3, b: THREE.Vector3, tmp: THREE.Vector3): number {
  tmp.copy(b).sub(a)
  const ll = tmp.lengthSq() || 1
  const t = Math.min(1, Math.max(0, -a.dot(tmp) / ll))
  return tmp.multiplyScalar(t).add(a).length()
}

function template(seg: number) {
  const pos = new Float32Array((seg + 1) * 2 * 3)
  for (let i = 0; i <= seg; i++) {
    const s = i / seg
    const o = i * 6
    pos[o] = s
    pos[o + 1] = -1
    pos[o + 3] = s
    pos[o + 4] = 1
  }
  const idx = new Uint16Array(seg * 6)
  for (let i = 0; i < seg; i++) {
    const o = i * 2
    idx.set([o, o + 1, o + 2, o + 2, o + 1, o + 3], i * 6)
  }
  return { pos, idx }
}

export function createLaneCurrent(skin: LaneSkin, lens: Lens): LaneCurrent {
  const n = lanes.length
  const seg = n > SEG_SWITCH ? SEG_FAR : SEG_NEAR
  const width = n > SEG_SWITCH ? skin.width * 0.8 : skin.width
  // Additive hairlines accumulate: without this the resting map goes from
  // "barely there" to milk soup as the graph grows. Only the thread and the
  // soft skirt are scaled — the pulse core keeps its punch.
  const density = Math.min(1, Math.max(0.32, 60 / n))

  const { pos, idx } = template(seg)
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setIndex(new THREE.BufferAttribute(idx, 1))
  // Defaults to Infinity in 0.183, so it must be set explicitly.
  geometry.instanceCount = n
  // `position` holds template parameters, not coordinates, so any derived
  // bounds are meaningless. frustumCulled is off too.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)

  const iA = new Float32Array(n * 3)
  const iB = new Float32Array(n * 3)
  const iC = new Float32Array(n * 3)
  const iColA = new Float32Array(n * 3)
  const iColB = new Float32Array(n * 3)
  const iMeta = new Float32Array(n * 4)
  const iState = new Float32Array(n * 2)

  const A = new THREE.Vector3()
  const B = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const mid = new THREE.Vector3()
  const bow = new THREE.Vector3()
  const apex = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const col = new THREE.Color()

  const rt: LaneRt[] = []

  lanes.forEach((l, i) => {
    const from = byId.get(l.from)!
    const to = byId.get(l.to)!
    A.set(from.x, from.y, from.z)
    B.set(to.x, to.y, to.z)

    dir.copy(B).sub(A)
    const raw = dir.length() || 1
    dir.divideScalar(raw)

    // Start and end at the body SURFACES. A ribbon has a flat cap, and a cap
    // poking out past a small moon is visible; trimming also stops nine spokes
    // stacking their brightest pixels into one blown-out blob on the hub.
    const trimA = Math.min(from.radius + 0.05, raw * 0.35)
    const trimB = Math.min(to.radius + 0.05, raw * 0.35)
    A.addScaledVector(dir, trimA)
    B.addScaledVector(dir, -trimB)
    const len = Math.max(0.2, raw - trimA - trimB)

    mid.copy(A).add(B).multiplyScalar(0.5)

    const key = `${l.from}>${l.to}`

    if (l.spine) {
      // Structure is rigid. The control point AT the midpoint makes the
      // quadratic algebraically the chord, so one code path serves both and a
      // dead-straight spine costs nothing.
      iC.set([mid.x, mid.y, mid.z], i * 3)
    } else {
      // Routes bow AWAY from the origin, hardest when the chord would otherwise
      // skewer the hub — so the arc encodes how close the relationship would
      // have passed to the centre, and the middle of the map stops filling with
      // chords. Magnitudes stay small: this is a star map, not a spiral galaxy.
      const h = originToSegment(A, B, tmp)
      const mag = len * (BOW_BASE + BOW_HUB * (1 - smooth01(0, 9, h)))

      bow.copy(mid)
      if (bow.lengthSq() < 1e-6) bow.copy(UP)
      bow.normalize()
      // Orthogonalise against the chord, with a fallback for a radial chord.
      bow.addScaledVector(dir, -bow.dot(dir))
      if (bow.lengthSq() < 1e-8) {
        bow.copy(dir).cross(Math.abs(dir.y) > 0.94 ? ALT : UP)
        if (bow.lengthSq() < 1e-8) bow.copy(ALT)
      }
      bow.normalize()

      // A hashed twist so two routes between the same pair never coincide,
      // hashed rather than indexed for the same reason layout.ts hashes: adding
      // a lane must never move an existing one. Re-rolled if the apex would
      // pass through a body this lane does not connect — deterministic, and it
      // runs once per rebuild.
      const twisted = bow.clone()
      for (let k = 0; k < 6; k++) {
        twisted.copy(bow).applyAxisAngle(dir, (hash01(`${key}#bow${k}`) - 0.5) * 1.1).normalize()
        // B(0.5) = mid + 0.5*(C - mid), so the control point needs twice the sag.
        apex.copy(mid).addScaledVector(twisted, mag)
        let clear = true
        for (const p of placed) {
          if (p.id === l.from || p.id === l.to) continue
          const dx = apex.x - p.x
          const dy = apex.y - p.y
          const dz = apex.z - p.z
          if (dx * dx + dy * dy + dz * dz < (p.radius + 0.22) * (p.radius + 0.22)) {
            clear = false
            break
          }
        }
        if (clear) break
      }
      iC.set([mid.x + twisted.x * mag * 2, mid.y + twisted.y * mag * 2, mid.z + twisted.z * mag * 2], i * 3)
    }

    iA.set([A.x, A.y, A.z], i * 3)
    iB.set([B.x, B.y, B.z], i * 3)

    displayColor(colorUnder(from, lens), col)
    iColA.set([col.r, col.g, col.b], i * 3)
    displayColor(colorUnder(to, lens), col)
    iColB.set([col.r, col.g, col.b], i * 3)

    // `cycles` is deliberately non-integer and unclamped: a lane shorter than
    // the spacing simply has a gap sometimes, which is what real spacing looks
    // like. `carry` fades a travelling pulse out on lanes too short to hold
    // one — the 18 world→moon stubs run 0.5 to 2.2 units, where a comet could
    // only ever be a fragment, so they glow instead of flickering.
    const carry = smooth01(CARRY_LO, CARRY_HI, len)
    iMeta.set([len / SPACING, hash01(`${key}#phase`), carry, l.spine ? 1 : 0], i * 4)

    rt.push({
      energy: 0,
      energyTo: 0,
      thread: l.spine ? T_IDLE_SPINE : T_IDLE_ROUTE,
      threadTo: l.spine ? T_IDLE_SPINE : T_IDLE_ROUTE,
      arr: -1,
      carry,
      to: l.to,
    })
    iState[i * 2] = 0
    iState[i * 2 + 1] = rt[i].thread
  })

  geometry.setAttribute('iA', new THREE.InstancedBufferAttribute(iA, 3))
  geometry.setAttribute('iB', new THREE.InstancedBufferAttribute(iB, 3))
  geometry.setAttribute('iC', new THREE.InstancedBufferAttribute(iC, 3))
  geometry.setAttribute('iColA', new THREE.InstancedBufferAttribute(iColA, 3))
  geometry.setAttribute('iColB', new THREE.InstancedBufferAttribute(iColB, 3))
  geometry.setAttribute('iMeta', new THREE.InstancedBufferAttribute(iMeta, 4))
  const stateAttr = new THREE.InstancedBufferAttribute(iState, 2)
  stateAttr.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('iState', stateAttr)

  const uniforms: Record<string, THREE.IUniform> = {
    uResolution: { value: new THREE.Vector2(1, 1) },
    uWidth: { value: width },
    uTaper: { value: 0.66 },
    uFlow: { value: 0 },
    uGate: { value: 1 },
    uHair: { value: skin.hair },
    uCore: { value: skin.core },
    uGlow: { value: skin.glow },
    // 1300 → the nucleus is half-bright 0.25 world units from the head, so the
    // charge is a compact ~12px point at default framing, Gaussian and
    // therefore antialiased rather than a one-pixel step.
    uNucK: { value: 1300.0 },
    // 9 → the coma is half-bright 1.0 world unit behind the head and gone by
    // about 4. Below ~6 the wake smears over the whole lane and stops reading
    // as a comet.
    uWakeK: { value: 9.0 },
    uThreadA: { value: skin.threadA * density },
    uCoreA: { value: skin.coreA },
    uGlowA: { value: skin.glowA * (0.5 + density * 0.5) },
    uHotMix: { value: skin.hotMix },
    uHot: { value: new THREE.Color().setHex(skin.hot, THREE.LinearSRGBColorSpace) },
    uFogColor: { value: new THREE.Color().setHex(skin.bg, THREE.LinearSRGBColorSpace) },
    uFogNear: { value: skin.fogNear },
    uFogFar: { value: skin.fogFar },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    defines: skin.additive ? { LANE_ADDITIVE: '' } : {},
    transparent: true,
    depthWrite: false,
    // Lanes still disappear correctly behind bodies.
    depthTest: true,
    // A ribbon expanded in SCREEN space has projection-dependent winding, so
    // FrontSide culls it away entirely — silently, with no error.
    side: THREE.DoubleSide,
    // fog:true would make three write into uniforms.fogColor/fogNear/fogFar,
    // which a bare ShaderMaterial does not have — it throws. Custom fog is
    // required for the additive branch anyway.
    fog: false,
    blending: skin.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  // AFTER the bodies (renderOrder 0, transparent but depth-writing), so a lane
  // in front of a sphere is not overpainted by it. renderOrder = -1 only looks
  // right because the spheres happen to cover the wrong case too.
  mesh.renderOrder = 2
  // Lanes are decoration; never let them swallow a click meant for a body.
  mesh.raycast = () => {}

  /* ── idle current: an absolute motion budget ──────────────────────────────
   * Only lanes long enough to hold a whole pulse are eligible, and only a fixed
   * few are lit at any moment, chosen by a deterministic staggered walk. The
   * cap does not scale with lane count, so a 300-lane map is exactly as calm as
   * a 37-lane one — which alpha scaling alone can never achieve.
   */
  const carriers: number[] = []
  for (let i = 0; i < n; i++) if (rt[i].carry >= CARRIER_MIN) carriers.push(i)
  // Ordered by hash so the walk is not index-correlated, and stable forever.
  carriers.sort((a, b) => hash01(`${a}#order`) - hash01(`${b}#order`))
  const IDLE_LIVE = carriers.length === 0 ? 0 : Math.min(4, Math.max(2, Math.round(carriers.length / 6)))

  const live = new Set<number>()
  const arrivals: LaneArrival[] = []
  let nearSel: Set<string> | null = null
  let sel: string | null = null
  let hov: string | null = null
  let flow = 0
  let clock = 0
  let gate = 1
  let dirty = true
  /** The idle set can only change on a slot boundary, so this is the whole test. */
  let idleTick = -1

  function idleSet(t: number) {
    live.clear()
    if (!carriers.length) return
    for (let j = 0; j < IDLE_LIVE; j++) {
      // Each slot keeps its own swap clock, so the set never turns over at once.
      const step = Math.floor(t / IDLE_SWAP + j / IDLE_LIVE)
      live.add(carriers[(step * IDLE_LIVE + j) % carriers.length])
    }
  }

  function retarget() {
    const anchor = sel ?? hov
    for (let i = 0; i < n; i++) {
      const l = lanes[i]
      const st = rt[i]
      const incident = anchor !== null && (l.from === anchor || l.to === anchor)

      if (sel === null) {
        // Hover is a preview: threads lift, nothing starts moving. A map that
        // twitches as the pointer sweeps is the definition of flashy.
        st.threadTo = hov === null ? (l.spine ? T_IDLE_SPINE : T_IDLE_ROUTE) : incident ? T_HOVER_NEAR : T_IDLE_ROUTE
        st.energyTo = hov === null && live.has(i) ? IDLE_ENERGY : 0
        continue
      }

      if (incident) {
        st.threadTo = T_SEL_INCIDENT
        st.energyTo = 1
      } else if (nearSel !== null && nearSel.has(l.from) && nearSel.has(l.to)) {
        // The middle tier is what makes a neighbourhood read as a
        // neighbourhood rather than a spotlight.
        st.threadTo = T_SEL_NEAR
        st.energyTo = 0.3
      } else {
        st.threadTo = T_SEL_FAR
        st.energyTo = 0
      }
    }
    dirty = true
  }

  return {
    mesh,
    arrivals,

    setResolution(w, h) {
      ;(uniforms.uResolution.value as THREE.Vector2).set(Math.max(1, w), Math.max(1, h))
    },

    setStates(nextSel, nextHov) {
      sel = nextSel
      hov = nextHov
      // Incident, not both-ends-in-neighbours: a lane between two neighbours
      // that never touches the selection belongs in the middle tier, not the
      // hot one.
      nearSel = sel ? new Set<string>([sel]) : null
      if (sel && nearSel) {
        for (const l of lanes) {
          if (l.from === sel) nearSel.add(l.to)
          if (l.to === sel) nearSel.add(l.from)
        }
      }
      retarget()
    },

    update(dt, flying) {
      const d = Math.min(dt, 0.1)
      clock += d
      arrivals.length = 0

      // Integrated in double precision and wrapped into [0,1). The pattern is
      // exactly periodic in one cycle, so the wrap is invisible and fract()
      // never loses mantissa bits however long the tab stays open.
      flow = (flow + d * RATE) % 1
      uniforms.uFlow.value = flow

      // Two motions fight: suppress the current during a scripted flight.
      gate += ((flying ? 0 : 1) - gate) * (1 - Math.exp(-d / 0.22))
      uniforms.uGate.value = gate

      if (sel === null && hov === null && IDLE_LIVE > 0) {
        const tick = Math.floor((clock * IDLE_LIVE) / IDLE_SWAP)
        if (tick !== idleTick) {
          idleTick = tick
          idleSet(clock)
          retarget()
        }
      }

      let moving = false
      for (let i = 0; i < n; i++) {
        const st = rt[i]

        const de = st.energyTo - st.energy
        if (Math.abs(de) > 4e-4) {
          st.energy += de * (1 - Math.exp(-d / (de > 0 ? TAU_UP : TAU_DOWN)))
          moving = true
        } else st.energy = st.energyTo

        const dth = st.threadTo - st.thread
        if (Math.abs(dth) > 4e-4) {
          st.thread += dth * (1 - Math.exp(-d / (dth > 0 ? TAU_UP : TAU_DOWN)))
          moving = true
        } else st.thread = st.threadTo

        iState[i * 2] = st.energy
        iState[i * 2 + 1] = st.thread

        // Arrival: a head sits at s where s*cycles + phase - flow is an
        // integer, so at the target end that quantity is cycles + phase - flow.
        // It decreases as flow grows, so a wrap upward means a head just
        // landed. Free, because the CPU already owns flow.
        if (st.carry > 0.5 && st.energy > 0.22) {
          const g = iMeta[i * 4] + iMeta[i * 4 + 1] - flow
          const now = g - Math.floor(g)
          // arr < 0 is "no previous sample", so a lane never glints the frame
          // it lights up.
          if (st.arr >= 0 && now - st.arr > 0.5) arrivals.push({ id: st.to, strength: Math.min(1, st.energy) })
          st.arr = now
        } else st.arr = -1
      }

      if (moving || dirty) {
        stateAttr.needsUpdate = true
        dirty = moving
      }
    },

    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
