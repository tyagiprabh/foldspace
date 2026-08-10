import { defineBodies, defineRoutes, defineWorld } from '../schema'

export const world = defineWorld({
  id: 'revops',
  name: 'RevOps Pipeline',
  scope: 'personal',
  source: 'personal/Dust-prep',
  runtime: 'local',
  blurb:
    'A multi-agent pipeline for revenue operations. It takes a messy CRM export and raw sales-call transcripts and returns a clean deal table, per-deal risk assessments and a weekly digest.',
  stack: 'Python · Claude · Dust',
  note: 'Public · CI green · offline demo + live mode',
})

export const bodies = defineBodies(
  {
    id: 'revops-hygiene',
    name: 'CRM Hygiene',
    world: 'revops',
    kind: 'agent',
    role: 'CRM operations specialist',
    model: 'claude-opus-5',
    source: 'personal/Dust-prep/agents/crm_hygiene_agent.md',
    runtime: 'local',
    detail:
      'Holds that data hygiene is a daily habit, not a quarterly cleanup panic. Standardises formatting, fixes name case and country values, and flags free-email contacts, stale records, duplicates and bad lead sources before they pollute the database.',
    tools: ['run_hygiene'],
  },
  {
    id: 'revops-pipeline',
    name: 'Pipeline Analyst',
    world: 'revops',
    kind: 'agent',
    role: 'Senior RevOps pipeline analyst',
    model: 'claude-opus-5',
    source: 'personal/Dust-prep/agents/pipeline_analyst_agent.md',
    runtime: 'local',
    detail:
      'Does not trust the CRM stage — trusts what the prospect actually said. Cross-references each deal record against the call transcripts and returns an objective risk assessment.',
    tools: ['run_pipeline_analysis', 'assess_live', 'assess_deterministic'],
  },
  {
    id: 'revops-digest',
    name: 'Revenue Digest',
    world: 'revops',
    kind: 'agent',
    role: 'RevOps chief of staff',
    model: 'claude-opus-5',
    source: 'personal/Dust-prep/agents/revenue_digest_agent.md',
    runtime: 'local',
    detail:
      'Compresses the hygiene report, every risk assessment and the cleaned deal table into one markdown digest a Head of Sales reads in two minutes and acts on immediately.',
    tools: ['build_digest', 'write_reports'],
  },
)

export const routes = defineRoutes(
  { from: 'revops-hygiene', to: 'revops-pipeline', label: 'clean deals →' },
  { from: 'revops-pipeline', to: 'revops-digest', label: 'risk assessments →' },
)
