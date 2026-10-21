# Foldspace

A navigable star map of every agent I've built. Each **world** is a repository,
each **moon** is an agent or tool that orbits it, and the **lanes** between them
are real relationships in the code. Click a body and ships fly its lanes.

Next.js (static) + three.js. No backend, no database, no build step beyond `next build`.

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # static, deploys to Vercel as-is
```

---

## The one rule

**Every node cites a file.** `source` is required on the schema and enforced by
`validate()` at module load, so a node without provenance fails `next build`
rather than shipping a plausible-looking lie.

That is the whole reason this is trustworthy as a portfolio piece. Anyone can
click any agent and see the exact path it came from. There are currently
**0 inferred entries** — the Origin inspector states that count, computed, not
claimed.

The same honesty runs through `status`. It defaults to `unverified` and renders
dim, so the map shows its own blind spots instead of painting confident green
over things nobody checked.

---

## Adding an agent

One entry, one file. Positions, colours, links to the world hub, legend rows and
every count are derived.

Open the world's file in `lib/registry/` (say `lib/registry/nucleus.ts`) and
append to `bodies`:

```ts
{
  id: 'nucleus-atlas',              // unique across the whole registry
  name: 'Atlas',
  world: 'nucleus',                 // must match a world id
  kind: 'agent',                    // 'agent' | 'tool'
  role: 'Payroll specialist',
  model: 'gemini-2.5-flash',        // drives the "By LLM" lens
  runtime: 'api',                   // only if the source proves it
  source: 'work/Nucleus/backend/agents/payroll/README.md',   // required
  detail: 'What it does, written from the source.',
  tools: ['generate_payslip_summary'],
}
```

If it talks to something, add the lane in the same file's `routes` (or
`cross-routes.ts` when it crosses a world boundary):

```ts
{ from: 'nucleus-router', to: 'nucleus-atlas', label: 'routes to' }
```

Done. Nothing else to touch.

### Adding a world

New file next to the others exporting `world`, `bodies`, `routes` — copy
`nucleus.ts` for the shape. Then two lines in `lib/registry/index.ts`: the
import, and the name in the `populated` array. If the repo has no agents yet,
add it to `unpopulated.ts` instead and it renders as a bare world — a visible
slot rather than a hidden gap.

---

## Why it is built this way

Three decisions that matter as the registry grows from 18 nodes to hundreds.

**Layout is derived from ids, not stored.** Nothing in the registry carries a
coordinate. A world's angle and inclination come from an FNV-1a hash of its id,
then a deterministic relaxation pass pushes apart any pair that hashed too
close. Index-derived angles would rotate every world after an insertion, so a
map someone screenshotted last month would no longer match. Hashing pins a
world to its arc permanently. Colours work the same way: hash to a preferred
palette slot, walk to the next free one on collision, processed in id order so a
new world only ever recolours one it actually collides with.

**Worlds spill into shells.** One ring holds ~9 worlds. Past that, `shellFor()`
puts them on outer rings with a plane tilt. Nothing to re-tune at 30 worlds.

**Lenses are pure functions.** `colorUnder(node, lens)` and `legendFor(lens)`
recolour the same map to answer a different question. Adding a lens is one
function and one label — no change to the registry, layout or renderer.

### Ceilings, and what to do at them

| Scale | What breaks first | The fix, already seamed in |
|---|---|---|
| ~150 nodes | One `Mesh` per body | Every body already shares one `SphereGeometry`, so this is a straight swap to a single `InstancedMesh`; the loop iterates a flat `entries` array |
| ~150 labels | One DOM node per label | Already mostly solved: only the origin plus the hovered/selected body ever show, so at most three are visible at once regardless of registry size |
| ~40 worlds | Ring crowding | Raise `WORLDS_PER_SHELL`, or group shells by `scope` |
| Any | Finding things by orbiting | Already solved — `⌘K` palette searches name, role, model, world and tool names |

---

## What it is for

The map is one artefact serving several jobs. The first four work today; the
rest are why the schema has the fields it has.

**Working now**

1. **Portfolio.** How many agents, in what shape, across which repos — in a form
   that survives a 30-second look and rewards a 5-minute one. Every claim is
   clickable down to a file path.
2. **Model attribution.** The *By LLM* lens recolours everything by provider
   family. Right now: 6 Gemini, 4 Claude, 8 tools that call no model. That is
   also your provider-exposure map — if a model is deprecated, you can see what
   moves.
3. **Runtime map.** *By runtime* shows where things actually execute:
   Claude Code subagents, MCP tools, API-served agents, local pipelines. Useful
   when someone asks "where does this run" and the honest answer used to be a
   shrug.
4. **Deep links.** `/#nucleus-aria` opens and flies to that agent. Paste one in
   a PR or Slack instead of describing which agent you mean.

**Next, cheapest first**

5. **Live status.** `status` is already on every node. Point it at a health
   endpoint and the map becomes a fleet dashboard — dim means unverified, not
   assumed-fine.
6. **Live activity.** The ship mechanic already exists. Drive it from an
   invocation log and ships fly when an agent actually runs, not when you click.
7. **Cost and volume.** `metrics.costUsd30d` / `invocations30d` are reserved.
   Size bodies by spend and the expensive agents become visually obvious.
8. **Blast radius.** Select the MCP server, see everything that breaks if it
   goes down. The lane data already supports it; it needs a transitive
   highlight instead of a one-hop one.
9. **Duplication audit.** Two agents with near-identical roles in different
   repos are consolidation candidates. Easy to spot on a map, invisible in nine
   READMEs.
10. **Capability audit.** Which agents can write versus read only. `MCP · Odoo`
    already carries a Safe Write guardrail node — make that class of property a
    lens and it becomes a security review artefact.
11. **Coverage gaps.** Five worlds currently have no agents. That is a roadmap,
    rendered.
12. **Timeline.** `since` is reserved. Scrub a date and watch the fleet appear —
    the growth story in one control.
13. **Onboarding.** A new engineer flies the map instead of reading nine repos,
    and every node is a jump-off point into real code.

---

## Layout

```
config.ts                  name, tagline — change the branding in one place
lib/schema.ts              types + validate(); the contract and its enforcement
lib/registry/
  index.ts                 imports every world file, merges, validates
  nucleus.ts               one file per populated world ─┐
  revops.ts                                             ├─ edit these to add agents
  argus.ts                                              │
  mcp-odoo.ts                                           ┘
  unpopulated.ts           real repos with no agents mapped yet
  cross-routes.ts          lanes that cross a world boundary
lib/layout.ts              hashed angles, relaxation, shells, palette
lib/graph.ts               registry → placed bodies, lanes, lenses, search index
components/Starmap.tsx     the three.js scene
components/Inspector.tsx   the detail panel
components/Palette.tsx     ⌘K jump-to-node
```

## Controls

| | |
|---|---|
| Drag | Orbit (the map keeps its own slow rotation) |
| Scroll | Zoom |
| Click a body | Inspect, and launch ships down its lanes |
| `⌘K` / `/` | Find an agent, tool, model or repo |
| `L` | Cycle lens |
| `Esc` | Deselect |

The map rotates continuously and every body breathes on a phase offset. Only the
origin carries a standing label — every other name arrives on hover or
selection, which is what keeps a growing map readable.

Two skins, both deliberately plain: **Deep space** and **Dune**. No
post-processing, no rings, no dust, no film grain.

---

## License

MIT, see [LICENSE](LICENSE).
