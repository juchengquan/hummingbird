# Plan: A2A (Agent2Agent) interoperability

Status: **planning.** Promoted from [MASTER_PLAN § Later](MASTER_PLAN.md)
(second research round, 2026-06-09) to **Next**. Scope: **L** (a phased
PR series; partly gated on the multi-tenant/publishing story). Origin:
the A2A protocol — v1.0 early 2026, 150+ orgs in production, donated to
the Linux Foundation alongside MCP — see [Sources](#sources).

## Why

MCP and A2A are complements, not competitors: **MCP** connects an agent
to *tools* (Hummingbird already has this — `lib/server/mcp/`); **A2A**
connects an agent to *other agents*. With Hummingbird's personas
(`agents` slice) plus the new
[subagent-orchestration](PLAN-subagent-orchestration.md) plan, the agent
loop already knows how to delegate to a *local* persona. A2A extends the
same idea over a **standard wire protocol** so:

- a Hummingbird persona can be **published** as an A2A "agent card" that
  external orchestrators (and other Hummingbird instances) can discover
  and call; and
- a Hummingbird orchestrator persona can **delegate to a remote A2A
  agent** the way subagent-orchestration delegates to a local child.

The mapping is unusually clean because Hummingbird's task system already
has the right shape: A2A's task lifecycle
(`submitted → working → input-required → completed/failed`) maps almost
1:1 onto the existing `RunStatus`
(`queued → running → paused → done/failed`), and A2A's `input-required`
is exactly the HITL suspend (`askUser` / approval). The durable
executor + `RunStore` (idempotent on `(task_id, seq)`) already provides
the resumable, streamable task semantics A2A expects.

## Non-goals — what this is NOT

- **Not a full multi-protocol stack.** A2A only. ACP / UCP (commerce
  protocols) are out of scope.
- **Not an agent registry / marketplace.** v1 discovers a remote agent
  by its card URL (pasted/configured). A central directory needs the
  multi-tenant story first.
- **Not peer-to-peer autonomous swarms.** Same guardrail as
  subagent-orchestration: a one-level orchestrator → remote-worker
  relationship with a depth cap. No symmetric agent↔agent loops.
- **Not a new agent runtime.** Inbound A2A tasks run on the *existing*
  executor / runner / RunStore. Outbound delegation is one new tool.

## Decisions to pin before code

1. **Which backend hosts the A2A surface.** `services/agent-py` —
   Python has the most mature A2A SDK, it already owns the JWT-auth +
   executor + RunStore plumbing, and `services/agent-ts` can mirror
   later (the codebase keeps them in lockstep). **Default: agent-py
   first, agent-ts mirror as a follow-up.**
2. **Publishing model.** A persona is **not** A2A-exposed by default.
   An explicit per-persona "Publish as A2A agent" action mints a card
   at `/.well-known/agent-card.json?agent=<slug>` (or a per-agent path)
   gated by an auth scheme. Publishing is a public surface → it's the
   piece gated on the multi-tenant story; until then, publishing is
   single-tenant + bearer-token-gated.
3. **Auth.** Reuse the existing Bearer-JWT posture (`SUPABASE_JWT_
   SECRET`) for the A2A server; the card declares
   `securitySchemes: { bearer }`. Outbound delegation carries a
   configured credential per remote agent. **No new auth model.**
4. **SSRF on outbound.** Delegating to a remote agent is an outbound
   fetch → route it through the **existing SSRF guard** the MCP proxy +
   `url/fetch` already use (block loopback/private hosts unless
   explicitly allowed). Non-negotiable.
5. **Task lifecycle mapping.** Inbound A2A `message/send` → create a
   task row + `enqueueStartJob` → the executor runs it; A2A
   `tasks/get` + streaming map onto the `RunStore` event tail;
   `input-required` ↔ the HITL suspend; `completed/failed` ↔
   `result`. The mapping table lives in the plan + a conformance test.
6. **Depth cap.** A delegated remote agent may not itself delegate back
   into this instance within the same task tree (cycle guard via a
   task-tree origin tag). Breadth/depth caps mirror subagent
   orchestration.

## Shape — code surface

### Inbound — Hummingbird persona as an A2A agent (agent-py)

New router `services/agent-py/src/agent_py/routers/a2a.py`:

- `GET /.well-known/agent-card.json` (+ per-agent variant) — builds the
  card from a published persona: `name`, `description`, `skills`
  (from `allowedSkillIds`), `securitySchemes`, the task endpoint URL.
- `POST /a2a/tasks` (`message/send`) — validates the inbound A2A
  message, resolves the target persona, creates a `tasks` row with the
  persona's model + `systemPrompt` + skill/MCP scope, `enqueueStartJob`,
  returns the A2A task object (`submitted`).
- `GET /a2a/tasks/{id}` + `GET /a2a/tasks/{id}/stream` (SSE) — projects
  `RunStore` events onto A2A status/artifact updates via a pure mapper
  `lib/shared/agent/a2a-map.ts` (event kind → A2A update).

Reuses `execute_start`, `RunStore`, `RunEmitter`, `run_agent_loop`
unchanged — the A2A router is a *protocol adapter* in front of the
existing executor, not a second runtime.

### Outbound — delegate to a remote A2A agent

`lib/server/agent/a2a-client-tool.ts` (+ the agent-py twin) —
`makeA2aDelegateTool(ctx)`:

```ts
tool({
  description: "Delegate a subtask to a remote A2A agent by its card URL.",
  inputSchema: z.object({ agentCardUrl: z.string().url(), subgoal: z.string() }),
  async execute({ agentCardUrl, subgoal }, { abortSignal }) {
    assertNotSsrf(agentCardUrl)                       // existing guard
    const card = await fetchAgentCard(agentCardUrl)   // /.well-known/agent-card.json
    const task = await a2aSend(card, subgoal, cred)   // message/send
    return await a2aPoll(card, task.id, { signal: abortSignal }) // tasks/get until terminal
  },
})
```

Slots beside `makeSpawnSubagentTool` — local delegation (subagent
plan) and remote delegation (this) are siblings the orchestrator
chooses between.

### Shared — the lifecycle mapper + card types

`lib/shared/agent/a2a.ts` — `A2aTaskState`, `A2aAgentCard` types +
`mapRunEventToA2a(event)` / `mapA2aStateToRunStatus(state)` pure
functions. The single source of truth for the protocol mapping, shared
by inbound + outbound + tests.

### Client — publish toggle

The persona manage dialog (`/personas`) gains a "Publish as A2A agent"
toggle + a copy-card-URL action, mirroring the existing share-by-URL
affordance. A published persona's card URL is shown read-only.

## Sequencing — PR series

1. **PR 1 — shared mapper + outbound delegate tool.** `a2a.ts` types +
   mapper (pure, tested); `makeA2aDelegateTool` with the SSRF guard +
   card fetch + `message/send` + poll-to-terminal. Lets a Hummingbird
   orchestrator call *external* A2A agents first (lower risk — no public
   surface). Both backends.
2. **PR 2 — inbound A2A server (agent-py).** The `a2a.py` router: card
   endpoint, `message/send` → executor, `tasks/get` + SSE stream.
   Bearer-gated, single-tenant. Conformance test against the A2A spec's
   reference client.
3. **PR 3 — publish UX + streaming parity.** The persona publish
   toggle; map `input-required` ↔ HITL so a remote caller can answer an
   `askUser`; agent-ts mirror of the inbound server.
4. **PR 4 (gated) — discovery + multi-tenant.** A small directory of
   known agent cards; per-tenant publishing. Blocked on the
   multi-tenant story.

## Tests

- **Lifecycle mapper (PR 1)** — every `RunStore` event kind maps to a
  defined A2A update; every A2A state maps to a `RunStatus`; round-trip
  invariants. Pure, ~10 cases.
- **Outbound tool (PR 1)** — SSRF rejection on loopback/private card
  URLs; happy-path `send` + poll → `tool_output`; remote failure →
  labelled failure (not a parent crash). Mirrors the subagent
  aggregation tests.
- **Inbound conformance (PR 2)** — the A2A reference client can
  discover the card, send a task, stream updates to completion; an
  `input-required` round-trips through `respond`.
- **Manual smoke (PR checklist)** — delegate from a Hummingbird
  orchestrator to a public reference A2A agent and back; publish a
  persona and call it from the reference client.

## Open questions before PR 1

1. **A2A SDK vs hand-rolled.** The official Python A2A SDK pulls a
   dependency tree; the protocol is small JSON-RPC-over-HTTP.
   **Default: use the official SDK in agent-py for inbound conformance;
   the outbound client is small enough to hand-roll behind the SSRF
   guard.**
2. **Streaming transport.** A2A supports SSE + (emerging) push.
   **Default: SSE only (matches Hummingbird's existing streaming);
   push deferred.**
3. **Credential storage for outbound.** **Default: reuse the cloud-mode
   MCP credential vault (encrypted, `MCP_ENCRYPTION_KEY`) for remote
   agent credentials — same shape, same RLS.**

## Reopen / future work

- **agent-ts inbound parity** (started in PR 3, completed later).
- **Agent directory / discovery** — gated on multi-tenant.
- **ACP / UCP** (commerce) — only if a transactional use case appears.
- **Beam/subagent convergence** — local subagent, remote A2A delegate,
  and Beam fan-out are three flavours of the same "delegate + gather"
  primitive; unify the orchestrator UX once all three exist.

## Sources

- [Agent protocol ecosystem map 2026 (MCP / A2A / ACP / UCP)](https://www.digitalapplied.com/blog/ai-agent-protocol-ecosystem-map-2026-mcp-a2a-acp-ucp)
- [Interoperability protocols — path to convergence (2026)](https://zylos.ai/research/2026-03-26-agent-interoperability-protocols-mcp-a2a-acp-convergence/)
- [MCP vs A2A — multi-agent collaboration (2026)](https://onereach.ai/blog/guide-choosing-mcp-vs-a2a-protocols/)
