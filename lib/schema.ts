/**
 * The contract every entry in the registry must satisfy.
 *
 * Two rules make this scale, and both are enforced at build time by
 * `validate()` — a bad entry fails `next build`, not the browser:
 *
 *  1. Every agent cites a `source`. If it did not come from a file in a repo,
 *     it does not go on the map. No inferred nodes, no filler.
 *  2. No entry carries a position. Layout is derived from ids (see layout.ts),
 *     so adding the 100th world never moves the first 99.
 */

export type Kind = 'hub' | 'world' | 'agent' | 'tool'
export type Scope = 'work' | 'personal'

/**
 * Where the thing actually executes. Only set this when the file's location or
 * contents prove it — `.claude/agents/*.md` proves 'claude-code', a registered
 * MCP tool proves 'mcp'. Never guess.
 */
export type Runtime = 'claude-code' | 'mcp' | 'api' | 'cron' | 'dust' | 'cloud-run' | 'local'

/**
 * Operational state. Deliberately includes 'unverified' as the default: an
 * agent whose status nobody has confirmed renders dim, so the map shows its own
 * blind spots instead of hiding them behind a confident colour.
 */
export type Status = 'live' | 'staging' | 'local' | 'archived' | 'planned' | 'unverified'

export interface World {
  /** Stable, kebab-case. Drives colour and orbital position — never change it. */
  id: string
  name: string
  scope: Scope
  /** One or two sentences. Must be defensible from the repo itself. */
  blurb: string
  stack: string
  /** Repo-relative or absolute path this world describes. */
  source: string
  /** The repo's primary execution surface, when one dominates. */
  runtime?: Runtime
  /** Short factual note. Free text — not the `Status` union. */
  note?: string
}

export interface Body {
  /** Stable, kebab-case, unique across the whole registry. */
  id: string
  name: string
  /** `id` of the world this orbits. */
  world: string
  kind: Extract<Kind, 'agent' | 'tool'>
  /** e.g. "Intent router", "Tool domain". */
  role: string
  /**
   * Where this came from — a path inside the repo. Required. This is the
   * anti-fabrication guarantee: no source, no node.
   */
  source: string
  /** What it does. Written from the source, not from imagination. */
  detail: string
  /** Model id, when the node calls an LLM. Drives the "by model" view. */
  model?: string
  /** Iteration / step ceiling, when the source states one. */
  maxIterations?: number
  /** Tool or capability names the source actually exposes. */
  tools?: string[]
  /** Where it runs. Set only when the source proves it. */
  runtime?: Runtime
  /** Operational state. Leave unset unless confirmed — it defaults to 'unverified'. */
  status?: Status
  /** ISO date it first shipped, when known. Reserved for the timeline view. */
  since?: string
  /** Free-form facets for filtering. */
  tags?: string[]
  /**
   * Reserved telemetry slots. Nothing populates these yet; they exist so a
   * feed can fill them without a schema migration. See README → Roadmap.
   */
  metrics?: {
    invocations30d?: number
    costUsd30d?: number
    p50Ms?: number
    errorRate?: number
  }
}

export interface Route {
  from: string
  to: string
  /** Verb describing the real relationship. Shown on the inspector. */
  label: string
}

/** Identity helpers — they exist so registry files read declaratively. */
export const defineWorld = (w: World): World => w
export const defineWorlds = (...w: World[]): World[] => w
export const defineBodies = (...b: Body[]): Body[] => b
export const defineRoutes = (...r: Route[]): Route[] => r

export interface Registry {
  worlds: World[]
  bodies: Body[]
  routes: Route[]
}

export function validate(reg: Registry): Registry {
  const problems: string[] = []
  const worldIds = new Set<string>()

  for (const w of reg.worlds) {
    if (worldIds.has(w.id)) problems.push(`duplicate world id "${w.id}"`)
    worldIds.add(w.id)
    if (!w.source) problems.push(`world "${w.id}" has no source`)
  }

  const bodyIds = new Set<string>()
  for (const b of reg.bodies) {
    if (bodyIds.has(b.id) || worldIds.has(b.id)) problems.push(`duplicate node id "${b.id}"`)
    bodyIds.add(b.id)
    if (!worldIds.has(b.world)) problems.push(`node "${b.id}" orbits unknown world "${b.world}"`)
    if (!b.source) problems.push(`node "${b.id}" has no source — every agent must cite a file`)
    if (!b.detail) problems.push(`node "${b.id}" has no detail`)
  }

  const known = new Set([...worldIds, ...bodyIds])
  for (const r of reg.routes) {
    if (!known.has(r.from)) problems.push(`route from unknown node "${r.from}"`)
    if (!known.has(r.to)) problems.push(`route to unknown node "${r.to}"`)
    if (r.from === r.to) problems.push(`route loops on itself at "${r.from}"`)
  }

  if (problems.length) {
    throw new Error(`Registry is invalid:\n  - ${problems.join('\n  - ')}`)
  }
  return reg
}
