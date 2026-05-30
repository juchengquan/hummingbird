# Plan: Agent API as a separate service

Status: **📐 Phased plan** — supersedes the previous decision doc. The
old doc lived as `decision-doc — Step 1 done`; this rewrite turns it
into a button-to-push plan once you confirm the recommendation.

> **Prior status (kept for context).** The plan's precondition — "prove
> the agent loop + durable run state in the current TS backend first"
> — shipped via the long-running-task / HITL / queue stack
> (`_done/PLAN-agent-event-model.md`, `_done/PLAN-agent-hitl-approvals.md`,
> `_done/PLAN-agent-task-queue.md`). The whole agent substrate works
> in-process today. So this plan is no longer about *whether* the
> design is sound — it's about *whether and how* to move it out of
> Next.js.

Companion plans:
- `PLAN-backend-extraction.md` — contract-first groundwork. **Phase 1
  shipped** (apiClient + Zod schemas + `docs/API.md`). That plan
  framed the move as Python-specific; this plan generalises it and
  treats the language as one decision among others.
- `PLAN-replace-supabase-with-postgres.md` — data layer. Orthogonal to
  the agent split — the agent service talks to whatever the data
  layer is.

---

## What we're solving for

Four forces, any one of which is enough to motivate a split:

| Force | What it looks like in practice |
|---|---|
| **A. Python ecosystem** | DSPy, LangGraph, vLLM, custom retrievers, evaluation libraries — the active agent-research surface is overwhelmingly Python-first. Staying in TS means living without it. |
| **B. Independent deploy / scale** | The agent worker is long-running, bursty, idle-on-I/O. The chat UI is short, latency-sensitive, edge-friendly. Right now a frontend deploy restarts the worker; a worker crash shows up as a Next.js error budget. Splitting decouples both. |
| **C. Reduce Vercel / Next coupling** | 60s Hobby / 300s Pro execution caps (worked around via chunking + queue, but the workaround leaks into the code). Cold starts on the agent path. Edge-vs-Node confusion. Vendor lock-in on cron + KV. A long-running container removes all of these at once. |
| **D. Exploration** | You want concrete options to evaluate. No specific pain forces it; the writeup is meant to **make the trade-offs legible** so the eventual go-ahead is informed, not impulsive. |

This plan is structured so any combination of those forces lands on the
same first move.

---

## The 4 options on the table

| Option | What it is | Repo shape | Deploy shape | Languages |
|---|---|---|---|---|
| **A. Stay in-process** | Add isolation inside Next.js (worker threads, child processes, or just better separation). Keep the queue + chunking that already work. | Monorepo, single deploy | Vercel | TS only |
| **B. TS service** | Hono / Nitro / Express in `services/agent-ts/`. Same repo, separate deploy. Imports `lib/shared/` directly — zero contract drift. | Monorepo, two deploys | Vercel (frontend) + container (agent) | TS only |
| **C. Python service** | FastAPI in `services/agent-py/`. Separate deploy + container. Pydantic models mirror Zod via OpenAPI codegen. | Monorepo, two deploys | Vercel (frontend) + container (agent) | TS + Python (polyglot) |
| **D. Hybrid** | Chat turn (`/api/chat`) stays in Next.js as today; only the long-running task worker moves out. Agent loop runs in the new service; the chat panel still calls Next, which proxies to the agent service or runs the turn inline. | Monorepo, two deploys | Vercel (frontend + chat) + container (agent worker) | TS + (TS or Python for the worker) |

### Decision matrix — how each option scores against the four drivers

`+` = clearly addresses, `~` = partial, `–` = does not address, `+!` = uniquely well-suited.

| | A. Stay in-process | B. TS service | C. Python service | D. Hybrid |
|---|---|---|---|---|
| Python ecosystem (A) | – | – | **+!** | + (if worker is Py) |
| Independent deploy / scale (B) | – | + | + | + |
| Reduce Vercel coupling (C) | ~ | + | + | + |
| Time-to-first-value | **+!** (already done) | + (~2-3 wk) | ~ (4-6 wk) | + (~3 wk) |
| Operational complexity | **+!** | ~ (2 services) | – (2 services + 2 languages) | ~ |
| Contract drift risk | **+!** (no boundary) | **+!** (shared types) | – (OpenAPI codegen needed) | depends on worker lang |
| Reversibility | **+!** | + | ~ | + |
| Cost (hosting only) | $0 | +$5-15/mo | +$5-15/mo | +$5-15/mo |
| Future Python ML deps | – | – | **+!** | + (if Py) |

**Where each option wins:**

- **A wins on:** doing nothing. If you don't actually want any of A/B/C, this is the right answer.
- **B wins on:** lowest porting cost + zero contract-drift risk + fast time-to-first-value if you want the operational benefits but not Python.
- **C wins on:** Python ecosystem access. Pays for everything else with extra work — both up-front (port the runner, runner.ts is ~370 LOC of real logic; MCP client, ~500 LOC; tool registry, ~400 LOC) and ongoing (two languages to maintain, contract codegen).
- **D wins on:** keeping the cheap turn-based path simple (it's not the source of the pain) while moving only the part that actually wants a container. Half the porting work. Half the operational complexity.

---

## Recommendation

**Option C (Python service)** if you confirm driver A (Python ecosystem)
is a real ongoing pull, not a one-off curiosity. Otherwise **Option D
(hybrid) with a TS worker.**

The reasoning, given the prompt was "all four drivers":

1. **Driver A (Python ecosystem) is the discriminator.** B/C/D all
   solve drivers B/C/D equivalently well. Only C (and D-with-Python)
   solve A. If A isn't real, you're paying polyglot costs for nothing.
2. **D (hybrid) is the under-rated middle.** Chat turns are 90% of the
   call volume and 10% of the value of splitting. The worker is 10% of
   the call volume and 100% of the value (long-running, scales
   differently, hits the 60s cap). Splitting only the worker captures
   most of the win for half the work.
3. **A (stay in-process) is the honest default for the next 30 days.**
   You have a working agent stack, no users complaining about scale,
   no Python dep you're avoiding. The cost of waiting another month is
   close to zero; the cost of building the wrong thing is 4-6 weeks.

If you say "yes, I want Python and I want it deployed separately and I
want to start now," the rest of this plan walks you through Option C
end-to-end. **If you instead say "let me try Option D first," see
[§What changes for the other options](#what-changes-for-the-other-options)
at the bottom.**

---

## The service boundary (target shape for Option C)

What moves into the Python service vs stays in the Next.js app:

| Stays in Next.js / browser | Moves to the Agent service |
|---|---|
| All React + Zustand + IndexedDB | Model inference (streaming) |
| Browser → data-layer sync (direct) | The agent loop (`runAgentLoop` + `makeStreamTextStep`) |
| Supabase auth UI + callback | Tool execution: webSearch, webFetch, imageGen, searchFiles |
| `/api/share/*` (data-layer concern) | MCP client (discovery + invocation + cloud-cred decryption) |
| `apiClient` (the typed fetch wrapper) | File extraction (pdf/docx/csv/xlsx/html) |
| `/api/auth/callback` (Supabase) | Summarise / compress |
| `/api/ai/*` editor routes (**deferred** — see §6 below) | Durable run state writes (`tasks` / `task_events` / `task_checkpoint`) |
| `/api/tasks` POST as a thin enqueuer | Worker (`processNextJob` loop) |

The seam is **`lib/client/api-client.ts`**. Every backend call already
funnels through it. Flipping `NEXT_PUBLIC_API_BASE_URL` repoints the
whole app at the new service.

The data layer (Supabase Postgres + Storage + Realtime) is **shared**:
both the Next.js app and the Python service connect to the same
project. RLS is the enforcer.

---

## Wire contracts (pinned)

### HTTP — already specified

The external surface is documented in [`docs/API.md`](API.md) +
`lib/shared/api-schemas.ts`. The Python service serves these paths
byte-for-byte. The contract is normative; no respec here. New
deployment-specific additions:

| Concern | Decision |
|---|---|
| Auth | `Authorization: Bearer <jwt>` — verify with Supabase JWT secret. (Cookie auth stays for the Next.js routes that remain.) |
| Health | `GET /healthz` (process up) + `GET /readyz` (deps reachable). For container orchestration. |
| Versioning | `/v1/...` prefix. Frontend pins to v1; service can ship v2 independently. |
| CORS | None — same-origin via Vercel rewrite. (Subdomain option deferred.) |
| Correlation | Accept + emit `X-Request-Id`; thread through structured logs + `task_events.metadata`. |

### Streaming — adopt the AI SDK UI message stream format

A rewrite is the cheap moment to switch off the custom SSE protocol
and adopt the AI SDK UI message stream. The Python service emits the
official format; the chat panel adopts `@ai-sdk/react`'s `useChat()`
on the same flag flip. The benefits:

- One streaming protocol across `/api/chat` and the editor routes.
- Native tool-call / step / reasoning frames.
- Battle-tested clients.

The downside is **the chat panel changes** — the custom SSE consumer
in `lib/client/agent/stream.ts` becomes redundant; the gallery,
tool-call rendering, and abort flow all touch `useChat()` instead. PR
sized at ~1-2 days, deferred to Phase 3.

### Data dependencies

The Python service reads / writes a small Postgres slice directly via
`supabase-py` (or `asyncpg`):

| Operation | Tables | Notes |
|---|---|---|
| Reads message history | `messages` | For run reconstruction. |
| Reads MCP creds | `mcp_servers` | Plus the SECURITY DEFINER decrypt RPC. |
| Reads files | `files`, `file_sections`, Storage | For `searchFiles` skill. |
| Writes run state | `tasks`, `task_events`, `task_checkpoint`, `task_jobs` | Idempotent on `(task_id, seq)`. |
| Writes generated images | Storage bucket `user-files/{userId}/generated/...` | Mints signed URLs same TTL as today. |

**RLS is load-bearing.** Every connection scopes to the caller's
`user_id` via a Supabase session, NOT via a service-role bypass except
for the worker dispatch path (mirrors today's `getSupabaseAdminClient`
in `lib/server/agent/worker.ts`).

### Contract sync (Zod ↔ Pydantic)

The hard part of polyglot. Three approaches; pick one in Phase 0:

| Approach | Pros | Cons |
|---|---|---|
| **OpenAPI emit from FastAPI + codegen to TS** | Single source of truth on the Python side. CI catches drift on PR. | TS types may be uglier than hand-written Zod. |
| **OpenAPI emit from Zod + codegen to Pydantic** | Frontend stays the source. | Less mature tooling (zod-to-openapi works; pydantic generation is awkward). |
| **Fixture round-trip in CI** | Simple. No codegen pipeline. | Catches behaviour drift but not type drift. The two implementations can diverge silently if a field is never exercised by a fixture. |

**Recommendation:** option 1 (FastAPI emits OpenAPI; TS codegen via
`openapi-typescript`). Mature, two-line CI step, well-trodden path.

---

## Phases

Six phases, ~4-6 weeks of focused effort end-to-end. Every phase is
behind a per-user feature flag and reversible by flag flip until
Phase 6.

### Phase 0 — Scaffolding (1-2 days)

**Ships:** a Python service that boots, authenticates, and responds to
`/healthz`. No agent logic, no production traffic.

**Scope:**
- `services/agent-py/` directory in this repo (monorepo for now;
  split to its own repo is Phase 7).
- `Dockerfile` + `pyproject.toml` (uv or poetry).
- FastAPI skeleton with `GET /healthz` + `GET /readyz`.
- Auth middleware: verify Supabase JWT (`PyJWT` + the JWT secret).
- `docker-compose.yml` at repo root for local dev: spins up Next.js +
  the Python service together.
- Deploy target: **Fly.io** (free tier + good SSE + tiny ops surface)
  or Railway. Pick one; document.
- OpenAPI emission already on by default in FastAPI; add `openapi-typescript`
  to the Next.js build to regenerate `lib/shared/api-schemas.generated.ts`
  in CI. Lint fails if it drifts.
- `CLAUDE.md` update: how to run the two services locally.

**Risks:**
- Local dev workflow adds a second process. Mitigation: the compose file.
- JWT secret rotation. Mitigation: env var; document in deploy guide.

**Rollback:** delete the directory. No production traffic yet.

**Verification:** `curl localhost:8000/healthz` returns 200 in dev;
container builds in CI; OpenAPI codegen runs.

### Phase 1 — Read-only queue replica (3-5 days)

**Ships:** the Python service polls `task_jobs` alongside the TS
worker, but **logs only — never executes.** Proves connectivity, RLS,
job-claim semantics.

**Scope:**
- Port `lib/server/agent/jobs.ts:claimNextJob` to Python (atomic
  `UPDATE ... RETURNING` on `task_jobs`).
- Run alongside the TS worker; both poll. The TS worker is canonical
  — its `claimNextJob` wins almost every race because it's already
  the production path. Python claims occasionally; log + release
  (back to `pending`).
- Structured log every claim: `task_id`, `action`, `payload_size`.
- No checkpoint reads. No event writes. No tool execution.

**Why this is the right next step:** the queue is the thinnest
possible end-to-end slice that proves the Python service can do real
work safely. Wrong → release the job, TS retries. Zero blast radius.

**Risks:**
- Dual claim — both workers try to claim the same job. Mitigated by
  Postgres's `FOR UPDATE SKIP LOCKED` in `claimNextJob`.
- Python releases stale job → re-runs. Mitigated by the same idempotency
  guarantees the existing TS path relies on (events keyed on
  `(task_id, seq)`).

**Rollback:** stop polling. No state change.

**Verification:** in production, observe the Python service claiming
~0.5% of jobs (the race rate); the TS worker claims the rest.
`task_jobs` stays clean (no stuck pendings).

### Phase 2 — Python handles one action end-to-end (1 week)

**Ships:** Python handles `start` actions for users on the feature
flag. TS handles `continue` / `respond` and all unflagged users.

**Scope:**
- Port the agent loop: `runAgentLoop` + `makeStreamTextStep` from
  `lib/server/agent/runner.ts` to Python. ~370 LOC of TS → ~500 LOC
  of Python (FastAPI + LiteLLM or direct Anthropic/OpenAI SDKs).
  Step budget + cancellation + idempotent event emission preserved.
- Port the tool registry shape. Port **3 tools**: `webSearch` (Tavily),
  `webFetch`, `searchFiles`. Skip imageGen + MCP for now.
- Port `lib/server/agent/store.ts` (run state writes) and
  `lib/server/agent/checkpoint.ts`.
- Feature flag: `users.metadata.agent_backend = 'python'` flags an
  individual user. Worker checks on claim — if flag is off, releases
  the job for the TS worker.
- `tasks.metadata.handler` records which service executed each run,
  for postmortems.

**Risks:**
- Behaviour drift between TS and Python runners. Mitigation: fixture
  round-trip — record a set of real runs from the TS worker, replay
  inputs through the Python runner, diff the event streams. Land
  the fixture suite in this phase.
- LiteLLM streaming quirks vs Vercel AI SDK. Mitigation: pick one
  flagship model (Claude Sonnet) and pin behaviour for it first;
  generalise once parity is proven.
- Tool authentication. The Tavily / Brave keys move into the Python
  service's env. Document the migration.

**Rollback:** flip flag off for the affected users. Next claim goes to
the TS worker.

**Verification:** a flagged user can launch a task with only the 3
ported tools, watch it stream, see it settle. Event stream matches a
reference TS run within tolerance (token-count, step-count, tool-call
shapes).

### Phase 3 — Tool + MCP parity (2 weeks)

**Ships:** Python handles all task actions for flagged users with the
full tool set, including MCP.

**Scope:**
- Port `imageGen`: Minimax T2I/I2I + the persistence path (download
  → Supabase Storage → signed URL). Mirrors `lib/server/image-storage.ts`.
- Port the MCP client: discovery, invocation, cloud-cred decryption.
  This is the **fiddliest port** — the `MCP_ENCRYPTION_KEY` + the
  SECURITY DEFINER decrypt RPC moves over. ~500 LOC of TS →
  ~700 LOC of Python.
- Port `continue` + `respond` actions (the HITL paths).
- Port `signGeneratedImageUrl` (the small-followups #4 we just landed).
- Port file extraction (`pypdf` / `python-docx` / `openpyxl` / `lxml`).
- Adopt the AI SDK UI message stream format. Frontend chat panel
  switches to `@ai-sdk/react`'s `useChat()` for the streaming
  consumer. Custom SSE consumer in `lib/client/agent/stream.ts`
  becomes redundant for `/api/chat`; keep it for legacy until Phase 5.

**Risks:**
- MCP cred decryption. Wrong → users can't use cloud-mode MCP
  servers. Mitigation: side-by-side test in CI; flag rollout gradual.
- Streaming format switch is user-visible (UI rendering changes).
  Mitigation: ship behind a separate flag; A/B for a week.
- File extraction parity. Different libraries → subtly different
  text. Mitigation: fixture suite from real uploads, diff with
  tolerance.

**Rollback:** revert tool ports one at a time via per-tool flags.

**Verification:** the full feature set works for flagged users. The
parity fixture suite covers 30+ representative runs.

### Phase 4 — Chat turn ports + frontend cutover (1 week)

**Ships:** `/api/chat` is served by Python for flagged users. The
Next.js `/api/chat/route.ts` becomes a thin proxy (or returns 503 if
Python is down).

**Scope:**
- Implement `/api/chat` in Python. Reuses the agent loop from Phase
  2-3, just without the durable-state writes (chat turns are
  ephemeral by design).
- Vercel rewrite: `/api/chat`, `/api/tasks/*`, `/api/extract`,
  `/api/summarize`, `/api/mcp/*`, `/api/url/fetch`, `/api/images/*`
  → Python service. Conditional on the feature flag; flag off →
  Next.js handles.
- `lib/client/api-client.ts` doesn't change (paths are the same).
  Frontend doesn't know it's talking to Python.

**Risks:**
- Vercel rewrite + SSE buffering. Some edge cases buffer; needs
  testing. Mitigation: verify on the deploy target before flagging
  users.
- Cookie auth ↔ JWT bearer. The chat route currently reads the
  Supabase session cookie. The Python service expects a bearer token.
  Mitigation: the rewrite injects the cookie's JWT as a bearer header.

**Rollback:** flip flag off; rewrite stops; Next.js handles.

**Verification:** flagged users have full chat parity. Streaming
matches TS output within tolerance. Browser tab open for an hour
exercising all paths (text, tool calls, attachments, MCP, abort, retry).

### Phase 5 — Default-on, then decommission (1 week)

**Ships:** Python is canonical for all users. TS worker + agent
routes are deleted.

**Scope:**
- Flag flip: default to Python. Monitor for 1 week.
- Drop:
  - `lib/server/agent/runner.ts` + `worker.ts` (~960 LOC)
  - `lib/server/agent/store.ts` + `jobs.ts` + `checkpoint.ts` + `schedules.ts`
  - `lib/server/skills/*` (tool registry)
  - `lib/server/mcp/*` (MCP client)
  - `app/api/chat/route.ts` agent loop (route becomes a 410 Gone or
    is removed entirely)
  - `app/api/tasks/route.ts` worker bootstrap (route stays as the
    queue submitter; no inline `processNextJob` call)
- Keep:
  - `app/api/share/*` (data-layer concern)
  - `app/api/auth/callback` (Supabase magic-link)
  - `app/api/ai/*` editor routes (deferred — see §6)
  - `lib/shared/agent/*` (events, codec — used by both sides)

**Risks:**
- One-way door. Mitigation: 2-week observation window before deleting
  TS code. If anything fails, can re-flag back; the code is in git.
- The cron + queue tick. Vercel's cron currently hits
  `/api/tasks/jobs/tick`. Replace with Python service's own cron
  (Fly's cron or a scheduled task), OR keep the Vercel cron and have
  it call the Python service's tick endpoint.

**Rollback:** revert the deletion commit. The previous flag-flipped
state is fully working.

**Verification:** all users on Python. No TS worker logs for 1 week.

### Phase 6 — Tidy + docs (1-2 days)

**Ships:** the new normal documented; obsolete plans archived.

**Scope:**
- Update `CLAUDE.md` (architecture section, local dev workflow).
- Move this plan to `docs/_done/`.
- Move `PLAN-backend-extraction.md` to `docs/_done/` (Phase 2 is now
  this plan).
- Update `docs/API.md` to note the Python implementation.
- Final cost / latency / token-usage comparison vs the TS baseline
  in the PR description.

---

## Per-phase risks summary

| Phase | Top risk | Mitigation |
|---|---|---|
| 0 | Local dev workflow gets heavier | `docker-compose.yml` + `CLAUDE.md` |
| 1 | Dual job claim race | `FOR UPDATE SKIP LOCKED` |
| 2 | Runner behaviour drift | Fixture round-trip suite |
| 3 | MCP cred decryption | Side-by-side CI tests |
| 3 | Streaming format change is user-visible | Separate flag, A/B test |
| 4 | SSE buffering through Vercel rewrite | Verify on deploy target before users |
| 5 | One-way door on deletion | 2-week observation window |

---

## Rollback at each phase

| Phase | Rollback | Time to revert |
|---|---|---|
| 0 | Delete `services/agent-py/` | Minutes |
| 1 | Stop the Python service polling | Minutes |
| 2 | Flag off the affected users | Seconds |
| 3 | Per-tool flag off | Seconds per tool |
| 4 | Flag off the rewrite | Seconds |
| 5 | Revert the deletion commit + re-enable cron | ~1 hour |

Phases 0-4 are all flag-flip reversible. Phase 5 is the only one-way
door, and only after a 2-week parity observation.

---

## Cost

**Hosting (incremental):**
- Fly.io: ~$5/mo for a 256MB shared-CPU machine (free tier covers
  Phase 0-1).
- Railway: ~$5/mo on the Hobby plan.
- Modal: $30 free credits/mo (GPU-friendly if you later run local
  inference).

**Engineering:**
- 4-6 weeks of focused effort end-to-end.
- Ongoing: ~10% overhead from maintaining two languages (porting bug
  fixes both ways; updating two sets of dependencies).

**Anti-cost:**
- Frees up the Vercel function-execution budget you currently spend
  on the worker bootstrap.

---

## What changes for the other options

### If you pick **Option A (stay in-process)**

- Stop here. The phases above don't apply.
- Optional: an *internal* refactor extracting `lib/server/agent/runner.ts`
  + `worker.ts` + `store.ts` behind a `LocalAgentDriver` interface so
  if you later change your mind, the seam exists. 1-2 days.

### If you pick **Option B (TS service)**

- Phases 0, 1, 2, 4, 5 collapse dramatically:
  - Phase 0 (scaffolding): same, but Hono / Nitro in `services/agent-ts/`.
    No OpenAPI codegen — direct `lib/shared/` import.
  - Phase 1 (read-only replica): same.
  - Phase 2 (one action): a *move* of `runAgentLoop` to the new service,
    not a port. ~1 day instead of 1 week.
  - Phase 3 (parity): trivial — the tool registry + MCP client already
    work; they just import from `lib/server/*` in the new repo.
  - Phase 4 (chat turn): same shape; faster.
  - Phase 5 (cutover): same.
- Estimated total: **2-3 weeks** instead of 4-6.
- You don't get Python ecosystem access.

### If you pick **Option D (hybrid)**

- Phases 0-3 apply only to the **task worker**, not `/api/chat`.
- Skip Phase 4 (chat turn stays in Next.js).
- Phase 5 deletes only `lib/server/agent/worker.ts` + the task
  routes' worker bootstrap, not the chat route or `runner.ts`.
- Estimated total: **3-4 weeks**.
- Get most of drivers B+C; partial driver A (worker can be Python).
- Trade-off: now you have **two agent loops** to maintain — the
  Next.js chat-turn loop and the Python long-running loop. Drift
  risk is real.

---

## Decisions still to make before Phase 0

1. **Deploy target** — Fly.io / Railway / Render / Modal / self-host
   on Hetzner. Recommendation: **Fly.io** (free tier for Phase 0-1,
   then ~$5/mo; good SSE support; clean ops).
2. **Python framework** — FastAPI (recommended; mature, OpenAPI
   built-in) vs Litestar (newer, similar shape).
3. **Provider SDK** — LiteLLM (one interface, many providers; less
   provider-specific) vs direct `anthropic` / `openai` SDKs (more
   control, better streaming). Recommendation: **direct SDKs** for
   Phase 2-3 (parity matters); revisit if it becomes a pain.
4. **Contract sync** — OpenAPI codegen direction (recommended:
   FastAPI emits, TS consumes).
5. **Same-origin vs subdomain** — recommended: same-origin via Vercel
   rewrite (no CORS, no cookie domain pain).
6. **Editor AI routes (`/api/ai/command`, `/api/ai/copilot`)** — port
   or keep in Next.js? Recommendation: **keep in Next.js** for at
   least Phase 1-3. They're tightly Plate-coupled and rarely the
   bottleneck. Re-evaluate after Phase 5.

---

## How to start (once decided)

If you green-light Option C:

1. Open a `services/agent-py/` directory.
2. Add a Dockerfile + `pyproject.toml`.
3. Scaffold FastAPI with `GET /healthz` + JWT middleware.
4. Add the OpenAPI codegen step to CI.
5. Stand up the Fly.io app + deploy the empty service.
6. Open a tracking PR titled "agent-py Phase 0 — scaffolding".

That's Phase 0. Phase 1 starts the moment scaffolding lands.
