# Subagent orchestration PR-1 — schema + join barrier (agent-py) design

Status: **approved design**, ready for implementation plan.
Date: 2026-06-20. Parent plan:
[`docs/PLAN-subagent-orchestration.md`](../../PLAN-subagent-orchestration.md)
(this is the re-scoped PR-1 of that series).

## Background — re-scope to agent-py only

The parent plan's PR-1 is "schema + barrier, mirrored byte-for-byte in
**both** services." Investigation found that premise doesn't hold today:

- **`services/agent-ts/src/jobs.ts` is drifted from the DB schema.** Its
  SQL targets `status='claimed'`, `claimed_at`, `claimed_by`, `attempt`,
  `last_error` — none of which exist in `0014_task_jobs.sql` (status
  `('queued','running','done','failed')`; columns `attempts`,
  `started_at`, `error`). The agent-py side matches `0014`.
- **agent-ts doesn't execute jobs yet** — its poller is Phase-1 dry-run
  (claim → release), and `CLAUDE.md` notes it "stays stubbed until its
  real-step phase."

So PR-1 lands the barrier in **agent-py only** (schema-correct, actually
executes jobs). The agent-ts mirror waits for its real-step phase, and
the agent-ts schema drift is recorded as a separate finding — **not**
fixed here.

## Goal

Add the durable join-barrier plumbing so an orchestrator task can have
child tasks and be re-enqueued exactly once, when its last child settles.
**No spawn tool / model wiring** (that's PR-2) — PR-1 proves the barrier
in isolation with synthetic child task rows.

## 1. Migration `0028_subagents.sql` + `types.ts`

```sql
alter table public.tasks
  add column parent_task_id uuid references public.tasks(id) on delete cascade,
  add column pending_children int not null default 0;

create index if not exists tasks_parent_task_id_idx
  on public.tasks (parent_task_id);
```

- `parent_task_id` NULL = top-level task. `on delete cascade` so deleting
  an orchestrator removes its child rows (children have no meaning without
  the parent).
- `pending_children` is the barrier counter on the parent (0 for leaves).
- The index supports the completion sweep / child lookups.

This **changes codegen**, so `lib/shared/supabase/types.ts` must be
updated in the same PR (the `verify-supabase-types` CI guard requires it;
**no** `-- verify-supabase-types: skip` marker). Add to the `tasks` table
types:
- `Row`: `parent_task_id: string | null`, `pending_children: number`
- `Insert`: `parent_task_id?: string | null`, `pending_children?: number`
- `Update`: `parent_task_id?: string | null`, `pending_children?: number`

(Keep the existing self-referential relationship list consistent if the
generated shape lists FK relationships; mirror the existing style.)

## 2. The barrier — `services/agent-py/src/agent_py/barrier.py`

One function, race-free and idempotent. It follows the existing `jobs.py`
conventions (takes `pool: asyncpg.Pool`, `_coerce_uuid` for ids), but
does its work inside a single transaction.

```python
@dataclass(frozen=True)
class SettleResult:
    transitioned: bool          # True iff this call moved the task to terminal
    parent_task_id: str | None  # the parent, if this task had one
    parent_remaining: int | None  # parent's pending_children after decrement
    reenqueued_parent: bool     # True iff we enqueued the parent's continue job

async def settle_task_terminal(
    pool: asyncpg.Pool,
    *,
    task_id: str,
    user_id: str,
    status: str,  # one of 'done' | 'failed' | 'cancelled'
) -> SettleResult
```

Behaviour (all inside `async with conn.transaction()`):

1. **Terminal transition (once-only):**
   ```sql
   UPDATE public.tasks
   SET status = $2, finished_at = now(), updated_at = now()
   WHERE id = $1 AND status NOT IN ('done','failed','cancelled')
   RETURNING parent_task_id;
   ```
   If no row is returned, the task was already terminal → return
   `SettleResult(transitioned=False, …None, reenqueued_parent=False)`.
   The `WHERE status NOT IN (terminal)` clause is what makes the whole
   operation **idempotent against job retries**: the decrement can fire
   at most once per child, because the transition fires at most once.

2. **Decrement the parent (if any):**
   ```sql
   UPDATE public.tasks
   SET pending_children = pending_children - 1, updated_at = now()
   WHERE id = $parent
   RETURNING pending_children, status;
   ```

3. **Re-enqueue the parent at zero — but only if the parent is live:**
   if `pending_children == 0` **and** the parent's `status NOT IN
   ('done','failed','cancelled')`, insert the parent's `continue` job
   (same INSERT as `enqueue_continue_job`, run on the same `conn` so it's
   inside the transaction). This guard is the cancellation-safety: a
   cancelled/finished parent is never resurrected by a late child
   settlement.

Notes:
- Run steps 1–3 on the same acquired `conn` within one transaction so the
  decrement and the re-enqueue decision are race-free (no other worker
  can interleave between the decrement and the zero-check).
- `status` is validated against the allowed terminal set before the
  query (defensive; a bad value raises rather than writing garbage).

## 3. Reuse, not duplicate

The continue-job INSERT is identical to `jobs.enqueue_continue_job`'s
SQL. To keep it transactional with the decrement, `barrier.py` issues the
INSERT on its own `conn` (it cannot call `enqueue_continue_job`, which
acquires its own connection). Extract the INSERT SQL string to a shared
constant imported by both, so the two never drift. (Small, DRY.)

## 4. Tests — `services/agent-py/tests/test_barrier.py`

Mirror the existing **mocked-pool** style (`tests/test_jobs.py`'s
`_fake_pool`, `tests/conftest.py`). These prove the control flow + the
SQL each branch issues — they do **not** prove true DB atomicity (see
caveat). Cases:

1. **Transition + decrement + re-enqueue at zero** — a child whose
   terminal UPDATE returns a `parent_task_id`, whose parent decrement
   returns `pending_children = 0` and a live status, results in a
   continue-job INSERT; `SettleResult(transitioned=True,
   reenqueued_parent=True, parent_remaining=0)`.
2. **Decrement but NOT re-enqueue when children remain** — parent
   decrement returns `pending_children = 2` → no INSERT;
   `reenqueued_parent=False`.
3. **Already terminal → no-op** — terminal UPDATE returns no row → no
   decrement, no INSERT, `transitioned=False`.
4. **No parent → transition only** — terminal UPDATE returns
   `parent_task_id = None` → no decrement, no INSERT.
5. **Counter zero but parent cancelled → no re-enqueue** — decrement
   returns `pending_children = 0` with `status = 'cancelled'` → no INSERT
   (the cancellation-safety guard); `reenqueued_parent=False`.
6. **Invalid terminal status rejected** — `status='running'` raises
   `ValueError` before issuing any query.

Also run `bun run codegen:agent-types:check` is **not** needed (no FastAPI
shape change). The agent-py gate is `bun run check:agent-py` (ruff +
ruff format --check + mypy + pytest) — the new module + tests must pass
it.

## 5. Cancellation

PR-1 ships the **barrier guard** (step 3: never re-enqueue a
cancelled/terminal parent), which is the correctness-critical half. The
**active cascade** (when a parent is cancelled, set its unsettled
children to `cancelled`) is **deferred to PR-2**: with no spawn tool yet,
PR-1 has no real children to cascade, so the cascade can't be exercised
end-to-end. PR-2 adds it to the Next.js cancel route
(`app/api/tasks/[id]/cancel/route.ts`, the live in-Next backend) when
spawning lands. This is an explicit deferral, not a silent drop.

## Honest caveat — what the tests can and can't prove

The repo's job/poller/executor tests all **mock the DB** (no real
Postgres). So `test_barrier.py` proves the branch logic and the SQL each
path issues, **not** the transactional race-freeness (which is the whole
point of doing steps 1–3 in one transaction). The race-free guarantee
can only be verified live against a real Postgres — a deferred manual
smoke, consistent with every prior DB-touching change. The PR checklist
will call this out.

## Scope boundary

- **PR-1 (this spec):** `0028` migration + `types.ts`; `barrier.py`
  (`settle_task_terminal`) + shared continue-INSERT constant; mocked
  agent-py tests. Nothing calls `settle_task_terminal` in production yet
  — it's wired by PR-2.
- **PR-2:** the spawn tool (`makeSpawnSubagentTool`), the runner
  yield/resume on a `spawn` outcome, the executor creating child rows +
  setting `pending_children`, the settlement path calling
  `settle_task_terminal`, depth/breadth caps, and the active
  cancellation cascade in the Next cancel route.
- **PR-3:** client canvas node tree + task-strip child group.
- **agent-ts mirror:** deferred to its real-step phase; the agent-ts job
  schema drift is a separate finding, not fixed here.
