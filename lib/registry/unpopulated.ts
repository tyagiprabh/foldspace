/**
 * Real repositories that do not have agents on the map yet.
 *
 * They render as bare worlds — a visible slot, not a fabricated one. When an
 * agent lands in one of these repos, promote it into its own registry file
 * (copy `nucleus.ts` as the shape) and delete its entry from here.
 */
import { defineWorlds } from '../schema'

export const worlds = defineWorlds(
  {
    id: 'irisgalerie',
    name: 'IrisGalerie',
    scope: 'work',
    source: 'work/IrisGalerie',
    blurb:
      'The Odoo 19 ERP that runs the gallery network: sales, inventory, finance, loyalty, tax and the Cegid POS bridge.',
    stack: 'Odoo 19 · Python · PostgreSQL',
    note: '81 custom modules · migrated V17 → V19',
  },
  {
    id: 'odoo-kb',
    name: 'odoo-kb',
    scope: 'work',
    source: 'work/odoo-kb',
    blurb:
      'Engineering mirror of the Odoo documentation effort — code findings tracked in git next to the code, plus a black-box pytest harness that reproduces them against a neutralised clone.',
    stack: 'Markdown · pytest · Docker',
    note: 'Stage 1 complete (80/80) · Stage 3 harness live',
  },
  {
    id: 'ops-manager',
    name: 'Iris Ops',
    scope: 'work',
    source: 'work/ops-manager-gcp',
    blurb:
      'Operational management app for the ~179-gallery network across 15+ countries — dashboards, performance, planning, alerts, area managers and user administration.',
    stack: 'Cloud Run · BigQuery · dbt · React',
    note: 'Production — ops.irisgalerie.com',
  },
  {
    id: 'news',
    name: 'News',
    scope: 'personal',
    source: 'personal/News',
    blurb: 'Next.js news reader.',
    stack: 'Next.js · TypeScript · Tailwind',
  },
  {
    id: 'portfolio',
    name: 'Portfolio',
    scope: 'personal',
    source: 'personal/portfolio',
    blurb: 'Single-page personal site.',
    stack: 'HTML',
  },
)
