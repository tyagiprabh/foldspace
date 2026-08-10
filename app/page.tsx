'use client'

import { useCallback, useEffect, useState } from 'react'
import Starmap, { type Theme } from '../components/Starmap'
import Inspector from '../components/Inspector'
import Palette from '../components/Palette'
import { APP } from '../config'
import { HUB_ID, LENS_LABEL, byId, counts, legendFor } from '../lib/graph'
import type { Lens } from '../lib/graph'

const LENSES: Lens[] = ['world', 'model', 'runtime', 'status']

export default function Page() {
  const [theme, setTheme] = useState<Theme>('night')
  const [lens, setLens] = useState<Lens>('world')
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  /** Selecting also flies the camera; the hash keeps the view shareable. */
  const select = useCallback((id: string | null, fly = false) => {
    setSelected(id)
    if (fly) setFocus(id ?? `reset:${Date.now()}`)
    if (typeof window !== 'undefined') {
      const next = id && id !== HUB_ID ? `#${id}` : ' '
      history.replaceState(null, '', next === ' ' ? window.location.pathname : next)
    }
  }, [])

  // Deep link: /#nucleus-aria opens and flies to that agent. Also listens for
  // hashchange, so pasting a link into an already-open tab works — and so does
  // editing the hash by hand.
  useEffect(() => {
    const apply = () => {
      const id = window.location.hash.slice(1)
      if (id && byId.has(id)) {
        setSelected(id)
        setFocus(id)
      } else if (!id) {
        setSelected(null)
      }
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault()
        setPaletteOpen(true)
      } else if (e.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false)
        else select(null, true)
      } else if (e.key === 'l' && !typing) {
        setLens(LENSES[(LENSES.indexOf(lens) + 1) % LENSES.length])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, lens, select])

  const hov = hovered ? byId.get(hovered) : null
  const legend = legendFor(lens)

  return (
    <main className="sm-root">
      <Starmap
        theme={theme}
        lens={lens}
        selected={selected}
        focus={focus}
        onSelect={(id) => select(id)}
        onHover={setHovered}
      />

      <div className="sm-grain" aria-hidden />
      <div className="sm-vignette" aria-hidden />

      <header className="sm-header">
        <h1>{APP.name}</h1>
        <p>
          {APP.tagline} · {counts.agents} agents · {counts.tools} tools · {counts.worlds} worlds
        </p>
      </header>

      <div className="sm-topleft">
        <button className="sm-btn" onClick={() => setTheme(theme === 'night' ? 'day' : 'night')}>
          {theme === 'night' ? '☀ Dune' : '☾ Deep space'}
        </button>
        <button className="sm-btn" onClick={() => setPaletteOpen(true)}>
          Find <kbd>⌘K</kbd>
        </button>
      </div>

      <div className="sm-lenses">
        {LENSES.map((l) => (
          <button key={l} className={`sm-lens${l === lens ? ' is-on' : ''}`} onClick={() => setLens(l)}>
            {LENS_LABEL[l]}
          </button>
        ))}
      </div>

      <div className="sm-legend">
        <div className="sm-legend__title">{LENS_LABEL[lens]}</div>
        <div className="sm-legend__rows">
          {legend.map((row) => (
            <button
              key={row.key}
              className="sm-legend__row"
              onClick={() => (lens === 'world' ? select(row.key, true) : undefined)}
              disabled={lens !== 'world'}
            >
              <span className="sm-dot" style={{ background: row.color }} />
              <span className="sm-legend__label">{row.label}</span>
              <span className="sm-legend__count">{row.count}</span>
            </button>
          ))}
        </div>
        {lens === 'status' && counts.agents + counts.tools > 0 ? (
          <p className="sm-legend__foot">Status is unset until confirmed — the map shows its own gaps.</p>
        ) : null}
        {lens === 'world' && counts.unpopulated ? (
          <p className="sm-legend__foot">{counts.unpopulated} worlds have no agents mapped yet.</p>
        ) : null}
      </div>

      {selected ? (
        <Inspector id={selected} lens={lens} onClose={() => select(null, true)} onPick={(id) => select(id, true)} />
      ) : null}

      <div className="sm-hint">
        {hov ? (
          <span>
            <span className="sm-dot" style={{ background: hov.color }} /> {hov.name} · {hov.role}
          </span>
        ) : (
          'Click a body to inspect · Drag to orbit · Scroll to zoom · L cycles lens'
        )}
      </div>

      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onPick={(id) => {
          setPaletteOpen(false)
          select(id, true)
        }}
      />
    </main>
  )
}
