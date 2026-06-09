# Plan: Visual workflow / flow builder on the canvas

Status: **planning.** Promoted from [MASTER_PLAN § Later](MASTER_PLAN.md)
(fourth research round, 2026-06-09) to **Next**. Scope: **L** (a phased
PR series; builds on subagent orchestration). Origin: Langflow / Flowise
/ OpenAI Agent Builder — see [Sources](#sources).

## Why

Langflow, Flowise, and OpenAI's (now-deprecating) Agent Builder made the
drag-drop node graph the standard way to compose agent workflows.
Hummingbird already owns every ingredient: a **react-flow workspace
canvas** (`lib/shared/canvas/` + `components/canvas/`), a **skill
registry**, **personas**, the **task executor** (+ planned
[subagent orchestration](PLAN-subagent-orchestration.md)). So a flow
builder is *composition of surfaces it already has*: drop skills/personas
onto the canvas, wire typed edges, save a reusable workflow that lowers
onto the executor.

## Non-goals — what this is NOT

- **Not a general automation platform** (n8n/Make). Scoped to *AI
  workflows* — chaining Hummingbird's skills, personas, and agent steps,
  not arbitrary SaaS connectors (those arrive via MCP).
- **Not a replacement for chat.** Workflows are a *power-user* authoring
  surface for repeatable multi-step jobs; chat stays the default.
- **Not a new execution engine.** Workflows compile down to the existing
  task executor / RunStore — a workflow run *is* a task (or a subagent
  tree).
- **Not the spatial canvas as-is.** The existing canvas is a *spatial
  view* of artifacts/conversations; this adds a distinct **workflow
  mode** with executable nodes + typed edges.

## Decisions to pin before code

1. **Reuse react-flow, new node/edge semantics.** The canvas already
   uses react-flow with node kinds (`artifact`, `conversation`,
   `sticky`, …). Add a **workflow** canvas mode with *executable* node
   kinds (`input`, `skill`, `persona`, `branch`, `output`) and **typed
   edges** (an edge carries the output schema of its source into the
   target's input).
2. **Compile, don't interpret in the client.** A workflow graph
   compiles to an executor plan: each node → a step (or a subagent for a
   persona node); branches → conditional steps. The compiler is pure
   and server-validated; execution reuses the task queue.
3. **Typed I/O.** Each node declares an input/output schema (Zod);
   edges only connect compatible ports. This is the reliability backbone
   (and pairs with structured outputs).
4. **Persistence.** A workflow is a stored graph
   (`workflows` table + a slice), workspace-scoped, shareable by URL
   like personas. A run of a workflow is a task with a `workflow` origin.
5. **Scope v1.** Linear + simple branch graphs (no loops in v1 — loops
   need the same guard story as subagents). Skill nodes + persona nodes +
   input/output. Loops/maps later.

## Shape — code surface

### Shared — graph model + compiler

- `lib/shared/workflow/types.ts` — `WorkflowGraph`
  (`nodes: WorkflowNode[]`, `edges: TypedEdge[]`), node kinds + per-kind
  I/O schema.
- `lib/shared/workflow/compile.ts` — pure
  `compileWorkflow(graph): ExecutorPlan | CompileError[]` (topological
  order, type-check edges, lower to steps/subagents). Heavily tested.

### Client — workflow canvas mode

- `components/canvas/` gains workflow node renderers + a node palette
  (skills / personas / input / branch / output) + edge type-checking on
  connect. Reuses the existing react-flow surface + `placement.ts`.
- A `workflows` store slice (`lib/client/hooks/store/slices/workflows.ts`)
  modelled on `agents` (CRUD, workspace-scoped, soft-delete, share-by-
  URL via a `lib/shared/workflow/share.ts` mirroring `agents/share.ts`).

### Server — run a workflow

- `POST /api/workflows/:id/run` — compile the graph → enqueue a task
  whose checkpoint carries the `ExecutorPlan`; the executor walks the
  plan (skill steps + subagent spawns) via the existing runner. Reuses
  RunStore + the Tasks UI for live progress.
- Migration `0026_workflows.sql` — the `workflows` table + RLS (copy
  the `agents`/`task_schedules` shape).

## Sequencing — PR series

1. **PR 1 — graph model + compiler (pure, no UI).** Types + the
   topological compiler + type-checking + tests. The reliability core,
   provable in isolation.
2. **PR 2 — workflow canvas mode + slice + persistence.** Node palette,
   typed-edge connect, the `workflows` slice + migration + sync +
   share-by-URL. Authoring only (no run yet).
3. **PR 3 — execution.** `POST /api/workflows/:id/run` → compile →
   executor; lower skill nodes to steps + persona nodes to subagents
   (needs the subagent plan's join barrier); live progress in the Tasks
   UI.
4. **PR 4 (future) — loops/maps + templates.** Bounded loops (subagent-
   style guards), a starter template gallery.

## Tests

- **Compiler (PR 1)** — valid linear + branch graphs compile to the
  right plan; incompatible edges → type error; a cycle → rejected (v1
  has no loops). ~10 cases, pure.
- **Share codec (PR 2)** — workflow encode/decode round-trip + tamper →
  null (mirror agents share tests).
- **Execution (PR 3)** — a 3-node workflow (input → skill → persona)
  runs end-to-end on the executor; a branch routes correctly; a node
  failure surfaces without crashing the run.
- **Manual smoke** — build "summarise each uploaded file then draft an
  email" visually, run it, watch progress in Tasks.

## Open questions before PR 1

1. **Depends on subagent orchestration.** Persona nodes lower to
   subagents → the join barrier from
   [subagent orchestration](PLAN-subagent-orchestration.md) is a
   dependency. **Default: sequence this after subagents land; PR 1+2
   (model + authoring) can proceed in parallel, PR 3 (run) waits.**
2. **How much branching in v1.** **Default: single-level conditional
   branch (a `branch` node with a predicate); no nested loops.**
3. **Relationship to the spatial canvas.** Same react-flow surface, two
   modes, or a separate canvas? **Default: a distinct "workflow" mode on
   the same surface; never mix executable + spatial nodes in one graph.**

## Reopen / future work

- **Loops / map-over-collection** (PR 4) — with subagent-style fan-out
  caps.
- **Template gallery** — shareable starter workflows (pairs with
  portable skills + persona sharing).
- **Triggered workflows** — an ambient-agent
  ([plan](PLAN-ambient-agents.md)) trigger launches a workflow, not just
  a single persona.

## Sources

- [Langflow — no-code AI workflow builder](https://medium.com/@mridulv204/langflow-no-code-ai-workflow-builder-3b0fd8b0a977)
- [Best no-code AI agent builders 2026](https://metaflow.life/blog/best-no-code-ai-agent-builders)
- [Flowise tutorial 2026](https://agence-scroll.com/en/blog/flowise-the-tool-to-create-ai-agents-without-coding)
