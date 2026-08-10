'use client'
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { buildCurrent, CURRENT_SKIN } from '../../lib/current'

export default function Probe() {
  const host = useRef<HTMLDivElement>(null)
  const [log, setLog] = useState<string[]>([])
  useEffect(() => {
    const out: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => { out.push(a.map(String).join(' ')); orig(...a) }
    const scene = new THREE.Scene()
    const cam = new THREE.PerspectiveCamera(55, 1.6, 0.1, 400)
    cam.position.set(0, 11, 37)
    const r = new THREE.WebGLRenderer({ antialias: true })
    r.setSize(800, 500)
    host.current!.appendChild(r.domElement)
    for (const key of ['night', 'day'] as const) {
      const cur = buildCurrent(CURRENT_SKIN[key], 'world')
      scene.add(cur.filament, cur.charge)
      cur.select(null)
      cur.update(1.234, 0.016, 500, 55)
      r.render(scene, cam)
      cur.select('__hub__')
      for (let i = 0; i < 20; i++) { cur.update(1.3 + i * 0.016, 0.016, 500, 55); r.render(scene, cam) }
      const gl = r.getContext()
      const info = r.info.render
      out.push(`${key}: drawCalls=${info.calls} tris=${info.triangles} glErr=${gl.getError()}`)
      scene.remove(cur.filament, cur.charge)
      cur.dispose()
    }
    console.error = orig
    setLog(out)
    return () => { r.dispose(); r.forceContextLoss() }
  }, [])
  return <div><div ref={host} /><pre id="probe-log" style={{ color: '#fff', fontSize: 13 }}>{log.length ? log.join('\n') : 'running'}</pre></div>
}
