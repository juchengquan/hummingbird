# Plan: agent-ts follow-ups

Status: **planning** — five independent PRs that fall out of
[`PLAN-agent-ts.md`](./PLAN-agent-ts.md). Each one stands alone;
pick by leverage on a given day. None of them block landing
agent-ts Phases 0–4 ([#142](https://github.com/juchengquan/hummingbird/pull/142)),
which already documents these in the "Follow-ups (recorded during
implementation)" section — this file lifts them out so they're
trackable as standalone work.

Each item has its own **Why**, **Approach**, **Verification**, and
**Out of scope** so you can implement one in isolation without
re-reading the rest.

---

## 1. Port `store.ts` + `checkpoint.ts` to the `postgres` driver — ⏸ **moot once #4's gate flips**

**Status update.** Follow-up #4's `INLINE_AGENT_WORKER` gate
([PR #145](https://github.com/juchengquan/hummingbird/pull/145))
turns this into a no-op for any deploy that runs agent-py or
agent-ts. Once the in-Next worker is off, nothing inside the
Next.js process needs `FOR UPDATE SKIP LOCKED` semantics — the
dedicated services already use their own `postgres`-driver paths
(see `services/agent-ts/src/jobs.ts` and `services/agent-py/src/
agent_py/jobs.py`). Keep this section as the rationale for why we
*don't* need to port the in-Next module, and the trigger for
deletion: when the gate's default flips to `false`,
`lib/server/agent/{worker,jobs,store,checkpoint}.ts` can be
deleted wholesale in the same PR.

**Original rationale (kept for context).** Phase 1 of agent-ts
established that `lib/server/agent/jobs.ts` can't be reused as-is
— the Supabase JS client talks to PostgREST, which can't open a
real transaction, so `FOR UPDATE SKIP LOCKED` loses its lock
guarantee and two workers could claim the same job. That phase
ported `jobs.ts` to the `postgres` driver (`services/agent-ts/
src/jobs.ts`) and Phase 2 did the same for the store reads/writes
the executor needs (`services/agent-ts/src/store.ts`). The other
side of the `lib/server/agent/` line — checkpoint reads, schedule
reads, arbitrary store helpers the Next.js worker uses — is still
on the Supabase JS / PostgREST path and would inherit the same
lock-loss risk if a second worker were pointed at it.

Today this is bounded because only the in-Next-process worker uses
those modules. As soon as we add a second TS runtime that re-uses
the same code paths, the lock issue resurfaces.

**Approach.**

- Audit `lib/server/agent/store.ts`, `checkpoint.ts`, `schedules.ts`
  for any write that depends on transactional semantics (claims,
  optimistic updates, settle-once writes).
- For each, decide: stay on Supabase JS (safe because no transaction
  needed) vs. port to a thin `postgres`-driver helper alongside the
  existing function.
- The port lives in `lib/server/agent/postgres/<name>.ts` (new
  folder) and `services/agent-ts/src/store.ts` switches from its
  local copy to importing from there. Same for `checkpoint`.
- agent-py keeps its own asyncpg copy — three runtimes, three
  drivers, same SQL.

**Verification.**

- Existing tests still pass on the Next.js side.
- agent-ts tests still pass — the routes that exercise the store
  (Phase 2 executor) still claim → settle → release correctly.
- A simple stress test (10 workers, 100 jobs, one shared row gets
  claimed exactly once) — run locally against a Supabase Docker
  instance.

**Out of scope.**

- agent-py changes. Python already uses asyncpg correctly.
- Migrating the in-Next-process worker off the in-Next path
  (separate question about whether the Next worker should keep
  existing at all — see PLAN-agent-api.md Phase 5 discussion).

---

## 2. Land tools-in-chat on agent-ts via `streamText({ tools })`

**Why.** Phase 3 of agent-ts shipped text-only chat. Agent-py's
Phase 4-3 added tool-enabled chat by hand-rolling the loop
(`messages.stream` → walk content blocks for `tool_use` → execute
→ append `tool_result` → restart). For agent-ts the better path is
to use the AI SDK's `streamText({ tools })` directly: the SDK
already runs the loop, streams partial JSON tool inputs, and
emits `tool-input-*` / `tool-output-*` parts in the UI message
stream. We don't have to write the loop machinery from scratch.

**Approach.**

- Take the existing `services/agent-ts/src/chat.ts` and extend
  `ChatConfig` with an optional `tools` array.
- When `tools` is non-empty, call `streamText({ model, messages,
  tools, system })` instead of the text-only variant.
- For the custom-format SSE path, add two more `fullStream` cases
  (`tool-input-start` / `tool-output-available`) that map onto
  agent-py's `tool_call` / `tool_result` frames byte-for-byte so
  the existing `use-chat-send.ts` consumer keeps working.
- For the AI SDK v5 format, the SDK emits the tool parts natively
  — no extra work.
- Tool registry: reuse `lib/server/skills/registry.ts` (already
  exports AI SDK `tool()` shapes). Same context-free vs.
  context-bound split as agent-py — `webFetch` runs without
  context; `searchFiles` + MCP need the workspace id threaded
  through the request body.

**Approach (workspace-context plumbing).**

- Add `workspaceId: string` to the agent-ts `/v1/chat` request body
  (matches agent-py's Phase 4-3 shape).
- Build a per-request `ToolContext` ({ pool, userId, workspaceId })
  and instantiate the registry with it inside the route handler.
- MCP tools come from the agent-ts MCP credential decrypt path
  (already shipped — `services/agent-ts/src/mcp.ts`).

**Verification.**

- Hit `/v1/chat` with `enable_tools: true` from the Next.js
  frontend (Phase 4-2 selector pointing at agent-ts) — `webFetch`
  / `webSearch` / `searchFiles` / `generateImage` all work
  end-to-end and look identical to the agent-py path.
- Wire-shape diff against agent-py — `tool_call` / `tool_result`
  frame keys + types match exactly.

**Out of scope.**

- Image generation tool wiring on agent-ts (Minimax client port).
  That's its own PR — small but has env-var plumbing
  (`MINIMAX_CN_API_KEY` + image endpoint derivation).
- The Phase 5 frontend selector growing a third entry — separate
  PR even though related.

---

## 3. Lift extraction logic into `lib/server/extraction.ts` — ✅ shipped

**Why.** Agent-ts Phase 4 shipped `services/agent-ts/src/extraction.ts`
as a ~150 LOC copy of `app/api/extract/route.ts`'s body, with the
same NPM packages (`pdf-parse`, `mammoth`, `xlsx`, `node-html-parser`)
and the same per-format budgets. The duplication was the smallest
delta that kept Phase 4 commitable; lifting to a shared library
would have needed both producers refactored in the same PR.

The Next.js route's `NextResponse`-shaped error returns don't map
1-to-1 to a library return type without a real touch, which is why
this is its own PR.

**Approach.**

- New file: `lib/server/extraction.ts`. Pure function:
  `extractFile({ name, mimeType, data }): Promise<ExtractionResult>`.
- Lift the body of `app/api/extract/route.ts` into it. Same
  constants, same dynamic imports, same kind taxonomy.
- `app/api/extract/route.ts` becomes a thin glue layer: parse
  multipart, call `extractFile`, map result → `NextResponse`.
- `services/agent-ts/src/routes/extract.ts` switches from
  `import { extractFile } from "../extraction"` to
  `import { extractFile } from "@/server/extraction"`.
- Delete `services/agent-ts/src/extraction.ts` and
  `services/agent-ts/tests/extract.test.ts`'s direct-import
  tests (the wire-shape tests stay).

**Verification.**

- `bun run test` from root still passes.
- `bun run typecheck` clean.
- `bun run build` succeeds.
- Manual: `curl -F file=@sample.pdf http://localhost:3000/api/extract`
  and `curl -F file=@sample.pdf http://localhost:8001/v1/extract`
  return byte-identical JSON.

**Out of scope.**

- Adding new extraction formats (e.g. EPUB, RTF). That's a
  feature, not a refactor.
- Changing per-format budgets. Same constants.
- agent-py changes — Python keeps its own extractor port.

---

## 4. Decide what to do with `lib/server/agent/jobs.ts` + the Next worker — 🟡 **soft retirement landed**

**Status update.** The `INLINE_AGENT_WORKER` env flag
([PR #145](https://github.com/juchengquan/hummingbird/pull/145))
implements the recommendation below in a non-destructive way.
Default `true` preserves the current behaviour; deploys running
agent-py or agent-ts can set it to `false` and the in-Next worker
goes dormant — `processNextJob` bootstrap calls and the
`/api/tasks/jobs/tick` cron both no-op. A future PR flips the
default to `false` and deletes `worker.ts` / `jobs.ts`'s claim
helpers / `store.ts`'s checkpoint-loader once it's clear nothing
relies on the in-Next worker.



**Why.** Today there are three places that could claim jobs from
`task_jobs`: agent-py (asyncpg, correct), agent-ts (`postgres`,
correct), and the in-Next-process worker (`lib/server/agent/jobs.ts`
via Supabase JS, **incorrect** — `FOR UPDATE SKIP LOCKED` loses
its lock guarantee through PostgREST). Today this is benign
because only one Next.js process runs at a time, but it's a
loaded gun.

This is partly a code question (port `jobs.ts` to `postgres`
driver?) and partly an architecture question (should the in-Next
worker exist at all once agent-py + agent-ts are both deployed?).

**Approach.**

This one needs a decision before code. Two options:

1. **Keep the Next.js inline worker.** Port `lib/server/agent/jobs.ts`
   to the `postgres` driver alongside the existing Supabase-JS
   one. The Next.js side gains a new direct-Postgres dep
   (`postgres`) — small bundle hit since it's server-only.

2. **Retire the Next.js inline worker.** Once agent-py and agent-ts
   both ship, the inline worker is redundant. Drop the polling
   loop from the Next.js process and let the dedicated services
   own job execution. `jobs.ts` stays as-is for any one-shot
   reads but no longer claims rows.

Recommendation: **option 2**. The Next.js process should not be
in the business of running an agent loop — it should serve the
UI, route requests to whichever agent backend the user picked,
and that's it. Phase 4-2 selector already supports this; only
the Next.js inline path is the holdout.

**Verification.**

- After dropping the inline worker, claims still work end-to-end:
  user clicks "Run as task", the row lands in `task_jobs`, agent-py
  or agent-ts claims it within `POLL_INTERVAL_SECONDS`, settles
  it, frontend reflects the result.
- `task_jobs` doesn't accumulate uncl​aimed rows in the
  Next.js-only deploy mode (= drop the inline worker only when
  one of the services is also deployed).

**Out of scope.**

- The Phase 5 frontend selector. That's its own PR.
- Cross-service handoff (a job partially handled by one stack
  finishing on another). Single owner per job stays the contract.

---

## 5. agent-ts: image generation tool + Minimax client port

**Why.** Item 2 above gets tools-in-chat working on agent-ts but
explicitly excludes `generateImage` because it has env-var
plumbing of its own. agent-py shipped this in Phase 3d-1 + 3d-2
(Minimax T2I/I2I + Supabase Storage mirror); the TS frontend
already has `lib/server/skills/minimax-image-client.ts`. agent-ts
needs to reuse that client (same `--conditions=react-server`
trick as the other lib/server reuses) and the Storage upload
path from `lib/server/image-storage.ts`.

**Approach.**

- agent-ts imports `@/server/skills/minimax-image-client` (no
  refactor needed — already a library) and
  `@/server/image-storage` for the Storage mirror.
- The `generateImage` tool descriptor in the registry stays the
  same shape on both stacks.
- Env vars (`MINIMAX_CN_API_KEY`, `MINIMAX_CN_BASE_URL`) already
  in `services/agent-ts/src/env.ts` — wired in Phase 0.
- Add `SUPABASE_SERVICE_ROLE_KEY` use to the Storage mirror path
  (already present in env, used by Phase 4 `/v1/images/refresh-url`).

**Verification.**

- A chat turn with "draw me a cat" via agent-ts produces a
  generated image; the URL points at the Supabase Storage
  signed-URL path; refresh works via
  `/v1/images/refresh-url`.
- Byte-for-byte parity with agent-py's generated image stream
  frames.

**Out of scope.**

- Other image providers. Minimax only for now.
- Image-to-image flows beyond what agent-py already supports.

---

## Sequencing

These are independent but item **2** ("tools-in-chat") is the
biggest user-visible win and the one most worth doing first. **5**
naturally follows **2**. **3** is a pure refactor — safe to land
any time. **1** and **4** are related (both are about who owns the
queue contract) — easier to do them together.

Suggested order: **2 → 5 → 3 → (4 + 1 together)**.
