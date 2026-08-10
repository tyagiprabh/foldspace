'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { KIND_LABEL, searchIndex } from '../lib/graph'

/**
 * Jump-to-node palette. The thing that keeps the map usable once orbiting to
 * find something stops being practical. ⌘K / Ctrl-K / "/" to open.
 */
export default function Palette({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const pool = needle ? searchIndex.filter((r) => r.haystack.includes(needle)) : searchIndex
    return pool.slice(0, 40)
  }, [q])

  useEffect(() => {
    if (open) {
      setQ('')
      setCursor(0)
      inputRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    setCursor(0)
  }, [q])

  if (!open) return null

  const commit = (i: number) => {
    const hit = results[i]
    if (hit) onPick(hit.id)
  }

  return (
    <div className="sm-palette-scrim" onPointerDown={onClose}>
      <div className="sm-palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="sm-palette__input"
          placeholder="Find an agent, tool, model or repo…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(c + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              commit(cursor)
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
        />
        <ul className="sm-palette__list">
          {results.map((r, i) => (
            <li key={r.id}>
              <button
                className={`sm-palette__row${i === cursor ? ' is-cursor' : ''}`}
                onPointerEnter={() => setCursor(i)}
                onClick={() => commit(i)}
              >
                <span className="sm-dot" style={{ background: r.color }} />
                <span className="sm-palette__name">{r.name}</span>
                <span className="sm-palette__meta">
                  {KIND_LABEL[r.kind]}
                  {r.world ? ` · ${r.world}` : ''}
                </span>
              </button>
            </li>
          ))}
          {!results.length ? <li className="sm-palette__empty">Nothing matches.</li> : null}
        </ul>
        <div className="sm-palette__foot">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move <kbd>↵</kbd> fly to <kbd>esc</kbd> close
        </div>
      </div>
    </div>
  )
}
