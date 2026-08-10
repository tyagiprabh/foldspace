/**
 * The registry. Every world file is imported here and merged into one
 * validated whole.
 *
 * Adding an agent  → edit that world's file. Nothing here changes.
 * Adding a world   → new file next to these, then two lines below.
 *
 * `validate()` runs at module load, so a duplicate id, an unknown world
 * reference, a dangling route or a missing `source` breaks the build rather
 * than shipping a wrong map.
 */
import { validate, type Registry } from '../schema'

import * as argus from './argus'
import * as mcpOdoo from './mcp-odoo'
import * as nucleus from './nucleus'
import * as revops from './revops'
import { worlds as unpopulatedWorlds } from './unpopulated'
import { crossRoutes } from './cross-routes'

const populated = [argus, mcpOdoo, nucleus, revops]

export const registry: Registry = validate({
  worlds: [...populated.map((m) => m.world), ...unpopulatedWorlds],
  bodies: populated.flatMap((m) => m.bodies),
  routes: [...populated.flatMap((m) => m.routes), ...crossRoutes],
})
