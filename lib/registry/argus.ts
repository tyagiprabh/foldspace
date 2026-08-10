import { defineBodies, defineRoutes, defineWorld } from '../schema'

export const world = defineWorld({
  id: 'argus',
  name: 'Argus',
  scope: 'work',
  source: 'work/Argus',
  runtime: 'claude-code',
  blurb:
    'Camera surveillance platform for the Iris Galerie retail network — live camera wall, fleet health analytics and role-based regional access.',
  stack: 'Next.js · Node/Express · PostgreSQL · MediaMTX',
  note: 'Pre-launch · trust, uptime and security outrank features',
})

export const bodies = defineBodies({
  id: 'argus-pm',
  name: 'Product Manager',
  world: 'argus',
  kind: 'agent',
  role: 'Agile PM subagent',
  model: 'Claude Code subagent',
  source: 'work/Argus/.claude/agents/product-manager.md',
  runtime: 'claude-code',
  detail:
    'Picks the next backlog items at the start of a session, verifies acceptance and updates BACKLOG.md at the end, and grooms the backlog when prioritisation or scope questions come up.',
  tools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash'],
})

export const routes = defineRoutes()
