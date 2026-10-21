import { defineBodies, defineRoutes, defineWorld } from '../schema'

export const world = defineWorld({
  id: 'nucleus',
  name: 'Nucleus HR',
  scope: 'work',
  source: 'work/Nucleus',
  runtime: 'api',
  blurb:
    'HR intelligence assistant for Iris Galerie. A router reads intent and hands the request to one named specialist; the frontend draws the agent network as an orbital space UI.',
  stack: 'Python · Gemini · React · Vite',
  note: '5 specialists behind 1 router',
})

export const bodies = defineBodies(
  {
    id: 'nucleus-router',
    name: 'Router',
    world: 'nucleus',
    kind: 'agent',
    role: 'Intent router',
    model: 'gemini-2.5-flash',
    source: 'work/Nucleus/backend/agents/router.py',
    runtime: 'api',
    detail:
      'Classifies the incoming HR request and dispatches it to exactly one specialist. Unmatched requests fall through to the general agent.',
    tools: ['router.py', 'registry.py'],
  },
  {
    id: 'nucleus-aria',
    name: 'Aria',
    world: 'nucleus',
    kind: 'agent',
    role: 'Onboarding specialist',
    model: 'gemini-2.5-flash',
    maxIterations: 5,
    source: 'work/Nucleus/backend/agents/onboarding/README.md',
    runtime: 'api',
    detail:
      'Generates country-specific onboarding checklists for new employees — IT setup sequences, legal pre-hire obligations, day-1 schedules and role-based system access across all six operating countries.',
    tools: ['generate_onboarding_checklist'],
  },
  {
    id: 'nucleus-felix',
    name: 'Felix',
    world: 'nucleus',
    kind: 'agent',
    role: 'Offboarding specialist',
    model: 'gemini-2.5-flash',
    maxIterations: 5,
    source: 'work/Nucleus/backend/agents/offboarding/README.md',
    runtime: 'api',
    detail:
      'Produces ordered, country-specific offboarding checklists for departing employees — access revocation sequence, equipment return, legal exit obligations and knowledge transfer.',
    tools: ['generate_offboarding_checklist'],
  },
  {
    id: 'nucleus-lex',
    name: 'Lex',
    world: 'nucleus',
    kind: 'agent',
    role: 'Employment law specialist',
    model: 'gemini-2.5-flash',
    maxIterations: 3,
    source: 'work/Nucleus/backend/agents/compliance/README.md',
    runtime: 'api',
    detail:
      'Answers employment-law questions for Spain, Italy, Netherlands, Poland, France and Singapore — working hours, leave entitlements, minimum wages, notice periods, overtime, plus AML obligations specific to the jewellery sector.',
    tools: ['get_country_compliance_info'],
  },
  {
    id: 'nucleus-scout',
    name: 'Scout',
    world: 'nucleus',
    kind: 'agent',
    role: 'Talent acquisition specialist',
    model: 'gemini-2.5-flash',
    maxIterations: 4,
    source: 'work/Nucleus/backend/agents/candidate/README.md',
    runtime: 'api',
    detail:
      'Finds qualified candidates via live web search, drafts job descriptions aligned to luxury-retail standards, and generates structured interview question sets for any position.',
    tools: ['search_candidates'],
  },
  {
    id: 'nucleus-general',
    name: 'General',
    world: 'nucleus',
    kind: 'agent',
    role: 'General HR intelligence',
    model: 'gemini-2.5-flash',
    maxIterations: 3,
    source: 'work/Nucleus/backend/agents/general/README.md',
    runtime: 'api',
    detail:
      'Handles anything that does not need a specialist — policy explanations, system overviews, multi-topic queries, and requests sitting between the four specialist domains.',
  },
)

export const routes = defineRoutes(
  { from: 'nucleus-router', to: 'nucleus-aria', label: 'routes to' },
  { from: 'nucleus-router', to: 'nucleus-felix', label: 'routes to' },
  { from: 'nucleus-router', to: 'nucleus-lex', label: 'routes to' },
  { from: 'nucleus-router', to: 'nucleus-scout', label: 'routes to' },
  { from: 'nucleus-router', to: 'nucleus-general', label: 'falls back to' },
)
