'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'

import { byId, colorUnder, lanes, lanesFrom, neighboursOf, placed } from '../lib/graph'
import type { Lens, Placed } from '../lib/graph'

export type Theme = 'night' | 'day'

interface Props {
  theme: Theme
  lens: Lens
  selected: string | null
  focus: string | null
  onSelect: (id: string | null) => void
  onHover: (id: string | null) => void
}

/**
 * Two skins, both deliberately plain: no post-processing, no rings, no dust, no
 * grain. Bodies are flat discs of colour with a soft halo, and that is all.
 */
const SKIN = {
  night: {
    bg: 0x050811,
    fogNear: 46,
    fogFar: 130,
    ambient: 0.45,
    fill: 1.5,
    fillColor: 0xffffff,
    /** Base emissive — high enough that bodies read flat, not shaded. */
    emissive: 0.72,
    lane: 0.1,
    laneHot: 0.5,
    halo: 0.09,
    stars: true,
    ship: 0xdce8ff,
    /** Quad width in px. The lit core is a fraction of this; the rest is
     *  headroom the current blooms into. */
    laneWidth: 7,
    currentGain: 2.3,
    sparkMix: 0.62,
  },
  day: {
    bg: 0xe8e0d0,
    fogNear: 50,
    fogFar: 140,
    ambient: 1.15,
    fill: 0.7,
    fillColor: 0xfff4e2,
    emissive: 0.12,
    lane: 0.22,
    laneHot: 0.7,
    halo: 0.14,
    stars: false,
    ship: 0x3d5a75,
    laneWidth: 6,
    // On sand, added light washes out; darken the spark instead of whitening it.
    currentGain: 1.5,
    sparkMix: -0.5,
  },
} as const

export default function Starmap({ theme, lens, selected, focus, onSelect, onHover }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)

  // Kept across skin/lens rebuilds so the viewpoint survives.
  const viewRef = useRef({ pos: new THREE.Vector3(0, 11, 37), target: new THREE.Vector3(0, 0, 0) })

  const selRef = useRef(selected)
  const focusRef = useRef(focus)
  const onSelectRef = useRef(onSelect)
  const onHoverRef = useRef(onHover)
  selRef.current = selected
  focusRef.current = focus
  onSelectRef.current = onSelect
  onHoverRef.current = onHover

  useEffect(() => {
    const host = hostRef.current
    const labelHost = labelsRef.current
    if (!host || !labelHost) return

    const S = SKIN[theme]
    let width = host.clientWidth
    let height = host.clientHeight

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(S.bg)
    scene.fog = new THREE.Fog(S.bg, S.fogNear, S.fogFar)

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 400)
    camera.position.copy(viewRef.current.pos)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height)
    host.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.07
    controls.rotateSpeed = 0.5
    controls.zoomSpeed = 0.75
    controls.minDistance = 5
    controls.maxDistance = 100
    controls.enablePan = false
    controls.target.copy(viewRef.current.target)
    // On through interaction; off only for a scripted flight.
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.5

    scene.add(new THREE.AmbientLight(0xffffff, S.ambient))
    const fill = new THREE.PointLight(S.fillColor, S.fill, 0, 0)
    fill.position.set(0, 14, 0)
    scene.add(fill)

    const disposables: { dispose(): void }[] = []

    // ── deep field ──────────────────────────────────────────────────────────
    let seed = 20191
    const rand = () => {
      seed = (seed * 16807) % 2147483647
      return (seed - 1) / 2147483646
    }

    let starField: THREE.Points | null = null
    if (S.stars) {
      const n = 1600
      const pos = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        const r = 150 + rand() * 90
        const t = rand() * Math.PI * 2
        const p = Math.acos(2 * rand() - 1)
        pos[i * 3] = r * Math.sin(p) * Math.cos(t)
        pos[i * 3 + 1] = r * Math.cos(p)
        pos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t)
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      const m = new THREE.PointsMaterial({ color: 0xffffff, size: 0.6, transparent: true, opacity: 0.55, fog: false })
      starField = new THREE.Points(g, m)
      scene.add(starField)
      disposables.push(g, m)
    }

    // ── lanes + current ─────────────────────────────────────────────────────
    //
    // One LineSegments2 for every lane: instanced quads, one draw call, and
    // unlike LineBasicMaterial its `linewidth` is actually honoured (desktop GL
    // silently ignores line width on LineBasicMaterial).
    //
    // The quad is deliberately much wider than the visible thread. At rest only
    // a narrow core is lit, so the thread is a hairline; when a lane carries
    // current the pulse blooms out into the full width of the quad it already
    // owns. That gives per-lane apparent thickness from a single shared
    // material, which LineMaterial's one uniform `linewidth` could not.
    const lanePos = new Float32Array(lanes.length * 6)
    lanes.forEach((l, i) => {
      const a = byId.get(l.from)!
      const b = byId.get(l.to)!
      lanePos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6)
    })

    const laneCol = new Float32Array(lanes.length * 6)
    // Per-lane charge (0 = dark thread, 1 = full current) and phase, so the
    // lanes never pulse in lockstep.
    const laneEnergy = new Float32Array(lanes.length)
    const lanePhase = new Float32Array(lanes.length)
    for (let i = 0; i < lanes.length; i++) {
      // Golden-ratio stride: evenly spread, deterministic, no clustering.
      lanePhase[i] = (i * 0.6180339887498949) % 1
    }

    const laneGeo = new LineSegmentsGeometry()
    laneGeo.setPositions(lanePos)
    laneGeo.setColors(laneCol)
    const energyAttr = new THREE.InstancedBufferAttribute(laneEnergy, 1)
    laneGeo.setAttribute('instanceEnergy', energyAttr)
    laneGeo.setAttribute('instancePhase', new THREE.InstancedBufferAttribute(lanePhase, 1))

    const laneMat = new LineMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      // Screen-space width in px. NOT worldUnits: that path drops the `vUv`
      // varying the pulse needs, and a pixel width keeps threads crisp at
      // every zoom level instead of thinning to nothing when you pull back.
      linewidth: S.laneWidth,
    })
    laneMat.resolution.set(width, height)

    // Uniforms the injected shader owns.
    const laneUniforms = {
      uTime: { value: 0 },
      uSpeed: { value: 0.3 },
      uCoreHalf: { value: 0.07 },
      uCoreSoft: { value: 0.13 },
      uTailK: { value: 13.0 },
      uHeadW: { value: 0.022 },
      uGain: { value: S.currentGain },
      uSparkMix: { value: S.sparkMix },
    }
    Object.assign(laneMat.uniforms, laneUniforms)

    // LineMaterial is a ShaderMaterial, so its shader source lives on the
    // instance and can be edited before first compile.
    laneMat.vertexShader = `
      attribute float instanceEnergy;
      attribute float instancePhase;
      varying float vEnergy;
      varying float vPhase;
    ${laneMat.vertexShader.replace(
      'void main() {',
      `void main() {
        vEnergy = instanceEnergy;
        vPhase = instancePhase;`,
    )}`

    laneMat.fragmentShader = `
      varying float vEnergy;
      varying float vPhase;
      uniform float uTime;
      uniform float uSpeed;
      uniform float uCoreHalf;
      uniform float uCoreSoft;
      uniform float uTailK;
      uniform float uHeadW;
      uniform float uGain;
      uniform float uSparkMix;
    ${laneMat.fragmentShader.replace(
      'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
      `
      // vUv.y runs +1 at the segment start to -1 at the end (|vUv.y| > 1 is the
      // cap region); vUv.x is -1..1 across the width. Verified against
      // LineSegmentsGeometry's uv attribute — it is NOT (along, across).
      float along = ( 1.0 - vUv.y ) * 0.5;
      float across = abs( vUv.x );

      // The resting thread: a narrow lit core inside a wide quad.
      float core = 1.0 - smoothstep( uCoreHalf, uCoreHalf + uCoreSoft, across );

      // Two charges per lane, half a cycle apart, each a sharp head trailing an
      // exponential tail. Continuous in the fragment, so it reads as current in
      // a wire rather than beads on a string.
      float wave = 0.0;
      for ( int k = 0; k < 2; k++ ) {
        float head = fract( uTime * uSpeed + vPhase + float( k ) * 0.5 );
        float behind = fract( head - along );
        float tail = exp( -behind * uTailK );
        float spark = smoothstep( uHeadW, 0.0, min( behind, 1.0 - behind ) );
        wave += tail * 0.34 + spark;
      }
      wave *= vEnergy;

      // Current blooms across the whole quad; the resting core does not.
      float glow = wave * ( 1.0 - smoothstep( 0.0, 1.0, across ) );

      vec3 spark = mix( diffuseColor.rgb, vec3( 1.0 ), uSparkMix );
      vec3 rgb = diffuseColor.rgb + spark * glow * uGain;
      gl_FragColor = vec4( rgb, alpha * max( core, min( glow, 1.0 ) ) );`,
    )}`

    const laneMesh = new LineSegments2(laneGeo, laneMat)
    // Lanes are decoration; never let them swallow a click meant for a body.
    laneMesh.raycast = () => {}
    scene.add(laneMesh)
    disposables.push(laneGeo, laneMat)

    const bg = new THREE.Color(S.bg)
    const scratch = new THREE.Color()
    const laneColorBuf = (laneGeo.getAttribute('instanceColorStart') as THREE.InterleavedBufferAttribute).data

    /**
     * Lanes carry their own end's colour, pre-mixed toward the background to
     * fake per-line opacity.
     *
     * Nothing is "hot" until something is selected. Keying brightness off
     * `!l.spine` meant the cross-world routes sat at full highlight on an idle
     * map, which is what made the threads glare instead of whisper.
     */
    function paintLanes(sel: string | null) {
      const near = sel ? neighboursOf(sel) : null
      lanes.forEach((l, i) => {
        const hot = near !== null && near.has(l.from) && near.has(l.to)
        const alpha = hot ? S.laneHot : near ? S.lane * 0.3 : S.lane
        const own = colorUnder(byId.get(l.spine ? l.to : l.from)!, lens)
        const c = scratch.set(own).lerp(bg, 1 - alpha)
        for (let v = 0; v < 2; v++) {
          laneCol[i * 6 + v * 3] = c.r
          laneCol[i * 6 + v * 3 + 1] = c.g
          laneCol[i * 6 + v * 3 + 2] = c.b
        }
      })
      laneColorBuf.needsUpdate = true
    }

    /**
     * Which lanes carry current. Everything touching the selection runs at full
     * charge; the real cross-world routes keep a faint trickle on an idle map so
     * it never looks switched off. Structural spine lanes stay dark.
     */
    const laneTarget = new Float32Array(lanes.length)
    function chargeLanes(sel: string | null, hov: string | null) {
      const key = sel ?? hov
      const near = key ? neighboursOf(key) : null
      for (let i = 0; i < lanes.length; i++) {
        const l = lanes[i]
        laneTarget[i] = near ? (near.has(l.from) && near.has(l.to) ? 1 : 0) : l.spine ? 0 : 0.3
      }
    }

    // ── bodies: one shape, one flat colour, one soft halo ───────────────────
    interface Entry {
      node: Placed
      mesh: THREE.Mesh
      mat: THREE.MeshStandardMaterial
      halo: THREE.Mesh
      label: HTMLDivElement
      scale: number
      scaleTo: number
      dim: number
      dimTo: number
    }

    // Shared geometry — every body is the same sphere, scaled. Nothing reads as
    // a faceted rock, and kind is carried by size alone.
    const ball = new THREE.SphereGeometry(1, 32, 24)
    const haloBall = new THREE.SphereGeometry(1, 16, 12)
    disposables.push(ball, haloBall)

    const entries: Entry[] = []
    const pickable: THREE.Mesh[] = []

    for (const node of placed) {
      const col = new THREE.Color(colorUnder(node, lens))

      const mat = new THREE.MeshStandardMaterial({
        color: col,
        emissive: col,
        emissiveIntensity: S.emissive,
        roughness: 0.35,
        metalness: 0.1,
        transparent: true,
      })
      const mesh = new THREE.Mesh(ball, mat)
      mesh.position.set(node.x, node.y, node.z)
      mesh.scale.setScalar(node.radius)
      mesh.userData.id = node.id
      scene.add(mesh)
      pickable.push(mesh)
      disposables.push(mat)

      const haloMat = new THREE.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: S.halo,
        depthWrite: false,
        fog: false,
      })
      const halo = new THREE.Mesh(haloBall, haloMat)
      halo.position.copy(mesh.position)
      halo.scale.setScalar(node.radius * 1.45)
      scene.add(halo)
      disposables.push(haloMat)

      const label = document.createElement('div')
      label.className = `sm-label sm-label--${node.kind}`
      label.textContent = node.name
      labelHost.appendChild(label)

      entries.push({ node, mesh, mat, halo, label, scale: 1, scaleTo: 1, dim: 1, dimTo: 1 })
    }

    function applyStates(sel: string | null, hov: string | null) {
      const near = sel ? neighboursOf(sel) : null
      for (const e of entries) {
        const id = e.node.id
        e.scaleTo = id === sel ? 1.4 : id === hov ? 1.22 : 1
        e.dimTo = !near || near.has(id) ? 1 : 0.2
      }
    }

    // ── ships: arrowheads that fly the selected body's lanes ────────────────
    const SHIP_POOL = 48
    const shipGeo = new THREE.ConeGeometry(0.085, 0.32, 4, 1)
    shipGeo.rotateX(Math.PI / 2)
    disposables.push(shipGeo)

    interface Ship {
      hull: THREE.Mesh
      lane: number
      t: number
      speed: number
      active: boolean
    }
    const ships: Ship[] = []
    for (let i = 0; i < SHIP_POOL; i++) {
      const m = new THREE.MeshBasicMaterial({ color: S.ship, transparent: true, opacity: 0, fog: false })
      const hull = new THREE.Mesh(shipGeo, m)
      hull.visible = false
      scene.add(hull)
      ships.push({ hull, lane: -1, t: 0, speed: 0.3, active: false })
      disposables.push(m)
    }

    function launch(id: string | null) {
      for (const s of ships) {
        s.active = false
        s.hull.visible = false
      }
      if (!id) return
      lanesFrom(id)
        .filter((l) => !l.spine)
        .slice(0, SHIP_POOL)
        .forEach((l, i) => {
          const s = ships[i]
          s.lane = lanes.indexOf(l)
          s.t = 0
          s.speed = 0.28 + (i % 4) * 0.035
          s.active = true
          s.hull.visible = true
          const target = l.from === id ? l.to : l.from
          ;(s.hull.material as THREE.MeshBasicMaterial).color.set(colorUnder(byId.get(target)!, lens))
        })
    }

    // ── interaction ─────────────────────────────────────────────────────────
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2(-2, -2)
    let hovered: string | null = null
    let down: { x: number; y: number } | null = null
    const el = renderer.domElement

    const onMove = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect()
      ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1
      ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1
    }
    const onDown = (ev: PointerEvent) => {
      down = { x: ev.clientX, y: ev.clientY }
    }
    const onUp = (ev: PointerEvent) => {
      if (!down) return
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y)
      down = null
      if (moved <= 5) onSelectRef.current(hovered)
    }
    const onLeave = () => {
      ndc.set(-2, -2)
      if (hovered) {
        hovered = null
        onHoverRef.current(null)
      }
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointerleave', onLeave)

    const ro = new ResizeObserver(() => {
      width = host.clientWidth
      height = host.clientHeight
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height)
      laneMat.resolution.set(width, height)
    })
    ro.observe(host)

    // ── loop ────────────────────────────────────────────────────────────────
    let lastSel = selRef.current
    // StrictMode mounts twice; without this flag a focus set between the two
    // mounts would look already-applied and never be acted on.
    let lastFocus = focusRef.current
    let focusApplied = false

    paintLanes(lastSel)
    applyStates(lastSel, null)
    chargeLanes(lastSel, null)
    launch(lastSel)

    const v = new THREE.Vector3()
    const pa = new THREE.Vector3()
    const pb = new THREE.Vector3()
    const desiredTarget = new THREE.Vector3().copy(controls.target)
    let desiredDist = camera.position.distanceTo(controls.target)
    let flying = false

    const t0 = performance.now()
    let raf = 0

    function frame() {
      raf = requestAnimationFrame(frame)
      const t = (performance.now() - t0) / 1000

      if (selRef.current !== lastSel) {
        lastSel = selRef.current
        paintLanes(lastSel)
        applyStates(lastSel, hovered)
        chargeLanes(lastSel, hovered)
        launch(lastSel)
      }

      if (!focusApplied || focusRef.current !== lastFocus) {
        focusApplied = true
        lastFocus = focusRef.current
        const target = lastFocus ? byId.get(lastFocus) : null
        if (target) {
          desiredTarget.set(target.x, target.y, target.z)
          desiredDist = target.kind === 'world' ? 11 : target.kind === 'hub' ? 37 : 6
        } else {
          desiredTarget.set(0, 0, 0)
          desiredDist = 37
        }
        flying = true
        controls.autoRotate = false
      }

      if (flying) {
        // Damping fights a scripted move, so it is off until we arrive.
        controls.enableDamping = false
        controls.target.lerp(desiredTarget, 0.12)
        const dir = v.copy(camera.position).sub(controls.target)
        const d = dir.length() || 1
        dir.multiplyScalar((d + (desiredDist - d) * 0.12) / d)
        camera.position.copy(controls.target).add(dir)
        if (controls.target.distanceTo(desiredTarget) < 0.04 && Math.abs(d - desiredDist) < 0.12) {
          flying = false
          controls.enableDamping = true
          controls.autoRotate = true
        }
      }

      controls.update()

      if (ndc.x > -1.5) {
        ray.setFromCamera(ndc, camera)
        const hit = ray.intersectObjects(pickable, false)[0]
        const id = hit ? (hit.object.userData.id as string) : null
        if (id !== hovered) {
          hovered = id
          el.style.cursor = id ? 'pointer' : 'grab'
          onHoverRef.current(id)
          applyStates(lastSel, hovered)
          chargeLanes(lastSel, hovered)
        }
      }

      // Current: advance the pulse, and ease each lane's charge so lanes light
      // up and fade out rather than snapping.
      laneUniforms.uTime.value = t
      let chargeDirty = false
      for (let i = 0; i < lanes.length; i++) {
        const d = laneTarget[i] - laneEnergy[i]
        if (Math.abs(d) > 0.001) {
          laneEnergy[i] += d * 0.08
          chargeDirty = true
        }
      }
      if (chargeDirty) energyAttr.needsUpdate = true

      if (starField) {
        starField.rotation.y = t * 0.008
        starField.rotation.x = Math.sin(t * 0.02) * 0.05
      }

      for (const e of entries) {
        e.scale += (e.scaleTo - e.scale) * 0.15
        e.dim += (e.dimTo - e.dim) * 0.11
        const hot = e.node.id === lastSel || e.node.id === hovered

        // Phase-offset by x so the field never pulses in unison.
        const breathe = 1 + Math.sin(t * 1.5 + e.node.x) * 0.06
        const r = e.node.radius * e.scale * breathe
        e.mesh.scale.setScalar(r)
        e.halo.scale.setScalar(r * (hot ? 1.85 : 1.45))

        e.mat.opacity = e.dim
        e.mat.emissiveIntensity = S.emissive * (0.4 + e.dim * 0.6) * (hot ? 1.35 : 1)
        ;(e.halo.material as THREE.MeshBasicMaterial).opacity = S.halo * e.dim * (hot ? 3.2 : 1)

        v.set(e.node.x, e.node.y, e.node.z).project(camera)
        // Only the origin carries a standing label; the rest arrive on demand.
        const show = v.z <= 1 && e.dim > 0.3 && (e.node.kind === 'hub' || hot)
        if (!show) {
          e.label.style.opacity = '0'
        } else {
          const sx = (v.x * 0.5 + 0.5) * width
          const sy = (-v.y * 0.5 + 0.5) * height + 11 + e.node.radius * 9
          e.label.style.transform = `translate(-50%,0) translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0)`
          e.label.style.opacity = String(e.dim)
          e.label.style.color = colorUnder(e.node, lens)
        }
      }

      for (const s of ships) {
        if (!s.active) continue
        const l = lanes[s.lane]
        if (!l) continue
        const from = byId.get(lastSel === l.to ? l.to : l.from)!
        const to = byId.get(lastSel === l.to ? l.from : l.to)!
        pa.set(from.x, from.y, from.z)
        pb.set(to.x, to.y, to.z)

        s.t += (s.speed / Math.max(1, pa.distanceTo(pb))) * 1.6
        if (s.t > 1) s.t -= 1

        s.hull.position.copy(pa).lerp(pb, s.t)
        s.hull.lookAt(pb)
        // Fade at both ends so ships never pop in or out.
        ;(s.hull.material as THREE.MeshBasicMaterial).opacity = 0.75 * Math.min(1, Math.min(s.t, 1 - s.t) * 9)
      }

      viewRef.current.pos.copy(camera.position)
      viewRef.current.target.copy(controls.target)
      renderer.render(scene, camera)
    }
    frame()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointerleave', onLeave)
      controls.dispose()
      for (const d of disposables) d.dispose()
      // dispose() frees three's objects but leaves the GL context alive, and
      // every skin/lens change rebuilds this scene.
      renderer.dispose()
      renderer.forceContextLoss()
      labelHost.replaceChildren()
      if (el.parentNode === host) host.removeChild(el)
    }
  }, [theme, lens])

  return (
    <div ref={hostRef} className="sm-canvas">
      <div ref={labelsRef} className="sm-labels" aria-hidden />
    </div>
  )
}
