# Subagent Orchestration PR-1 — Schema + Join Barrier (agent-py) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the durable join-barrier plumbing — a `parent_task_id` + `pending_children` counter on `tasks`, and a race-free, idempotent `settle_task_terminal()` in agent-py that transitions a child task to terminal, decrements its parent's counter, and re-enqueues the parent's `continue` job exactly when the counter hits zero (and only if the parent is still live).

**Architecture:** A migration (`0028`) + the matching `lib/shared/supabase/types.ts` edit; one new agent-py module `barrier.py` doing all three steps inside a single transaction; a tiny DRY refactor in `jobs.py` to share the continue-job INSERT SQL. Nothing calls `settle_task_terminal` in production yet — PR-2 wires it. agent-ts is deferred (its job schema is drifted; see spec).

**Tech Stack:** Postgres (Supabase migration), TypeScript types, Python 3.12 / asyncpg / pytest / ruff / mypy.

**Spec:** [`docs/superpowers/specs/2026-06-20-subagent-orchestration-pr1-design.md`](../specs/2026-06-20-subagent-orchestration-pr1-design.md)

**Conventions:**
- agent-py gate: `bun run check:agent-py` (ruff check + `ruff format --check` + mypy + pytest) — run it (not just ruff) before committing agent-py changes. Auto-fix first: `cd services/agent-py && uv run ruff format . && uv run ruff check --fix .`.
- agent-py modules start with `from __future__ import annotations` and are fully type-hinted (mypy strict).
- Tests use the **mocked-pool** style from `services/agent-py/tests/test_jobs.py` (`_fake_pool`) + `conftest.py`. No real Postgres.
- The repo TS gate is `bun run check` (typecheck + lint + test). `verify-supabase-types.sh` is **CI-only** (not in `check`); it diffs migrations vs `types.ts` against the PR base and passes when both change together.

---

### Task 1: Migration `0028` + `types.ts`

**Files:**
- Create: `supabase/migrations/0028_subagents.sql`
- Modify: `lib/shared/supabase/types.ts` (the `tasks` table block, ~lines 1096-1158)

- [ ] **Step 1: Write the migration** — create `supabase/migrations/0028_subagents.sql`:

```sql
-- Subagent orchestration PR-1: parent/child link + join-barrier counter.
-- A task may have a parent (orchestrator); `pending_children` is the
-- parent's barrier counter (0 for leaves). No RLS change needed — the
-- existing per-user row policies on `tasks` already cover new columns.
alter table public.tasks
  add column parent_task_id uuid references public.tasks(id) on delete cascade,
  add column pending_children int not null default 0;

create index if not exists tasks_parent_task_id_idx
  on public.tasks (parent_task_id);
```

(Do NOT add a `-- verify-supabase-types: skip` marker — this changes the `tasks` shape, so `types.ts` must change too, which Step 2 does.)

- [ ] **Step 2: Update `types.ts`.** In the `tasks` block (`lib/shared/supabase/types.ts`), add the two columns to `Row`, `Insert`, and `Update`, keeping the existing alphabetical ordering (between `max_steps` and `result_message_id`):

In `Row` (after `max_steps: number`):
```typescript
          parent_task_id: string | null
          pending_children: number
```
In `Insert` (after `max_steps?: number`):
```typescript
          parent_task_id?: string | null
          pending_children?: number
```
In `Update` (after `max_steps?: number`):
```typescript
          parent_task_id?: string | null
          pending_children?: number
```

Then add the self-referential FK to the `tasks` `Relationships` array (after the existing `tasks_result_message_id_fkey` entry), mirroring the generated shape:
```typescript
          {
            foreignKeyName: "tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
```

- [ ] **Step 3: Typecheck the types change**

Run: `cd /Users/blackmount8/_repository/hummingbird-subagents && bun run typecheck 2>&1 | tail -5`
Expected: no errors (the additive type fields don't break any consumer).

- [ ] **Step 4: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird-subagents
git add supabase/migrations/0028_subagents.sql lib/shared/supabase/types.ts
git commit -m "feat(tasks): parent_task_id + pending_children for subagent join barrier"
```

---

### Task 2: Barrier module + DRY the continue-INSERT SQL

**Files:**
- Modify: `services/agent-py/src/agent_py/jobs.py` (rename the private INSERT SQL to a shared module constant)
- Create: `services/agent-py/src/agent_py/barrier.py`
- Test: `services/agent-py/tests/test_barrier.py`

- [ ] **Step 1: Share the INSERT SQL in `jobs.py`.** Rename the private `_ENQUEUE_SQL` constant to a public module constant `ENQUEUE_CONTINUE_SQL` so `barrier.py` can reuse the exact same INSERT (avoids drift). Change the declaration:

```python
ENQUEUE_CONTINUE_SQL = """
INSERT INTO public.task_jobs (task_id, user_id, action, payload, status, scheduled_at)
VALUES ($1, $2, $3, $4::jsonb, 'queued', now());
"""
```

and update its single use inside `enqueue_continue_job` from `_ENQUEUE_SQL` to `ENQUEUE_CONTINUE_SQL`. No behaviour change.

- [ ] **Step 2: Write the failing tests** — create `services/agent-py/tests/test_barrier.py`:

```python
"""Tests for the subagent join barrier (mocked pool, no real Postgres).

These prove the control flow + which SQL each branch issues. True
transactional atomicity is verified live against a real Postgres
(deferred manual smoke), per the spec's caveat.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent_py.barrier import SettleResult, settle_task_terminal

TASK_ID = "11111111-1111-1111-1111-111111111111"
PARENT_ID = "99999999-9999-9999-9999-999999999999"
USER_ID = "33333333-3333-3333-3333-333333333333"


def _fake_pool(fetchrow_results: list[Any]) -> tuple[MagicMock, MagicMock]:
    """Fake `asyncpg.Pool` whose connection supports `transaction()` (an
    async CM) and returns the supplied `fetchrow` values in order."""
    conn = MagicMock()
    conn.fetchrow = AsyncMock(side_effect=fetchrow_results)
    conn.execute = AsyncMock(return_value="INSERT 0 1")

    txn = MagicMock()
    txn.__aenter__ = AsyncMock(return_value=None)
    txn.__aexit__ = AsyncMock(return_value=None)
    conn.transaction = MagicMock(return_value=txn)

    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=None)
    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool, conn


@pytest.mark.asyncio
async def test_transition_decrement_and_reenqueue_at_zero() -> None:
    pool, conn = _fake_pool(
        [
            {"parent_task_id": uuid.UUID(PARENT_ID)},
            {"pending_children": 0, "status": "running"},
        ]
    )
    result = await settle_task_terminal(
        pool, task_id=TASK_ID, user_id=USER_ID, status="done"
    )
    assert result == SettleResult(
        transitioned=True,
        parent_task_id=PARENT_ID,
        parent_remaining=0,
        reenqueued_parent=True,
    )
    conn.execute.assert_awaited_once()  # the continue-job INSERT


@pytest.mark.asyncio
async def test_decrement_but_not_reenqueue_when_children_remain() -> None:
    pool, conn = _fake_pool(
        [
            {"parent_task_id": uuid.UUID(PARENT_ID)},
            {"pending_children": 2, "status": "running"},
        ]
    )
    result = await settle_task_terminal(
        pool, task_id=TASK_ID, user_id=USER_ID, status="failed"
    )
    assert result.transitioned is True
    assert result.parent_remaining == 2
    assert result.reenqueued_parent is False
    conn.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_already_terminal_is_noop() -> None:
    pool, conn = _fake_pool([None])
    result = await settle_task_terminal(
        pool, task_id=TASK_ID, user_id=USER_ID, status="done"
    )
    assert result == SettleResult(
        transitioned=False,
        parent_task_id=None,
        parent_remaining=None,
        reenqueued_parent=False,
    )
    assert conn.fetchrow.await_count == 1  # only the transition probe
    conn.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_parent_transitions_only() -> None:
    pool, conn = _fake_pool([{"parent_task_id": None}])
    result = await settle_task_terminal(
        pool, task_id=TASK_ID, user_id=USER_ID, status="done"
    )
    assert result == SettleResult(
        transitioned=True,
        parent_task_id=None,
        parent_remaining=None,
        reenqueued_parent=False,
    )
    assert conn.fetchrow.await_count == 1  # no decrement
    conn.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_zero_counter_but_parent_cancelled_does_not_reenqueue() -> None:
    pool, conn = _fake_pool(
        [
            {"parent_task_id": uuid.UUID(PARENT_ID)},
            {"pending_children": 0, "status": "cancelled"},
        ]
    )
    result = await settle_task_terminal(
        pool, task_id=TASK_ID, user_id=USER_ID, status="done"
    )
    assert result.transitioned is True
    assert result.parent_remaining == 0
    assert result.reenqueued_parent is False
    conn.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_non_terminal_status_rejected() -> None:
    pool, _conn = _fake_pool([])
    with pytest.raises(ValueError):
        await settle_task_terminal(
            pool, task_id=TASK_ID, user_id=USER_ID, status="running"
        )
    pool.acquire.assert_not_called()  # rejected before touching the DB
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/blackmount8/_repository/hummingbird-subagents/services/agent-py && uv run pytest tests/test_barrier.py -q`
Expected: FAIL — `agent_py.barrier` does not exist.

- [ ] **Step 4: Implement** — create `services/agent-py/src/agent_py/barrier.py`:

```python
"""Subagent join barrier.

When a child task settles, transition it to terminal exactly once,
decrement its parent's `pending_children`, and re-enqueue the parent's
`continue` job when the counter reaches zero — but only if the parent is
still live (never resurrect a cancelled/finished orchestrator). All three
steps run in one transaction so the decrement and the zero-check are
race-free. Idempotent against job retries: the terminal transition's
`WHERE status NOT IN (terminal)` clause fires at most once per task, so
the decrement fires at most once.

PR-1 ships this module standalone (proven with mocked pools); PR-2 wires
the executor/settlement path to call it.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass

import asyncpg

from agent_py.jobs import ENQUEUE_CONTINUE_SQL

_TERMINAL = ("done", "failed", "cancelled")

_TRANSITION_SQL = """
UPDATE public.tasks
SET status = $2, finished_at = now(), updated_at = now()
WHERE id = $1 AND status NOT IN ('done', 'failed', 'cancelled')
RETURNING parent_task_id;
"""

_DECREMENT_SQL = """
UPDATE public.tasks
SET pending_children = pending_children - 1, updated_at = now()
WHERE id = $1
RETURNING pending_children, status;
"""


@dataclass(frozen=True)
class SettleResult:
    """Outcome of a settle attempt. `transitioned` is False when the task
    was already terminal (idempotent no-op)."""

    transitioned: bool
    parent_task_id: str | None
    parent_remaining: int | None
    reenqueued_parent: bool


async def settle_task_terminal(
    pool: asyncpg.Pool,
    *,
    task_id: str,
    user_id: str,
    status: str,
) -> SettleResult:
    """Move `task_id` to terminal `status`, settle its parent's barrier.

    `status` must be one of 'done' | 'failed' | 'cancelled'.
    """
    if status not in _TERMINAL:
        raise ValueError(
            f"settle_task_terminal: status must be terminal, got {status!r}"
        )

    task_uuid = uuid.UUID(task_id)
    user_uuid = uuid.UUID(user_id)

    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(_TRANSITION_SQL, task_uuid, status)
            if row is None:
                # Already terminal — idempotent no-op.
                return SettleResult(
                    transitioned=False,
                    parent_task_id=None,
                    parent_remaining=None,
                    reenqueued_parent=False,
                )

            parent = row["parent_task_id"]
            if parent is None:
                return SettleResult(
                    transitioned=True,
                    parent_task_id=None,
                    parent_remaining=None,
                    reenqueued_parent=False,
                )

            dec = await conn.fetchrow(_DECREMENT_SQL, parent)
            remaining: int | None = dec["pending_children"] if dec else None
            parent_status = dec["status"] if dec else None

            reenqueued = False
            if remaining == 0 and parent_status not in _TERMINAL:
                await conn.execute(
                    ENQUEUE_CONTINUE_SQL,
                    parent,
                    user_uuid,
                    "continue",
                    json.dumps({}),
                )
                reenqueued = True

            return SettleResult(
                transitioned=True,
                parent_task_id=str(parent),
                parent_remaining=remaining,
                reenqueued_parent=reenqueued,
            )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/blackmount8/_repository/hummingbird-subagents/services/agent-py && uv run pytest tests/test_barrier.py -q`
Expected: 6 passed.

- [ ] **Step 6: Auto-format + lint-fix, then commit**

```bash
cd /Users/blackmount8/_repository/hummingbird-subagents/services/agent-py
uv run ruff format . && uv run ruff check --fix .
cd /Users/blackmount8/_repository/hummingbird-subagents
git add services/agent-py/src/agent_py/jobs.py services/agent-py/src/agent_py/barrier.py services/agent-py/tests/test_barrier.py
git commit -m "feat(agent-py): join-barrier settle_task_terminal (race-free, idempotent)"
```

---

### Task 3: Full gate

**Files:** none (verification only).

- [ ] **Step 1: agent-py gate** (mirrors the agent-py CI job exactly)

Run: `cd /Users/blackmount8/_repository/hummingbird-subagents && bun run check:agent-py`
Expected: ruff check clean, `ruff format --check` clean, mypy clean, pytest all pass (including the 6 new barrier tests).

- [ ] **Step 2: repo TS gate** (the migration's `types.ts` change)

Run: `cd /Users/blackmount8/_repository/hummingbird-subagents && bun run check`
Expected: typecheck clean, lint 0 errors, tests pass. (The `verify-supabase-types` guard is CI-only; it will pass because `0028_subagents.sql` and `types.ts` change together in this PR.)

- [ ] **Step 3: Commit any gate fixes** (only if Steps 1-2 required changes; otherwise skip)

```bash
cd /Users/blackmount8/_repository/hummingbird-subagents
git add -A && git commit -m "chore: gate fixes for subagent barrier" || echo "nothing to commit"
```

---

## Notes for the PR description

- PR-1 of `docs/PLAN-subagent-orchestration.md`, **re-scoped to agent-py only** (the agent-ts job schema is drifted from `0014` and agent-ts is dry-run; the mirror waits for its real-step phase — drift flagged separately).
- Schema: `tasks.parent_task_id` + `tasks.pending_children` + index (`0028`), with the matching `types.ts` update.
- Barrier: `settle_task_terminal` — once-only terminal transition, atomic parent decrement, re-enqueue the parent's `continue` job at zero and only if the parent is live. Nothing calls it yet (PR-2 wires the spawn tool + executor + the active cancel cascade).
- **Verification caveat:** the agent-py tests mock the DB (repo convention), so they prove logic/SQL shape, not transactional atomicity. The race-free guarantee needs a live Postgres smoke (deferred, like all prior DB-touching work).
- No model calls, no client changes, no wire-schema change.
