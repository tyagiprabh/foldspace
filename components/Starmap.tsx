'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

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
    lane: 0.14,
    laneHot: 0.7,
    halo: 0.09,
    stars: true,
    ship: 0xdce8ff,
  },
  day: {
    bg: 0xe8e0d0,
    fogNear: 50,
    fogFar: 140,
    ambient: 1.15,
    fill: 0.7,
    fillColor: 0xfff4e2,
    emissive: 0.12,
    lane: 0.24,
    laneHot: 0.75,
    halo: 0.14,
    stars: false,
    ship: 0x3d5a75,
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
    const laneMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, depthWrite: false })
    scene.add(new THREE.LineSegments(laneGeo, laneMat))
    disposables.push(laneGeo, laneMat)

    const bg = new THREE.Color(S.bg)
    const scratch = new THREE.Color()

    /**
     * Lanes carry their own end's colour, pre-mixed toward the background to
     * fake per-line opacity. One draw call, no per-lane materials.
     */
    function paintLanes(sel: string | null) {
      const near = sel ? neighboursOf(sel) : null
      lanes.forEach((l, i) => {
        const hot = near ? near.has(l.from) && near.has(l.to) : !l.spine
        const alpha = hot ? S.laneHot : near ? S.lane * 0.35 : S.lane
        const own = colorUnder(byId.get(l.spine ? l.to : l.from)!, lens)
        const c = scratch.set(own).lerp(bg, 1 - alpha)
        for (let v = 0; v < 2; v++) {
          laneCol[i * 6 + v * 3] = c.r
          laneCol[i * 6 + v * 3 + 1] = c.g
          laneCol[i * 6 + v * 3 + 2] = c.b
        }
      })
      laneGeo.getAttribute('color').needsUpdate = true
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
    const shipGeo = new THREE.ConeGeometry(0.1, 0.38, 4, 1)
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
        }
      }

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
        ;(s.hull.material as THREE.MeshBasicMaterial).opacity = 0.9 * Math.min(1, Math.min(s.t, 1 - s.t) * 9)
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
