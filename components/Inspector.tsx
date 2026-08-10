'use client'

import { KIND_LABEL, byId, colorUnder, lanesFrom, registry, worldById } from '../lib/graph'
import type { Lens, Placed } from '../lib/graph'

interface Props {
  id: string
  lens: Lens
  onClose: () => void
  onPick: (id: string) => void
}

export default function Inspector({ id, lens, onClose, onPick }: Props) {
  const node = byId.get(id)
  if (!node) return null

  const accent = colorUnder(node, lens)
  const world = node.world ? worldById.get(node.world) : undefined
  const moons: Placed[] =
    node.kind === 'world' ? [...byId.values()].filter((p) => p.world === node.id && p.kind !== 'world') : []

  const routes = lanesFrom(node.id).filter((l) => !l.spine)

  return (
    <aside className="sm-inspector" style={{ '--accent': accent } as React.CSSProperties}>
      <button className="sm-inspector__close" onClick={onClose} aria-label="Close">
        ×
      </button>

      <div className="sm-eyebrow">
        <span className="sm-dot" style={{ background: accent }} />
        {KIND_LABEL[node.kind]}
        {world && node.kind !== 'world' ? ` · ${world.name}` : ''}
      </div>

      <h2 className="sm-inspector__name">{node.name}</h2>
      <div className="sm-inspector__role">{node.role}</div>

      <dl className="sm-facts">
        {node.model ? (
          <>
            <dt>Model</dt>
            <dd>
              <code className="sm-code">{node.model}</code>
            </dd>
          </>
        ) : null}
        {node.runtime ? (
          <>
            <dt>Runs as</dt>
            <dd>{node.runtime}</dd>
          </>
        ) : null}
        {node.kind !== 'world' && node.kind !== 'hub' ? (
          <>
            <dt>Status</dt>
            <dd className={node.status === 'unverified' ? 'sm-unset' : undefined}>
              {node.status === 'unverified' ? 'unverified — not yet confirmed' : node.status}
            </dd>
          </>
        ) : null}
        {node.maxIterations ? (
          <>
            <dt>Max steps</dt>
            <dd>{node.maxIterations}</dd>
          </>
        ) : null}
        {node.kind === 'world' && node.stack ? (
          <>
            <dt>Stack</dt>
            <dd>{node.stack}</dd>
          </>
        ) : null}
        {node.kind === 'world' && node.note ? (
          <>
            <dt>Note</dt>
            <dd>{node.note}</dd>
          </>
        ) : null}
        <dt>Source</dt>
        <dd>
          <code className="sm-code sm-code--path">{node.source}</code>
        </dd>
      </dl>

      <p className="sm-inspector__detail">{node.detail}</p>

      {node.tools?.length ? (
        <section>
          <h3 className="sm-h3">Surface</h3>
          <ul className="sm-chips">
            {node.tools.map((t) => (
              <li key={t}>
                <code className="sm-code">{t}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {node.kind === 'world' ? (
        <section>
          <h3 className="sm-h3">
            In orbit · {moons.length}
            {moons.length === 0 ? ' — no agents mapped yet' : ''}
          </h3>
          {moons.length ? (
            <ul className="sm-rows">
              {moons.map((m) => (
                <li key={m.id}>
                  <button className="sm-row" onClick={() => onPick(m.id)}>
                    <span className="sm-dot sm-dot--sm" style={{ background: colorUnder(m, lens) }} />
                    <span className="sm-row__name">{m.name}</span>
                    <span className="sm-row__meta">{m.model ?? KIND_LABEL[m.kind]}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sm-empty">
              A real repository with nothing on the map. Add its first agent to{' '}
              <code className="sm-code">lib/registry/</code>.
            </p>
          )}
        </section>
      ) : null}

      {routes.length ? (
        <section>
          <h3 className="sm-h3">Lanes</h3>
          <ul className="sm-rows">
            {routes.map((l) => {
              const otherId = l.from === node.id ? l.to : l.from
              const other = byId.get(otherId)
              if (!other) return null
              return (
                <li key={`${l.from}-${l.to}`}>
                  <button className="sm-row" onClick={() => onPick(other.id)}>
                    <span className="sm-row__arrow">{l.from === node.id ? '→' : '←'}</span>
                    <span className="sm-dot sm-dot--sm" style={{ background: colorUnder(other, lens) }} />
                    <span className="sm-row__name">{other.name}</span>
                    <span className="sm-row__meta">{l.label}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {node.kind === 'hub' ? (
        <section>
          <h3 className="sm-h3">Map integrity</h3>
          <ul className="sm-rows sm-rows--plain">
            <li>{registry.bodies.length} nodes, every one citing a file</li>
            <li>{registry.routes.length} declared lanes</li>
            <li>0 inferred entries</li>
          </ul>
        </section>
      ) : null}
    </aside>
  )
}
