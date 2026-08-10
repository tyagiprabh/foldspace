import { defineBodies, defineRoutes, defineWorld } from '../schema'

export const world = defineWorld({
  id: 'mcp-odoo',
  name: 'MCP · Odoo',
  scope: 'work',
  source: 'work/mcp-irisgalerie-odoo',
  runtime: 'mcp',
  blurb:
    'Internal MCP server bridging Claude agents and the Iris Odoo instances, so the IT team queries galleries, sales, inventory, finance and custom-module state through structured tools instead of hand-rolling XML-RPC.',
  stack: 'Python · MCP · XML-RPC',
  note: 'Forked from tuanle96/mcp-odoo v0.3.0 · read-only by default',
})

/**
 * One node per tool module that actually exists on disk. Each `tools` list is
 * the module's real exported surface.
 */
export const bodies = defineBodies(
  {
    id: 'mcp-galleries',
    name: 'Galleries',
    world: 'mcp-odoo',
    kind: 'tool',
    role: 'Tool domain',
    source: 'work/mcp-irisgalerie-odoo/src/iris_odoo_mcp/iris/tools/galleries.py',
    runtime: 'mcp',
    detail: 'Gallery lookup and per-gallery KPIs.',
    tools: ['search_galleries', 'get_gallery_details', 'get_gallery_kpis'],
  },
  {
    id: 'mcp-sales-crm',
    name: 'Sales & CRM',
    world: 'mcp-odoo',
    kind: 'tool',
    role: 'Tool domain',
    source: 'work/mcp-irisgalerie-odoo/src/iris_odoo_mcp/iris/tools/sales_crm.py',
    runtime: 'mcp',
    detail: 'Sales by gallery and a consolidated customer view.',
    tools: ['search_sales_by_gallery', 'get_customer_360'],
  },
  {
    id: 'mcp-inventory',
    name: 'Inventory',
    world: 'mcp-odoo',
    kind: 'tool',
    role: 'Tool domain',
    source: 'work/mcp-irisgalerie-odoo/src/iris_odoo_mcp/iris/tools/inventory.py',
    runtime: 'mcp',
    detail: 'Stock levels, production status and picking search for IGD.',
    tools: ['get_igd_inventory', 'get_igd_production_status', 'search_igd_pickings'],
  },
  {
    id: 'mcp-finance',
    name: 'Finance',
    world: 'mcp-odoo',
    kind: 'tool',
    role: 'Tool domain',
    source: 'work/mcp-irisgalerie-odoo/src/iris_odoo_mcp/iris/tools/finance.py',
    runtime: 'mcp',
    detail: 'Revenue rollups, purchase orders and tax-mapping anomaly detection.',
    tools: ['get_revenue_summary', 'get_igd_purchase_orders', 'search_tax_mapping_anomalies'],
  },
  {
    id: 'mcp-cegid',
    name: 'Cegid Sync',
    world: 'mcp-odoo',
    kind: 'tool',
    role: 'Tool domain',
    source: 'work/mcp-irisgalerie-odoo/src/iris_odoo_mcp/iris/tools/cegid_sync.py',
    runtime: 'mcp',
    detail: 'Watches the POS sync queue, surfaces anomalies, and replays a failed line or the whole queue.',
    tools: ['get_cegid_sync_status', 'search_cegid_anomalies', 'replay_cegid_line', 'replay_cegid_queue'],
  },
  {
    id: 'mcp-modules',
    name: 'Custom Modules',
    world: 'mcp-odoo',
    kind: 'tool',
    role: 'Tool domain',
    source: 'work/mcp-irisgalerie-odoo/src/iris_odoo_mcp/iris/tools/modules_custom.py',
    runtime: 'mcp',
    detail: 'Introspects the custom module estate — manifests, model schemas and record counts.',
    tools: ['list_custom_modules', 'get_module_schema', 'count_records_by_model'],
  },
  {
    id: 'mcp-safe-write',
    name: 'Safe Write',
    world: 'mcp-odoo',
    kind: 'tool',
    role: 'Write guardrail',
    source: 'work/mcp-irisgalerie-odoo/src/iris_odoo_mcp/agent_tools.py',
    runtime: 'mcp',
    detail:
      'Writes are gated: the server builds a preview report, issues an approval token, and refuses to execute without a verified token. Also carries the addons source scanner and domain report.',
    tools: ['build_write_preview_report', 'build_approval_token', 'verify_write_approval', 'scan_addons_source_report'],
  },
  {
    id: 'mcp-diagnostics',
    name: 'Diagnostics',
    world: 'mcp-odoo',
    kind: 'tool',
    role: 'Observability',
    source: 'work/mcp-irisgalerie-odoo/src/iris_odoo_mcp/diagnostics.py',
    runtime: 'mcp',
    detail:
      'Explains a failed Odoo call, alongside major-version detection, rate limiting, identity scoping and a structured response envelope.',
    tools: ['diagnose_failed_odoo_call', 'iris_envelope', 'iris_get_major_version'],
  },
)

export const routes = defineRoutes()
