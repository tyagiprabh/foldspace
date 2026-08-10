'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

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

/** Desert night / desert noon. Warm blacks, never blue-blacks. */
const SKIN = {
  night: {
    bg: 0x0b0906,
    fogNear: 40,
    fogFar: 120,
    lane: 0x4a3d2c,
    laneHot: 0xd8b271,
    ambient: 0.5,
    key: 0.85,
    keyColor: 0xffd9a0,
    rim: 0x5e7fa8,
    rimI: 0.5,
    emissive: 0.72,
    bloom: { strength: 0.42, radius: 0.55, threshold: 0.68 },
    atmosphere: 0.3,
    dust: 0.5,
    stars: true,
    ship: 0xbfe4ff,
  },
  day: {
    bg: 0xe6dcc8,
    fogNear: 44,
    fogFar: 130,
    lane: 0xb3a488,
    laneHot: 0x8a6a3c,
    ambient: 1.0,
    key: 1.35,
    keyColor: 0xfff2d8,
    rim: 0x8fa6bd,
    rimI: 0.22,
    emissive: 0.16,
    bloom: null,
    atmosphere: 0.16,
    dust: 0.22,
    stars: false,
    ship: 0x2f5d80,
  },
} as const

/** Priority for label collision culling: lower wins the space. */
const LABEL_PRIO: Record<string, number> = { hub: 0, world: 1, agent: 2, tool: 3 }

function bodyGeometry(node: Placed): THREE.BufferGeometry {
  const r = node.radius
  switch (node.kind) {
    case 'hub':
      return new THREE.IcosahedronGeometry(r, 5)
    case 'world':
      // Low-poly enough to catch facet light like a rock, round enough to read.
      return new THREE.IcosahedronGeometry(r, 3)
    case 'agent':
      return new THREE.IcosahedronGeometry(r, 2)
    case 'tool':
      return new THREE.OctahedronGeometry(r * 1.12, 0)
  }
}

/** Arrowhead pointing down its own +Z, so lookAt(target) aims it correctly. */
function shipGeometry(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(0.14, 0.52, 4, 1)
  g.rotateX(Math.PI / 2)
  return g
}

export default function Starmap({ theme, lens, selected, focus, onSelect, onHover }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)

  // Kept across theme rebuilds so the viewpoint survives a skin change.
  const viewRef = useRef({ pos: new THREE.Vector3(0, 14, 40), target: new THREE.Vector3(0, 0, 0) })

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

    const camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 400)
    camera.position.copy(viewRef.current.pos)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = theme === 'night' ? 1.02 : 1.12
    host.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.07
    controls.rotateSpeed = 0.5
    controls.zoomSpeed = 0.75
    controls.minDistance = 3.5
    controls.maxDistance = 110
    controls.enablePan = false
    controls.target.copy(viewRef.current.target)
    // Always on, including while the user drags. The reference does the same and
    // it is most of why the scene feels alive rather than parked.
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.5

    // ── light: one hot desert sun, one cold sky bounce ──────────────────────
    scene.add(new THREE.AmbientLight(0xffe9c8, S.ambient))
    const sun = new THREE.DirectionalLight(S.keyColor, S.key)
    sun.position.set(14, 16, 8)
    scene.add(sun)
    const sky = new THREE.DirectionalLight(S.rim, S.rimI)
    sky.position.set(-12, -7, -10)
    scene.add(sky)

    const disposables: { dispose(): void }[] = []

    // ── deep field ──────────────────────────────────────────────────────────
    let seed = 20191
    const rand = () => {
      seed = (seed * 16807) % 2147483647
      return (seed - 1) / 2147483646
    }

    // Held so the loop can turn the whole sky — the deep field drifts against
    // the camera's own orbit, which is what stops the scene reading as static.
    let starField: THREE.Points | null = null
    if (S.stars) {
      const n = 1400
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
      const m = new THREE.PointsMaterial({ color: 0xfff0d4, size: 0.7, transparent: true, opacity: 0.5, fog: false })
      starField = new THREE.Points(g, m)
      scene.add(starField)
      disposables.push(g, m)
    }

    // ── drifting dust, the thing that makes it feel like an atmosphere ──────
    const dustN = 1300
    const dustBase = new Float32Array(dustN * 3)
    const dustPos = new Float32Array(dustN * 3)
    const dustPhase = new Float32Array(dustN)
    for (let i = 0; i < dustN; i++) {
      const r = 6 + rand() * 46
      const t = rand() * Math.PI * 2
      dustBase[i * 3] = Math.cos(t) * r
      dustBase[i * 3 + 1] = (rand() - 0.5) * 22
      dustBase[i * 3 + 2] = Math.sin(t) * r
      dustPhase[i] = rand() * Math.PI * 2
    }
    dustPos.set(dustBase)
    const dustGeo = new THREE.BufferGeometry()
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3))
    const dustMat = new THREE.PointsMaterial({
      color: theme === 'night' ? 0xe8c99a : 0x8a7658,
      size: 0.13,
      transparent: true,
      opacity: S.dust,
      depthWrite: false,
      blending: theme === 'night' ? THREE.AdditiveBlending : THREE.NormalBlending,
    })
    scene.add(new THREE.Points(dustGeo, dustMat))
    disposables.push(dustGeo, dustMat)

    // ── lanes ───────────────────────────────────────────────────────────────
    const lanePos = new Float32Array(lanes.length * 6)
    const laneCol = new Float32Array(lanes.length * 6)
    lanes.forEach((l, i) => {
      const a = byId.get(l.from)!
      const b = byId.get(l.to)!
      lanePos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6)
    })
    const laneGeo = new THREE.BufferGeometry()
    laneGeo.setAttribute('position', new THREE.BufferAttribute(lanePos, 3))
    laneGeo.setAttribute('color', new THREE.BufferAttribute(laneCol, 3))
    const laneMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: theme === 'night' ? 0.8 : 0.62,
    })
    scene.add(new THREE.LineSegments(laneGeo, laneMat))
    disposables.push(laneGeo, laneMat)

    const cLane = new THREE.Color(S.lane)
    const cHot = new THREE.Color(S.laneHot)
    const cBg = new THREE.Color(S.bg)
    const scratch = new THREE.Color()

    function paintLanes(sel: string | null) {
      const near = sel ? neighboursOf(sel) : null
      lanes.forEach((l, i) => {
        let c: THREE.Color
        if (!near) {
          c = l.spine ? cLane : scratch.copy(cLane).lerp(cHot, 0.34)
        } else if (near.has(l.from) && near.has(l.to)) {
          const other = l.from === sel ? l.to : l.from
          c = scratch.set(colorUnder(byId.get(other)!, lens)).lerp(cHot, 0.2)
        } else {
          c = scratch.copy(cLane).lerp(cBg, 0.72)
        }
        for (let v = 0; v < 2; v++) {
          laneCol[i * 6 + v * 3] = c.r
          laneCol[i * 6 + v * 3 + 1] = c.g
          laneCol[i * 6 + v * 3 + 2] = c.b
        }
      })
      laneGeo.getAttribute('color').needsUpdate = true
    }

    // ── bodies ──────────────────────────────────────────────────────────────
    interface Entry {
      node: Placed
      mesh: THREE.Mesh
      mat: THREE.MeshStandardMaterial
      air?: THREE.Mesh
      ring?: THREE.Mesh
      label: HTMLDivElement
      labelW: number
      spin: number
      scale: number
      scaleTo: number
      dim: number
      dimTo: number
    }

    const entries: Entry[] = []
    const pickable: THREE.Mesh[] = []

    for (const node of placed) {
      const col = new THREE.Color(colorUnder(node, lens))
      const structural = node.kind === 'hub' || node.kind === 'world'

      const mat = new THREE.MeshStandardMaterial({
        color: col,
        emissive: col,
        emissiveIntensity: structural ? S.emissive : S.emissive * 0.62,
        roughness: node.kind === 'world' ? 0.82 : 0.42,
        metalness: node.kind === 'tool' ? 0.4 : 0.08,
        flatShading: node.kind === 'world',
        transparent: true,
      })
      const mesh = new THREE.Mesh(bodyGeometry(node), mat)
      mesh.position.set(node.x, node.y, node.z)
      mesh.userData.id = node.id
      scene.add(mesh)
      pickable.push(mesh)
      disposables.push(mesh.geometry, mat)

      // Backside-rendered shell: the cheap, convincing planet atmosphere.
      let air: THREE.Mesh | undefined
      if (structural) {
        const ag = new THREE.SphereGeometry(node.radius * (node.kind === 'hub' ? 1.6 : 1.55), 32, 24)
        const am = new THREE.MeshBasicMaterial({
          color: col,
          transparent: true,
          opacity: S.atmosphere * (node.kind === 'hub' ? 1.15 : 1),
          side: THREE.BackSide,
          blending: theme === 'night' ? THREE.AdditiveBlending : THREE.NormalBlending,
          depthWrite: false,
          fog: false,
        })
        air = new THREE.Mesh(ag, am)
        air.position.copy(mesh.position)
        scene.add(air)
        disposables.push(ag, am)
      }

      // Thin inclined ring — the "this is a world" tell.
      let ring: THREE.Mesh | undefined
      if (node.kind === 'world' || node.kind === 'hub') {
        const rg = new THREE.TorusGeometry(node.radius * 2.15, node.radius * 0.032, 6, 84)
        const rm = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.42 })
        ring = new THREE.Mesh(rg, rm)
        ring.position.copy(mesh.position)
        ring.rotation.x = Math.PI / 2.15
        ring.rotation.y = ((node.x + node.z) % 1) * 0.34
        scene.add(ring)
        disposables.push(rg, rm)
      }

      const label = document.createElement('div')
      label.className = `sm-label sm-label--${node.kind}`
      label.textContent = node.name
      labelHost.appendChild(label)

      entries.push({
        node,
        mesh,
        mat,
        air,
        ring,
        label,
        labelW: label.offsetWidth,
        spin: rand() * Math.PI * 2,
        scale: 1,
        scaleTo: 1,
        dim: 1,
        dimTo: 1,
      })
    }

    // Labels are culled in priority order, so sort once here.
    const ordered = [...entries].sort((a, b) => LABEL_PRIO[a.node.kind] - LABEL_PRIO[b.node.kind])

    function applyStates(sel: string | null, hov: string | null) {
      const near = sel ? neighboursOf(sel) : null
      for (const e of entries) {
        const id = e.node.id
        e.scaleTo = id === sel ? 1.5 : id === hov ? 1.24 : 1
        e.dimTo = !near || near.has(id) ? 1 : 0.14
      }
    }

    // ── ships: arrowheads that fly the selected node's lanes ────────────────
    const SHIP_POOL = 48
    const shipGeo = shipGeometry()
    const shipMat = new THREE.MeshBasicMaterial({ color: S.ship, transparent: true, opacity: 0 })
    const trailMat = new THREE.MeshBasicMaterial({
      color: S.ship,
      transparent: true,
      opacity: 0,
      blending: theme === 'night' ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
    })
    const trailGeo = new THREE.PlaneGeometry(0.045, 1.5)
    trailGeo.translate(0, -0.75, 0)
    trailGeo.rotateX(-Math.PI / 2)

    interface Ship {
      hull: THREE.Mesh
      trail: THREE.Mesh
      lane: number
      t: number
      speed: number
      active: boolean
    }
    const ships: Ship[] = []
    for (let i = 0; i < SHIP_POOL; i++) {
      const hull = new THREE.Mesh(shipGeo, shipMat.clone())
      const trail = new THREE.Mesh(trailGeo, trailMat.clone())
      hull.visible = false
      trail.visible = false
      scene.add(hull, trail)
      ships.push({ hull, trail, lane: -1, t: 0, speed: 0.28, active: false })
      disposables.push(hull.material as THREE.Material, trail.material as THREE.Material)
    }
    disposables.push(shipGeo, shipMat, trailGeo, trailMat)

    /** Launch a squadron down every lane touching `id`; ships fly outward. */
    function launch(id: string | null) {
      for (const s of ships) {
        s.active = false
        s.hull.visible = false
        s.trail.visible = false
      }
      if (!id) return
      const outbound = lanesFrom(id)
      outbound.slice(0, SHIP_POOL).forEach((l, i) => {
        const s = ships[i]
        s.lane = lanes.indexOf(l)
        // Always fly away from the selected node.
        s.t = 0
        s.speed = 0.26 + (i % 4) * 0.035
        s.active = true
        s.hull.visible = true
        s.trail.visible = true
        const target = l.from === id ? l.to : l.from
        const col = new THREE.Color(colorUnder(byId.get(target)!, lens)).lerp(new THREE.Color(S.ship), 0.55)
        ;(s.hull.material as THREE.MeshBasicMaterial).color.copy(col)
        ;(s.trail.material as THREE.MeshBasicMaterial).color.copy(col)
      })
    }

    // ── post ────────────────────────────────────────────────────────────────
    let composer: EffectComposer | null = null
    if (S.bloom) {
      composer = new EffectComposer(renderer)
      composer.addPass(new RenderPass(scene, camera))
      composer.addPass(
        new UnrealBloomPass(new THREE.Vector2(width, height), S.bloom.strength, S.bloom.radius, S.bloom.threshold),
      )
      composer.addPass(new OutputPass())
      composer.setSize(width, height)
    }

    // ── input ───────────────────────────────────────────────────────────────
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2(-2, -2)
    let hovered: string | null = null
    let down: { x: number; y: number } | null = null
    let lastTouch = -1e9
    const el = renderer.domElement

    const onMove = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect()
      ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1
      ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1
    }
    const onDown = (ev: PointerEvent) => {
      down = { x: ev.clientX, y: ev.clientY }
      lastTouch = performance.now()
    }
    const onUp = (ev: PointerEvent) => {
      if (!down) return
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y)
      down = null
      lastTouch = performance.now()
      if (moved <= 5) onSelectRef.current(hovered)
    }
    const onLeave = () => {
      ndc.set(-2, -2)
      if (hovered) {
        hovered = null
        onHoverRef.current(null)
      }
    }
    const onWheel = () => {
      lastTouch = performance.now()
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('wheel', onWheel, { passive: true })

    const ro = new ResizeObserver(() => {
      width = host.clientWidth
      height = host.clientHeight
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height)
      composer?.setSize(width, height)
    })
    ro.observe(host)

    // ── loop ────────────────────────────────────────────────────────────────
    let lastSel = selRef.current
    // StrictMode mounts this effect twice. Capturing `focus` as already-applied
    // meant a deep-linked focus set between the two mounts was never acted on,
    // so the flag below forces the first frame to apply whatever focus is live.
    let lastFocus = focusRef.current
    let focusApplied = false
    paintLanes(lastSel)
    applyStates(lastSel, null)
    launch(lastSel)

    const v = new THREE.Vector3()
    const pa = new THREE.Vector3()
    const pb = new THREE.Vector3()
    const desiredTarget = new THREE.Vector3().copy(controls.target)
    let desiredDist = camera.position.distanceTo(controls.target)
    let flying = false

    const boxes: { x0: number; y0: number; x1: number; y1: number }[] = []
    const t0 = performance.now()
    let raf = 0

    function frame() {
      raf = requestAnimationFrame(frame)
      const t = (performance.now() - t0) / 1000

      if (selRef.current !== lastSel) {
        lastSel = selRef.current
        paintLanes(lastSel)
        applyStates(lastSel, hovered)
        launch(lastSel)
      }

      // A focus request (palette jump, deep link) flies the camera in.
      if (!focusApplied || focusRef.current !== lastFocus) {
        focusApplied = true
        lastFocus = focusRef.current
        const target = lastFocus ? byId.get(lastFocus) : null
        if (target) {
          desiredTarget.set(target.x, target.y, target.z)
          desiredDist = target.kind === 'world' ? 12 : target.kind === 'hub' ? 34 : 6.5
          flying = true
          // Off only for the duration of a scripted flight, or it fights us.
          controls.autoRotate = false
          lastTouch = performance.now()
        } else {
          desiredTarget.set(0, 0, 0)
          desiredDist = 40
          flying = true
        }
      }

      if (flying) {
        // Damping would fight a scripted move: OrbitControls keeps a residual
        // delta that pulls the camera back toward where it was. Off while
        // flying, on again the moment we arrive.
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

      // hover pick
      if (ndc.x > -1.5) {
        ray.setFromCamera(ndc, camera)
        const hit = ray.intersectObjects(pickable, false)[0]
        const id = hit ? (hit.object.userData.id as string) : null
        if (id !== hovered) {
          hovered = id
          el.style.cursor = id ? 'pointer' : 'grab'
          onHoverRef.current(id)
          applyStates(lastSel, hovered)
        }
      }

      if (starField) {
        starField.rotation.y = t * 0.008
        starField.rotation.x = Math.sin(t * 0.02) * 0.05
      }

      // dust drift
      for (let i = 0; i < dustN; i++) {
        const ph = dustPhase[i]
        dustPos[i * 3] = dustBase[i * 3] + Math.sin(t * 0.11 + ph) * 1.5
        dustPos[i * 3 + 1] = dustBase[i * 3 + 1] + Math.sin(t * 0.07 + ph * 1.7) * 0.7
        dustPos[i * 3 + 2] = dustBase[i * 3 + 2] + Math.cos(t * 0.09 + ph) * 1.5
      }
      dustGeo.getAttribute('position').needsUpdate = true

      // bodies + labels
      boxes.length = 0

      for (const e of ordered) {
        e.scale += (e.scaleTo - e.scale) * 0.15
        e.dim += (e.dimTo - e.dim) * 0.11
        const hot = e.node.id === lastSel || e.node.id === hovered
        const structural = e.node.kind === 'hub' || e.node.kind === 'world'

        // Every body pulses, phase-offset by its own x so the field never beats
        // in unison. Amplitude and frequency lifted from the reference.
        const breathe = 1 + Math.sin(t * 1.5 + e.node.x) * (e.node.kind === 'hub' ? 0.03 : 0.06)
        e.mesh.scale.setScalar(e.scale * breathe)
        e.mesh.rotation.y = e.spin + t * (e.node.kind === 'world' ? 0.055 : 0.2)
        if (e.node.kind === 'tool') e.mesh.rotation.x = e.spin + t * 0.16

        e.mat.opacity = e.dim
        e.mat.emissiveIntensity =
          (structural ? S.emissive : S.emissive * 0.62) * (0.32 + e.dim * 0.68) * (hot ? 1.7 : 1)

        if (e.air) {
          const m = e.air.material as THREE.MeshBasicMaterial
          m.opacity = S.atmosphere * (e.node.kind === 'hub' ? 1.15 : 1) * e.dim * (hot ? 1.9 : 1)
          e.air.scale.setScalar(1 + (e.scale - 1) * 0.5)
        }
        if (e.ring) {
          e.ring.rotation.z = t * 0.075
          ;(e.ring.material as THREE.MeshBasicMaterial).opacity = 0.42 * e.dim * (hot ? 1.6 : 1)
        }

        // project → screen, then cull colliding labels by priority
        v.set(e.node.x, e.node.y, e.node.z).project(camera)
        // The map stays clean: only the origin carries a standing label. Every
        // other name arrives on hover or selection, so nothing competes.
        let show = v.z <= 1 && e.dim > 0.28 && (e.node.kind === 'hub' || hot)
        if (show) {
          const sx = (v.x * 0.5 + 0.5) * width
          const sy = (-v.y * 0.5 + 0.5) * height + 13 + e.node.radius * 7
          const half = e.labelW / 2 + 4
          const box = { x0: sx - half, y0: sy - 3, x1: sx + half, y1: sy + 16 }
          if (!hot) {
            for (const b of boxes) {
              if (box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0) {
                show = false
                break
              }
            }
          }
          if (show) {
            boxes.push(box)
            e.label.style.transform = `translate(-50%,0) translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0)`
            e.label.style.opacity = String((hot ? 1 : structural ? 0.94 : 0.66) * e.dim)
            e.label.style.color = hot ? colorUnder(e.node, lens) : ''
          }
        }
        if (!show) e.label.style.opacity = '0'
      }

      // ships
      for (const s of ships) {
        if (!s.active) continue
        const l = lanes[s.lane]
        if (!l) continue
        const from = byId.get(lastSel === l.to ? l.to : l.from)!
        const to = byId.get(lastSel === l.to ? l.from : l.to)!
        pa.set(from.x, from.y, from.z)
        pb.set(to.x, to.y, to.z)

        s.t += (s.speed / Math.max(1, pa.distanceTo(pb))) * 1.6 * 0.016 * 60
        if (s.t > 1) s.t -= 1

        const p = pa.clone().lerp(pb, s.t)
        s.hull.position.copy(p)
        s.hull.lookAt(pb)
        // Fade in at launch, out on arrival, so ships do not pop.
        const fade = Math.min(1, Math.min(s.t, 1 - s.t) * 9)
        ;(s.hull.material as THREE.MeshBasicMaterial).opacity = 0.92 * fade

        s.trail.position.copy(p)
        s.trail.lookAt(pb)
        s.trail.rotateX(Math.PI / 2)
        ;(s.trail.material as THREE.MeshBasicMaterial).opacity = 0.34 * fade
      }

      viewRef.current.pos.copy(camera.position)
      viewRef.current.target.copy(controls.target)

      if (composer) composer.render()
      else renderer.render(scene, camera)
    }
    frame()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('wheel', onWheel)
      controls.dispose()
      composer?.dispose()
      for (const d of disposables) d.dispose()
      // dispose() releases three's objects but leaves the WebGL context alive.
      // Every theme/lens change rebuilds this scene, so without an explicit
      // context loss the browser hits its context ceiling and the canvas goes
      // black after ~16 rebuilds.
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
