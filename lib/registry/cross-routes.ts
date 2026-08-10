/**
 * Routes that cross a world boundary. These are the interesting lanes — the
 * ones ships fly down when you select a node.
 *
 * Same rule as everywhere else: only add a route that is true of the code.
 */
import { defineRoutes } from '../schema'

export const crossRoutes = defineRoutes(
  { from: 'mcp-modules', to: 'irisgalerie', label: 'introspects' },
  { from: 'mcp-cegid', to: 'irisgalerie', label: 'replays POS queue on' },
  { from: 'mcp-galleries', to: 'irisgalerie', label: 'reads' },
)
