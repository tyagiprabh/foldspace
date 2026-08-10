/**
 * Registry → placed graph. Everything downstream reads from here.
 */
import { registry } from './registry'
import { assignColors, hash01, moonOffset, orbitPosition, relaxedAngles, shellFor } from './layout'
import type { Body, Kind, Route, Runtime, Status, World } from './schema'

export type { Body, Kind, Route, Runtime, Status, World }
export { registry }

export const HUB_ID = '__hub__'
export const HUB_COLOR = '#F59E0B'

export interface Placed {
  id: string
  name: string
  kind: Kind
  role: string
  detail: string
  source: string
  color: string
  x: number
  y: number
  z: number
  radius: number
  /** World id this orbits — undefined for the hub. */
  world?: string
  model?: string
  maxIterations?: number
  tools?: string[]
  runtime?: Runtime
  status: Status
  since?: string
  tags?: string[]
  /** Only on worlds. */
  stack?: string
  note?: string
  scope?: World['scope']
  shell?: number
}

const RADIUS: Record<Kind, number> = { hub: 0.72, world: 0.5, agent: 0.34, tool: 0.3 }
export const KIND_LABEL: Record<Kind, string> = { hub: 'Origin', world: 'World', agent: 'Agent', tool: 'Tool' }

const colors = assignColors(registry.worlds.map((w) => w.id))
const angles = relaxedAngles(registry.worlds.map((w) => w.id))

/** Shell membership follows the relaxed angle order, so shells stay balanced. */
const shellOrder = [...registry.worlds].sort((a, b) => (angles.get(a.id) ?? 0) - (angles.get(b.id) ?? 0))
const shellIndex = new Map(shellOrder.map((w, i) => [w.id, i]))

function build(): Placed[] {
  const out: Placed[] = [
    {
      id: HUB_ID,
      name: 'Origin',
      kind: 'hub',
      role: 'Fleet origin',
      detail: `${registry.worlds.length} worlds mapped. Every agent on this map cites a file in a repository — nothing here is inferred.`,
      source: 'prabh works',
      color: HUB_COLOR,
      x: 0,
      y: 0,
      z: 0,
      radius: RADIUS.hub,
      status: 'live',
    },
  ]

  for (const w of registry.worlds) {
    const shell = shellFor(shellIndex.get(w.id) ?? 0)
    // Inclination is hashed too, so a world's height is as stable as its arc.
    const p = orbitPosition(angles.get(w.id) ?? 0, shell, hash01(w.id + '#inc'))
    const color = colors.get(w.id) ?? HUB_COLOR

    out.push({
      id: w.id,
      name: w.name,
      kind: 'world',
      role: w.scope === 'work' ? 'Work repository' : 'Personal repository',
      detail: w.blurb,
      source: w.source,
      color,
      x: p.x,
      y: p.y,
      z: p.z,
      radius: RADIUS.world,
      world: w.id,
      stack: w.stack,
      note: w.note,
      runtime: w.runtime,
      status: 'unverified',
      scope: w.scope,
      shell: shell.index,
    })

    const moons = registry.bodies.filter((b) => b.world === w.id)
    moons.forEach((b, i) => {
      const off = moonOffset(i, moons.length)
      out.push({
        id: b.id,
        name: b.name,
        kind: b.kind,
        role: b.role,
        detail: b.detail,
        source: b.source,
        color,
        x: p.x + off.x,
        y: p.y + off.y,
        z: p.z + off.z,
        radius: RADIUS[b.kind],
        world: w.id,
        model: b.model,
        maxIterations: b.maxIterations,
        tools: b.tools,
        runtime: b.runtime,
        status: b.status ?? 'unverified',
        since: b.since,
        tags: b.tags,
        scope: w.scope,
        shell: shell.index,
      })
    })
  }

  return out
}

export const placed: Placed[] = build()
export const byId = new Map(placed.map((p) => [p.id, p]))
export const worldById = new Map(registry.worlds.map((w) => [w.id, w]))

export interface Lane extends Route {
  /** True for the structural hub→world→moon spine. */
  spine: boolean
}

function buildLanes(): Lane[] {
  const spine: Lane[] = []
  for (const w of registry.worlds) {
    spine.push({ from: HUB_ID, to: w.id, label: 'holds', spine: true })
    for (const b of registry.bodies) {
      if (b.world === w.id) spine.push({ from: w.id, to: b.id, label: 'orbits', spine: true })
    }
  }
  return [...spine, ...registry.routes.map((r) => ({ ...r, spine: false }))]
}

export const lanes: Lane[] = buildLanes()

/** Lanes a ship should fly when `id` is selected. */
export function lanesFrom(id: string): Lane[] {
  return lanes.filter((l) => l.from === id || l.to === id)
}

export function neighboursOf(id: string): Set<string> {
  const s = new Set<string>([id])
  for (const l of lanes) {
    if (l.from === id) s.add(l.to)
    if (l.to === id) s.add(l.from)
  }
  return s
}

export const counts = {
  worlds: registry.worlds.length,
  agents: registry.bodies.filter((b) => b.kind === 'agent').length,
  tools: registry.bodies.filter((b) => b.kind === 'tool').length,
  routes: registry.routes.length,
  unpopulated: registry.worlds.filter((w) => !registry.bodies.some((b) => b.world === w.id)).length,
}

/* ── lenses ────────────────────────────────────────────────────────────────
 * The same map, recoloured to answer a different question. Adding a lens is a
 * pure function plus one legend entry — no change to the registry or layout.
 */

export type Lens = 'world' | 'model' | 'runtime' | 'status'

export const LENS_LABEL: Record<Lens, string> = {
  world: 'By repo',
  model: 'By LLM',
  runtime: 'By runtime',
  status: 'By status',
}

const UNKNOWN = '#6E6656'
const NOT_APPLICABLE = '#4F4A40'

/**
 * Collapse a model id to its provider family, so the legend stays short.
 *
 * A tool with no model is not a gap — tools do not call an LLM. Separating the
 * two keeps the "unset" count meaningful: it only ever means "an agent whose
 * model nobody has recorded".
 */
export function modelFamily(model: string | undefined, kind?: Kind): string {
  if (!model) return kind === 'tool' ? 'Tool — no LLM' : 'unset'
  const m = model.toLowerCase()
  if (m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) return 'Claude'
  if (m.includes('gemini')) return 'Gemini'
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3')) return 'OpenAI'
  if (m.includes('llama') || m.includes('mistral')) return 'Open weights'
  return 'Other'
}

const MODEL_COLOR: Record<string, string> = {
  Claude: '#D98E44',
  Gemini: '#5B8FC7',
  OpenAI: '#4E9E8F',
  'Open weights': '#8E9A5B',
  Other: '#9A8FA8',
  'Tool — no LLM': NOT_APPLICABLE,
  unset: UNKNOWN,
}

const RUNTIME_COLOR: Record<string, string> = {
  'claude-code': '#D98E44',
  mcp: '#C25E32',
  api: '#5B8FC7',
  'cloud-run': '#4E9E8F',
  cron: '#8E9A5B',
  dust: '#9A8FA8',
  local: '#B39A72',
  none: UNKNOWN,
}

const STATUS_COLOR: Record<Status, string> = {
  live: '#4E9E8F',
  staging: '#D9A03C',
  local: '#8E9A5B',
  archived: '#7E8494',
  planned: '#6E6558',
  unverified: UNKNOWN,
}

export function colorUnder(p: Placed, lens: Lens): string {
  if (p.kind === 'hub') return HUB_COLOR
  switch (lens) {
    case 'world':
      return p.color
    // Worlds keep their identity colour under the other lenses, since a repo
    // has no single model or runtime — only its moons do.
    case 'model':
      return p.kind === 'world' ? p.color : (MODEL_COLOR[modelFamily(p.model, p.kind)] ?? UNKNOWN)
    case 'runtime':
      return p.kind === 'world' ? p.color : (RUNTIME_COLOR[p.runtime ?? 'none'] ?? UNKNOWN)
    case 'status':
      return p.kind === 'world' ? p.color : STATUS_COLOR[p.status]
  }
}

export interface LegendRow {
  key: string
  label: string
  color: string
  count: number
}

/** Legend rows for a lens, ordered by population. Derived, never hand-listed. */
export function legendFor(lens: Lens): LegendRow[] {
  if (lens === 'world') {
    return registry.worlds
      .map((w) => ({
        key: w.id,
        label: w.name,
        color: byId.get(w.id)?.color ?? UNKNOWN,
        count: registry.bodies.filter((b) => b.world === w.id).length,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }

  const moons = placed.filter((p) => p.kind === 'agent' || p.kind === 'tool')
  const tally = new Map<string, { color: string; count: number }>()

  for (const p of moons) {
    const key =
      lens === 'model' ? modelFamily(p.model, p.kind) : lens === 'runtime' ? (p.runtime ?? 'none') : p.status
    const row = tally.get(key) ?? { color: colorUnder(p, lens), count: 0 }
    row.count++
    tally.set(key, row)
  }

  return [...tally.entries()]
    .map(([key, v]) => ({ key, label: key === 'none' ? 'unset' : key, color: v.color, count: v.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** Everything the command palette can jump to. */
export const searchIndex = placed
  .filter((p) => p.kind !== 'hub')
  .map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    role: p.role,
    color: p.color,
    world: p.world ? (worldById.get(p.world)?.name ?? '') : '',
    haystack: [p.name, p.role, p.model ?? '', p.world ?? '', ...(p.tools ?? [])].join(' ').toLowerCase(),
  }))
