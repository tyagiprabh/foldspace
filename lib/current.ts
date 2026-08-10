/**
 * Filament & Charge — the lane layer.
 *
 * Two draw calls total:
 *   1. `filament`  one LineSegments: every lane as a subdivided Bezier arc,
 *      pre-mixed toward the background to fake per-line opacity (the existing
 *      trick, moved onto the GPU so it needs no per-frame CPU work).
 *   2. `charge`    one instanced quad batch: tapered, camera-facing streaks that
 *      run the same Bezier. Nothing about a charge lives on the CPU.
 *
 * The only animated quantity in the whole effect is one float per lane —
 * `laneEnergy` — living in a lanes.length x 1 RGBA32F DataTexture. Both shaders
 * read it. That is the entire per-frame upload.
 */
import * as THREE from 'three'
import { byId, colorUnder, lanes, neighboursOf } from './graph'
import type { Lens } from './graph'
import { hash01 } from './layout'

/** Polyline segments per lane on the filament. */
const SEG = 12
/** Bezier bow as a fraction of chord length. Visible sag is half this. */
const BOW = 0.16
/** Charge packets per lane, particles per packet. */
const PACKETS = 2
const TRAIN = 4
/** Lane-fraction gap between a packet's particles. */
const TRAIL = 0.036
const TRAIL_SPAN = TRAIL * (TRAIN - 1)
/** Resting energy of an unselected lane. Below this a lane is being ghosted. */
const IDLE_E = 0.28
/** Charge speed, world units per second. */
const SPEED = 2.4

export interface CurrentSkin {
  bg: number
  fogNear: number
  fogFar: number
  /** Additive reads as light on navy; sand needs alpha-over ink. */
  additive: boolean
  /** Hairline alpha at rest / when hot / when ghosted by a selection. */
  lineIdle: number
  lineHot: number
  lineGhost: number
  /** How much of the charge survives on a resting lane. */
  idleGain: number
  /** Nucleus bloom: toward white on navy, toward ink on sand. */
  hot: number
  master: number
}

export const CURRENT_SKIN: Record<'night' | 'day', CurrentSkin> = {
  night: {
    bg: 0x050811,
    fogNear: 46,
    fogFar: 130,
    additive: true,
    lineIdle: 0.05,
    lineHot: 0.7,
    lineGhost: 0.015,
    idleGain: 0.13,
    hot: 0.85,
    master: 1.0,
  },
  day: {
    bg: 0xe8e0d0,
    fogNear: 50,
    fogFar: 140,
    additive: false,
    lineIdle: 0.11,
    lineHot: 0.75,
    lineGhost: 0.033,
    idleGain: 0.17,
    hot: 0.58,
    master: 0.92,
  },
}

/* ── shared GLSL ─────────────────────────────────────────────────────────── */

const BEZ = /* glsl */ `
vec3 bezP(vec3 a, vec3 c, vec3 b, float t){
  float m = 1.0 - t;
  return m * m * a + 2.0 * m * t * c + t * t * b;
}
vec3 bezT(vec3 a, vec3 c, vec3 b, float t){
  return 2.0 * ((1.0 - t) * (c - a) + t * (b - c));
}
`

/** Dave Hoskins' hash — deterministic, no texture, ~6 ops. */
const HASH = /* glsl */ `
float hash21(vec2 p){
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
`

/* ── build ───────────────────────────────────────────────────────────────── */

const UP = new THREE.Vector3(0, 1, 0)

export interface Current {
  filament: THREE.LineSegments
  charge: THREE.Mesh
  /** Retarget lane energies. Cheap; the easing is per-frame and automatic. */
  select(sel: string | null): void
  /** Call once per frame. `cssHeight` and `fovDeg` size the min-pixel clamp. */
  update(elapsed: number, dt: number, cssHeight: number, fovDeg: number): void
  dispose(): void
}

export function buildCurrent(skin: CurrentSkin, lens: Lens): Current {
  const N = lanes.length
  const bgLinear = new THREE.Color(skin.bg)

  // ── per-lane geometry, computed once ──────────────────────────────────────
  const A = new Float32Array(N * 3)
  const B = new Float32Array(N * 3)
  const C = new Float32Array(N * 3)
  const COLA = new Float32Array(N * 3)
  const COLB = new Float32Array(N * 3)
  const curveLen = new Float32Array(N)

  const va = new THREE.Vector3()
  const vb = new THREE.Vector3()
  const vc = new THREE.Vector3()
  const chord = new THREE.Vector3()
  const perp = new THREE.Vector3()
  const axis = new THREE.Vector3()
  const p0 = new THREE.Vector3()
  const p1 = new THREE.Vector3()
  const col = new THREE.Color()

  function bez(t: number, out: THREE.Vector3, i: number) {
    const m = 1 - t
    const w0 = m * m
    const w1 = 2 * m * t
    const w2 = t * t
    return out.set(
      w0 * A[i * 3] + w1 * C[i * 3] + w2 * B[i * 3],
      w0 * A[i * 3 + 1] + w1 * C[i * 3 + 1] + w2 * B[i * 3 + 1],
      w0 * A[i * 3 + 2] + w1 * C[i * 3 + 2] + w2 * B[i * 3 + 2],
    )
  }

  lanes.forEach((l, i) => {
    const a = byId.get(l.from)!
    const b = byId.get(l.to)!
    va.set(a.x, a.y, a.z)
    vb.set(b.x, b.y, b.z)

    chord.subVectors(vb, va)
    const len = chord.length() || 1

    // A perpendicular that survives a vertical chord, then rotated about the
    // chord by a hashed angle so arcs are never coplanar — otherwise every
    // hub lane bows the same way and the map reads as a folded fan.
    perp.crossVectors(chord, UP)
    if (perp.lengthSq() < 1e-8) perp.set(1, 0, 0)
    perp.normalize()
    axis.copy(chord).divideScalar(len)
    perp.applyAxisAngle(axis, hash01(l.from + '>' + l.to + '#bow') * Math.PI * 2)

    vc.copy(va).add(vb).multiplyScalar(0.5).addScaledVector(perp, BOW * len)

    A.set([va.x, va.y, va.z], i * 3)
    B.set([vb.x, vb.y, vb.z], i * 3)
    C.set([vc.x, vc.y, vc.z], i * 3)

    col.set(colorUnder(a, lens))
    COLA.set([col.r, col.g, col.b], i * 3)
    col.set(colorUnder(b, lens))
    COLB.set([col.r, col.g, col.b], i * 3)
  })

  // Arc length by polyline sum — exact enough, and it is what makes every
  // lane's charge travel at the same world-space velocity.
  for (let i = 0; i < N; i++) {
    let acc = 0
    bez(0, p0, i)
    for (let j = 1; j <= SEG; j++) {
      bez(j / SEG, p1, i)
      acc += p0.distanceTo(p1)
      p0.copy(p1)
    }
    curveLen[i] = Math.max(acc, 0.001)
  }

  // ── lane state: R = energy, G = flow reversed, B/A spare ──────────────────
  const state = new Float32Array(N * 4)
  const energy = new Float32Array(N)
  const energyTo = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    energy[i] = IDLE_E
    energyTo[i] = IDLE_E
    state[i * 4] = IDLE_E
  }
  const stateTex = new THREE.DataTexture(state, N, 1, THREE.RGBAFormat, THREE.FloatType)
  // Nearest is not a preference: linear filtering of RGBA32F needs
  // OES_texture_float_linear, which is not universal.
  stateTex.magFilter = THREE.NearestFilter
  stateTex.minFilter = THREE.NearestFilter
  stateTex.generateMipmaps = false
  stateTex.needsUpdate = true

  const shared = {
    uLaneState: { value: stateTex },
    uLaneCount: { value: N },
    uFogNear: { value: skin.fogNear },
    uFogFar: { value: skin.fogFar },
  }

  /* ── layer 1: the filament ─────────────────────────────────────────────── */

  const fPos = new Float32Array(N * SEG * 2 * 3)
  const fCol = new Float32Array(N * SEG * 2 * 3)
  const fLane = new Float32Array(N * SEG * 2)
  const fS = new Float32Array(N * SEG * 2)

  let w = 0
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < SEG; j++) {
      for (const s of [j / SEG, (j + 1) / SEG]) {
        bez(s, p0, i)
        fPos.set([p0.x, p0.y, p0.z], w * 3)
        // A lane carries its own endpoints' colours, so the thread is a true
        // source -> target gradient for free.
        for (let k = 0; k < 3; k++) fCol[w * 3 + k] = COLA[i * 3 + k] * (1 - s) + COLB[i * 3 + k] * s
        fLane[w] = i
        fS[w] = s
        w++
      }
    }
  }

  const filGeo = new THREE.BufferGeometry()
  filGeo.setAttribute('position', new THREE.BufferAttribute(fPos, 3))
  filGeo.setAttribute('aCol', new THREE.BufferAttribute(fCol, 3))
  filGeo.setAttribute('aLane', new THREE.BufferAttribute(fLane, 1))
  filGeo.setAttribute('aS', new THREE.BufferAttribute(fS, 1))

  const filMat = new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uBg: { value: bgLinear },
      uIdle: { value: skin.lineIdle },
      uHotA: { value: skin.lineHot },
      uGhost: { value: skin.lineGhost },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aCol;
      attribute float aLane;
      attribute float aS;
      uniform sampler2D uLaneState;
      uniform float uLaneCount;
      uniform vec3 uBg;
      uniform float uIdle, uHotA, uGhost, uFogNear, uFogFar;
      varying vec3 vColor;
      void main(){
        vec4 mv = viewMatrix * vec4(position, 1.0);
        float e = texture2D(uLaneState, vec2((aLane + 0.5) / uLaneCount, 0.5)).r;
        float a = e < ${IDLE_E}
          ? mix(uGhost, uIdle, e / ${IDLE_E})
          : mix(uIdle, uHotA, (e - ${IDLE_E}) / (1.0 - ${IDLE_E}));
        // Faintest mid-span: threads grow out of the bodies and evaporate
        // between them, which is what keeps 300 lanes from reading as a mesh.
        a *= 0.55 + 0.45 * abs(2.0 * aS - 1.0);
        float fogF = smoothstep(uFogNear, uFogFar, -mv.z);
        // Pre-mixing toward the background fakes opacity AND fog in one step,
        // because the fog colour IS the background colour.
        vColor = mix(uBg, aCol, a * (1.0 - fogF));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main(){
        gl_FragColor = vec4(vColor, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: false,
    depthWrite: false,
    fog: false,
  })

  const filament = new THREE.LineSegments(filGeo, filMat)
  filament.frustumCulled = false
  filament.renderOrder = -1

  /* ── layer 2: the charge ───────────────────────────────────────────────── */

  const perLane = N > 160 ? PACKETS * 3 : PACKETS * TRAIN
  const train = perLane / PACKETS
  const POOL = Math.min(N * perLane, 4096)

  const quad = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0])
  const chGeo = new THREE.InstancedBufferGeometry()
  chGeo.setAttribute('position', new THREE.BufferAttribute(quad, 3))
  chGeo.setIndex([0, 1, 2, 0, 2, 3])

  const iA = new Float32Array(POOL * 3)
  const iB = new Float32Array(POOL * 3)
  const iC = new Float32Array(POOL * 3)
  const iColA = new Float32Array(POOL * 3)
  const iColB = new Float32Array(POOL * 3)
  /** (packetPhase, trailLag, travelRate, packetSalt) */
  const iMeta = new Float32Array(POOL * 4)
  /** (laneIndex, rankInPacket 0..1) */
  const iId = new Float32Array(POOL * 2)

  for (let n = 0; n < POOL; n++) {
    const lane = Math.floor(n / perLane) % N
    const slot = n % perLane
    const packet = Math.floor(slot / train)
    const rank = slot % train

    for (let k = 0; k < 3; k++) {
      iA[n * 3 + k] = A[lane * 3 + k]
      iB[n * 3 + k] = B[lane * 3 + k]
      iC[n * 3 + k] = C[lane * 3 + k]
      iColA[n * 3 + k] = COLA[lane * 3 + k]
      iColB[n * 3 + k] = COLB[lane * 3 + k]
    }

    // Packet members share phase, rate and salt so the train never tears
    // across a lap boundary; only the trailing lag differs.
    const salt = hash01(`${lane}:${packet}#p`)
    iMeta[n * 4] = (packet + salt) / PACKETS
    iMeta[n * 4 + 1] = rank * TRAIL
    iMeta[n * 4 + 2] = (0.9 + 0.2 * hash01(`${lane}:${packet}#v`)) / curveLen[lane]
    iMeta[n * 4 + 3] = salt

    iId[n * 2] = lane
    iId[n * 2 + 1] = train > 1 ? rank / (train - 1) : 0
  }

  chGeo.setAttribute('iA', new THREE.InstancedBufferAttribute(iA, 3))
  chGeo.setAttribute('iB', new THREE.InstancedBufferAttribute(iB, 3))
  chGeo.setAttribute('iC', new THREE.InstancedBufferAttribute(iC, 3))
  chGeo.setAttribute('iColA', new THREE.InstancedBufferAttribute(iColA, 3))
  chGeo.setAttribute('iColB', new THREE.InstancedBufferAttribute(iColB, 3))
  chGeo.setAttribute('iMeta', new THREE.InstancedBufferAttribute(iMeta, 4))
  chGeo.setAttribute('iId', new THREE.InstancedBufferAttribute(iId, 2))
  chGeo.instanceCount = POOL
  // The bounding sphere describes the unit quad, not the instances.
  chGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)

  const chMat = new THREE.ShaderMaterial({
    defines: { LIGHT_SKIN: skin.additive ? 0 : 1 },
    uniforms: {
      ...shared,
      uTime: { value: 0 },
      uSpeed: { value: SPEED },
      uPixelScale: { value: 0.002 },
      uIdleGain: { value: skin.idleGain },
      uMaster: { value: skin.master },
      uHot: { value: skin.hot },
      uLenIdle: { value: 0.3 },
      uLenHot: { value: 1.05 },
      uWidIdle: { value: 0.03 },
      uWidHot: { value: 0.055 },
      uEmitIdle: { value: 0.085 },
      uEmitHot: { value: 0.8 },
      uTailWidth: { value: 0.22 },
      uTailFall: { value: 3.4 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 iA;
      attribute vec3 iB;
      attribute vec3 iC;
      attribute vec3 iColA;
      attribute vec3 iColB;
      attribute vec4 iMeta;
      attribute vec2 iId;

      uniform sampler2D uLaneState;
      uniform float uLaneCount, uTime, uSpeed, uPixelScale;
      uniform float uIdleGain, uMaster, uLenIdle, uLenHot, uWidIdle, uWidHot;
      uniform float uEmitIdle, uEmitHot, uTailWidth, uFogNear, uFogFar;

      varying vec2 vQ;
      varying vec3 vCol;
      varying float vGain;

      ${BEZ}
      ${HASH}

      void main(){
        vec4 st = texture2D(uLaneState, vec2((iId.x + 0.5) / uLaneCount, 0.5));
        float e = st.r;
        float rev = st.g;

        // 0 while resting, 1 when the lane is in the selected neighbourhood.
        float act = smoothstep(${IDLE_E}, 1.0, e);
        // Collapses to nothing as a lane is ghosted out.
        float alive = smoothstep(0.0, ${IDLE_E}, e);

        float rank = iId.y;
        float rankSize = mix(1.0, 0.46, rank);
        float rankLit = mix(1.0, 0.30, rank);

        float travel = iMeta.x + uTime * uSpeed * iMeta.z;
        float lap = floor(travel);
        float u = fract(travel) - iMeta.y;

        float fire = hash21(vec2(iId.x * 13.17 + iMeta.w * 71.3, lap));
        float emitProb = mix(uEmitIdle, uEmitHot, act);
        // Per-lap jitter so no two firings of the same lane look alike.
        float lapLit = 0.72 + 0.5 * hash21(vec2(lap * 3.71, iId.x + iMeta.w));

        float gain = mix(uIdleGain, 1.0, act) * alive * rankLit * lapLit * uMaster;

        if (u < 0.0 || fire > emitProb || gain < 0.002) {
          // z/w = 2 -> clipped. All four corners collapse, so no fragments.
          gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
          return;
        }

        // Swapping the endpoints (not the parameter) makes the tangent, the
        // colour ramp and the endpoint shaping all follow the flow direction.
        vec3 pa = mix(iA, iB, rev);
        vec3 pb = mix(iB, iA, rev);
        vec3 ca = mix(iColA, iColB, rev);
        vec3 cb = mix(iColB, iColA, rev);

        vec3 P = bezP(pa, iC, pb, u);
        vec3 T = bezT(pa, iC, pb, u);

        vec4 mv = viewMatrix * vec4(P, 1.0);
        vec3 tv = mat3(viewMatrix) * normalize(T);
        float fore = length(tv.xy);
        vec2 ax = fore > 1e-4 ? tv.xy / fore : vec2(1.0, 0.0);
        vec2 ay = vec2(-ax.y, ax.x);

        // One pixel subtends depth * 2*tan(fov/2)/height world units, so this
        // is the floor that stops a distant streak shimmering below a pixel.
        float depth = -mv.z;
        float wpp = max(depth, 0.001) * uPixelScale;

        float wid = max(mix(uWidIdle, uWidHot, act) * rankSize, wpp);
        // A streak seen end-on IS a dot: foreshortening falls out for free.
        float len = max(mix(uLenIdle, uLenHot, act) * rankSize * mix(0.3, 1.0, fore), wid);

        float along = position.x * 0.5 + 0.5;          // 0 tail, 1 head
        float taper = mix(uTailWidth, 1.0, along);
        // Head sits exactly on P; the body trails behind it.
        mv.xy += (along - 1.0) * 2.0 * len * ax + position.y * wid * taper * ay;

        float born = smoothstep(0.0, 0.05, u);
        float land = 1.0 - smoothstep(0.90, 1.0, u);
        float flare = 1.0 + 0.45 * smoothstep(0.55, 0.93, u);
        float fogF = smoothstep(uFogNear, uFogFar, depth);

        vQ = vec2(along, position.y);
        // The charge takes on the colour of where it is going.
        vCol = mix(ca, cb, smoothstep(0.12, 0.88, u));
        vGain = gain * born * land * flare * (1.0 - fogF);

        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uHot, uTailFall;
      varying vec2 vQ;
      varying vec3 vCol;
      varying float vGain;
      void main(){
        float across = vQ.y;
        float along = vQ.x;
        float body = exp(-3.4 * across * across);
        float tail = exp(-uTailFall * (1.0 - along));
        float head = 1.0 - along;
        float nucleus = exp(-26.0 * (across * across + head * head * 9.0));

        float g = clamp(body * tail + 1.7 * nucleus, 0.0, 1.0) * vGain;
        if (g < 0.004) discard;

        vec3 c = vCol;
        #if LIGHT_SKIN == 1
          // Sand cannot take additive light, so the nucleus goes darker and
          // more saturated instead of whiter.
          vec3 ink = c * 0.45;
          ink = mix(vec3(dot(ink, vec3(0.2126, 0.7152, 0.0722))), ink, 1.4);
          c = mix(ink, ink * 0.55, clamp(nucleus * 2.0, 0.0, 1.0));
          gl_FragColor = vec4(c, g * 0.9);
        #else
          c += uHot * nucleus;
          gl_FragColor = vec4(c, g);
        #endif
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: skin.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
    fog: false,
  })

  const charge = new THREE.Mesh(chGeo, chMat)
  charge.frustumCulled = false
  charge.renderOrder = 2

  /* ── drive ─────────────────────────────────────────────────────────────── */

  let dirty = true

  function select(sel: string | null) {
    const near = sel ? neighboursOf(sel) : null
    for (let i = 0; i < N; i++) {
      const l = lanes[i]
      if (!near) {
        energyTo[i] = IDLE_E
        state[i * 4 + 1] = 0
      } else {
        const hot = near.has(l.from) && near.has(l.to)
        energyTo[i] = hot ? 1 : 0
        // Charge always runs outward from the body you picked.
        if (hot) state[i * 4 + 1] = l.to === sel ? 1 : 0
      }
    }
    dirty = true
  }

  function update(elapsed: number, dt: number, cssHeight: number, fovDeg: number) {
    chMat.uniforms.uTime.value = elapsed
    chMat.uniforms.uPixelScale.value =
      (2 * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(cssHeight, 1)

    if (dirty) {
      const k = 1 - Math.pow(0.001, Math.min(dt, 0.1) * 4.5)
      let settled = true
      for (let i = 0; i < N; i++) {
        const d = energyTo[i] - energy[i]
        if (Math.abs(d) < 0.0015) energy[i] = energyTo[i]
        else {
          energy[i] += d * k
          settled = false
        }
        state[i * 4] = energy[i]
      }
      stateTex.needsUpdate = true
      dirty = !settled
    }
  }

  return {
    filament,
    charge,
    select,
    update,
    dispose() {
      filGeo.dispose()
      filMat.dispose()
      chGeo.dispose()
      chMat.dispose()
      stateTex.dispose()
    },
  }
}
