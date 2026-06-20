# Subagent Orchestration PR-2 — Spawn + Fan-out + Fan-in (agent-py) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A model running in agent-py can call a `spawnSubagent` tool to decompose its goal into N child tasks; the executor fans them out, the parent yields, and when PR-1's barrier re-enqueues the parent it resumes with the aggregated child results injected as the spawn tool's result.

**Architecture:** Reuse the existing gated-tool **suspend/resume shape** — a no-execute tool returns a descriptor, the executor checkpoints the pending `tool_call_id`, resume injects a `tool_result`. Spawn differs only in: the executor creates children + yields (instead of pausing for a human), and resume injects **aggregated child results**. PR-1's `settle_task_terminal` is the barrier. agent-py only.

**Tech Stack:** Python 3.12 / asyncpg / pytest / ruff / mypy; one TS edit (Next cancel route).

**Spec:** [`docs/superpowers/specs/2026-06-20-subagent-orchestration-pr2-design.md`](../specs/2026-06-20-subagent-orchestration-pr2-design.md)

**Conventions (same as PR-1):**
- agent-py gate: `bun run check:agent-py` (ruff + `ruff format --check` + mypy + pytest). Auto-fix first: `cd services/agent-py && uv run ruff format . && uv run ruff check --fix .`.
- Modules start with `from __future__ import annotations`; full type hints (mypy strict).
- Tests mock the pool / inject synthetic step fns (see `tests/test_jobs.py` `_fake_pool`, `tests/test_barrier.py`, `tests/test_executor.py`). No real Postgres/model.
- Run one test file: `cd services/agent-py && uv run pytest tests/<file> -q`.
- **Deps are pre-installed in this worktree** (`uv sync` + `bun install` done by the controller).

**Anchor references (read these exact spots when implementing):**
- `runner.py:40-107` — `PendingInputDescriptor`, `RunStepOutcome`, `AgentLoopResultKind`, `AgentLoopResult`. `runner.py:156-187` — the loop's pending_input / done branches.
- `executor.py:373-461` — `_run_chunk` result handling (`suspended`/`yielded`/terminal). `executor.py:389-413` is the suspended branch to mirror; `executor.py:441-460` are the terminal `update_run` calls to reroute through the barrier.
- `providers/anthropic_provider.py:184-301` — tool-use handling; `:199-222` is the gated-tool no-execute branch to mirror.
- `tools/ask_user.py` — the gated no-execute `ToolDescriptor` pattern (execute raises).
- `tools/registry.py:130-199` — `default_tool_registry`; `ToolDescriptor`/`ToolContext` at `:68-108`.
- `barrier.py` — `settle_task_terminal` (PR-1). `jobs.py` — `ENQUEUE_CONTINUE_SQL`, `enqueue_continue_job`, `_coerce_uuid`.
- `events.py:44-58` — `TaskEventKind`; the union is near the bottom. `emitter.py` — `RunEmitter`.
- `store.py` — `update_run`, `save_checkpoint`, `load_checkpoint`, `append_event`.

---

### Task 1: Spawn outcome IR (runner.py)

**Files:** Modify `services/agent-py/src/agent_py/runner.py`; Test `services/agent-py/tests/test_runner.py` (append).

- [ ] **Step 1: Write the failing test** — append to `tests/test_runner.py` (it already imports from `agent_py.runner`; reuse its existing `RunEmitter`/fakes — read the file's top to match its helpers). Add:

```python
@pytest.mark.asyncio
async def test_spawn_outcome_returns_spawned_kind() -> None:
    from agent_py.runner import SpawnDescriptor, SpawnSpec

    emitter = _make_emitter()  # use the file's existing emitter fixture/factory
    spawn = SpawnDescriptor(
        tool_call_id="call-1",
        tasks=[SpawnSpec(persona_slug="researcher", subgoal="find sources")],
    )

    async def step(ctx):
        from agent_py.runner import RunStepOutcome
        return RunStepOutcome(done=False, spawn=spawn)

    result = await run_agent_loop(
        emitter=emitter,
        max_steps=5,
        run_step=step,
        is_cancelled=_never_cancelled,
    )
    assert result.kind == "spawned"
    assert result.spawn is spawn
```

(If `tests/test_runner.py` doesn't exist or lacks `_make_emitter`/`_never_cancelled`, create the test using the same emitter construction `tests/test_executor.py` or `tests/test_runner*.py` use — match the existing pattern in the repo.)

- [ ] **Step 2: Run to verify it fails** — `cd services/agent-py && uv run pytest tests/test_runner.py -q` → FAIL (`SpawnSpec`/`spawn` unknown).

- [ ] **Step 3: Implement in `runner.py`.** After `PendingInputDescriptor` (runner.py:56), add:

```python
@dataclass(frozen=True)
class SpawnSpec:
    """One child to spawn: a persona slug (recorded for labelling; v1
    children run the parent config — see the PR-2 spec §4.3) + the
    subgoal it is pinned to."""

    persona_slug: str
    subgoal: str


@dataclass(frozen=True)
class SpawnDescriptor:
    """A no-execute `spawnSubagent` call the step fn captured. The
    executor fans out children + yields; the parent resumes when the
    barrier re-enqueues it, with the aggregated results injected as the
    `tool_result` for `tool_call_id`."""

    tool_call_id: str
    tasks: list[SpawnSpec]
```

Extend `RunStepOutcome` (runner.py:59-72) with a third field:

```python
    done: bool
    pending_input: PendingInputDescriptor | None = None
    spawn: SpawnDescriptor | None = None
```

Extend the loop kind (runner.py:82) and result (runner.py:85-107):

```python
AgentLoopResultKind = Literal["settled", "cancelled", "yielded", "suspended", "spawned"]
```
```python
    kind: AgentLoopResultKind
    pending_input: PendingInputDescriptor | None = None
    spawn: SpawnDescriptor | None = None
```

In `run_agent_loop`, add a branch **immediately after** the `pending_input` branch (after runner.py:177, before the `outcome.done` check):

```python
        if outcome.spawn is not None:
            # Fan-out point — the step fn captured a `spawnSubagent`
            # call but didn't execute it. The executor creates child
            # task rows + yields; no terminal event here.
            return AgentLoopResult(kind="spawned", spawn=outcome.spawn)
```

- [ ] **Step 4: Run to verify it passes** — `uv run pytest tests/test_runner.py -q` → PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird-subagents2
git add services/agent-py/src/agent_py/runner.py services/agent-py/tests/test_runner.py
git commit -m "feat(agent-py): spawn step outcome + spawned loop result"
```

---

### Task 2: Spawn tool descriptor + parse helper + registry

**Files:** Create `services/agent-py/src/agent_py/tools/spawn_subagent.py`; Modify `tools/registry.py`; Test `tests/test_spawn_subagent.py`.

- [ ] **Step 1: Write the failing test** — `tests/test_spawn_subagent.py`:

```python
from __future__ import annotations

import pytest

from agent_py.tools.spawn_subagent import (
    MAX_CHILDREN,
    SPAWN_SUBAGENT_TOOL_NAME,
    build_spawn_subagent_tool,
    parse_spawn_specs,
)
from agent_py.tools.registry import ToolError


def test_descriptor_shape() -> None:
    tool = build_spawn_subagent_tool()
    assert tool.name == SPAWN_SUBAGENT_TOOL_NAME
    assert "tasks" in tool.input_schema["properties"]


@pytest.mark.asyncio
async def test_execute_raises() -> None:
    tool = build_spawn_subagent_tool()
    with pytest.raises(ToolError):
        await tool.execute({"tasks": []})


def test_parse_drops_malformed_and_clamps() -> None:
    raw = {
        "tasks": [
            {"personaSlug": "a", "subgoal": "g1"},
            {"personaSlug": "b"},  # missing subgoal → dropped
            {"subgoal": "g3"},  # missing personaSlug → dropped
            "nonsense",  # not a dict → dropped
        ]
    }
    specs = parse_spawn_specs(raw)
    assert [(s.persona_slug, s.subgoal) for s in specs] == [("a", "g1")]


def test_parse_clamps_to_max() -> None:
    raw = {"tasks": [{"personaSlug": f"p{i}", "subgoal": f"g{i}"} for i in range(MAX_CHILDREN + 3)]}
    assert len(parse_spawn_specs(raw)) == MAX_CHILDREN
```

(Confirm the exact name/location of the `ToolError` import by reading `tools/registry.py` — adjust the import if it lives elsewhere.)

- [ ] **Step 2: Run to verify it fails** — `uv run pytest tests/test_spawn_subagent.py -q` → FAIL (module missing).

- [ ] **Step 3: Implement `tools/spawn_subagent.py`:**

```python
"""The `spawnSubagent` tool — a no-execute (gated-shape) tool. When the
model calls it, the step fn captures it as a SpawnDescriptor and the
executor fans out child tasks; it is never executed inline (its
`execute` raises, like `ask_user`)."""

from __future__ import annotations

import os
from typing import Any

from agent_py.runner import SpawnSpec
from agent_py.tools.registry import ToolDescriptor, ToolError

SPAWN_SUBAGENT_TOOL_NAME = "spawnSubagent"


def _max_children() -> int:
    raw = os.environ.get("MAX_SPAWN_CHILDREN")
    if raw:
        try:
            n = int(raw)
            if n > 0:
                return n
        except ValueError:
            pass
    return 5


MAX_CHILDREN = _max_children()

_DESCRIPTION = (
    "Decompose this goal into specialist subagents, each pinned to a "
    "subgoal. They run in parallel; you resume with their results. Use "
    "only when the goal genuinely splits into independent subtasks."
)

_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_CHILDREN,
            "items": {
                "type": "object",
                "properties": {
                    "personaSlug": {"type": "string"},
                    "subgoal": {"type": "string"},
                },
                "required": ["personaSlug", "subgoal"],
            },
        }
    },
    "required": ["tasks"],
}


async def _spawn_execute_fallback(_args: dict[str, Any]) -> str:
    raise ToolError(
        "spawnSubagent must be handled by the executor (fan-out), not executed inline."
    )


def build_spawn_subagent_tool() -> ToolDescriptor:
    return ToolDescriptor(
        name=SPAWN_SUBAGENT_TOOL_NAME,
        description=_DESCRIPTION,
        input_schema=_INPUT_SCHEMA,
        execute=_spawn_execute_fallback,
    )


def parse_spawn_specs(args: Any) -> list[SpawnSpec]:
    """Pure: extract valid SpawnSpecs from a tool-call's args, dropping
    malformed entries and clamping to MAX_CHILDREN."""
    specs: list[SpawnSpec] = []
    tasks = args.get("tasks") if isinstance(args, dict) else None
    if not isinstance(tasks, list):
        return specs
    for item in tasks:
        if not isinstance(item, dict):
            continue
        slug = item.get("personaSlug")
        subgoal = item.get("subgoal")
        if isinstance(slug, str) and slug and isinstance(subgoal, str) and subgoal:
            specs.append(SpawnSpec(persona_slug=slug, subgoal=subgoal))
        if len(specs) >= MAX_CHILDREN:
            break
    return specs
```

> NOTE: confirm `ToolError` + `ToolDescriptor` import paths against `tools/registry.py`. If `ToolError` is defined elsewhere (e.g. a `tools/errors.py`), import from there.

- [ ] **Step 4: Register in `tools/registry.py`.** In `default_tool_registry` (registry.py:130-199), add the spawn tool to the `out` dict unconditionally (beside `webFetch`/`askUser`/`renderUI`):

```python
    from .spawn_subagent import build_spawn_subagent_tool
    out["spawnSubagent"] = build_spawn_subagent_tool()
```

- [ ] **Step 5: Run to verify it passes** — `uv run pytest tests/test_spawn_subagent.py -q` → PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird-subagents2
git add services/agent-py/src/agent_py/tools/spawn_subagent.py services/agent-py/src/agent_py/tools/registry.py services/agent-py/tests/test_spawn_subagent.py
git commit -m "feat(agent-py): spawnSubagent tool descriptor + parse helper"
```

---

### Task 3: Step-fn spawn detection (anthropic_provider.py)

**Files:** Modify `services/agent-py/src/agent_py/providers/anthropic_provider.py`; Test `tests/test_anthropic_provider.py` (append, mirroring its existing gated-tool test).

- [ ] **Step 1: Read** `providers/anthropic_provider.py:184-301` and the existing gated-tool test in `tests/test_anthropic_provider.py` (find the test that feeds a tool_use block and asserts `pending_input`). You will mirror both.

- [ ] **Step 2: Write the failing test** — append a test mirroring the gated-tool test but for a `spawnSubagent` tool_use, asserting the step returns `RunStepOutcome(done=False, spawn=SpawnDescriptor(...))` with the parsed tasks and that NO tool executed. Use the same fake Anthropic stream/client the existing test uses. Example skeleton (adapt to the file's actual fakes):

```python
@pytest.mark.asyncio
async def test_spawn_tool_call_returns_spawn_outcome() -> None:
    # Build a fake stream whose final message has a `spawnSubagent`
    # tool_use block with input {"tasks":[{"personaSlug":"r","subgoal":"g"}]}.
    # (Reuse the helper the gated-tool test uses to construct this.)
    ...
    outcome = await step_fn(ctx)
    assert outcome.done is False
    assert outcome.spawn is not None
    assert outcome.spawn.tool_call_id == "<the tool_use id>"
    assert [(s.persona_slug, s.subgoal) for s in outcome.spawn.tasks] == [("r", "g")]
```

- [ ] **Step 3: Run to verify it fails.**

- [ ] **Step 4: Implement.** In the tool-use handling loop in `make_anthropic_step_fn`, add a branch **before** the gated-tool branch (anthropic_provider.py:~199), mirroring it:

```python
        if tool_name == SPAWN_SUBAGENT_TOOL_NAME:
            tool_call_id = _block_field(block, "id") or ""
            args = _block_field(block, "input") or {}
            await ctx.emitter.tool_input(tool_call_id, tool_name, args)
            config.messages.append({"role": "assistant", "content": content_blocks})
            return RunStepOutcome(
                done=False,
                spawn=SpawnDescriptor(
                    tool_call_id=tool_call_id,
                    tasks=parse_spawn_specs(args),
                ),
            )
```

Add the imports at the top of the file:
```python
from agent_py.runner import RunStepOutcome, SpawnDescriptor  # RunStepOutcome likely already imported
from agent_py.tools.spawn_subagent import SPAWN_SUBAGENT_TOOL_NAME, parse_spawn_specs
```
(Match `_block_field` / `ctx.emitter.tool_input` / `content_blocks` to the exact names used in the surrounding gated-tool branch — copy them verbatim from anthropic_provider.py:199-222.)

- [ ] **Step 5: Run to verify it passes.**

- [ ] **Step 6: Commit**

```bash
git add services/agent-py/src/agent_py/providers/anthropic_provider.py services/agent-py/tests/test_anthropic_provider.py
git commit -m "feat(agent-py): step fn captures spawnSubagent as a spawn outcome"
```

---

### Task 4: store + jobs helpers (child creation, counter, results, start job)

**Files:** Modify `store.py`, `jobs.py`; Test `tests/test_store.py` (append) + `tests/test_jobs.py` (append).

- [ ] **Step 1: Write failing tests** — append to `tests/test_jobs.py` a test that `enqueue_start_job` issues the INSERT with action `"start"` (mirror the existing `enqueue_continue_job` test if present, else assert `conn.execute` called with the SQL + `"start"`). Append to `tests/test_store.py` tests for `create_child_task` (issues an INSERT with `parent_task_id` + returns the id), `set_pending_children` (issues the UPDATE with `n`), and `load_child_results` (maps rows → `ChildResult`). Use the mocked-pool helper that file already uses.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement `jobs.py`** — add beside `enqueue_continue_job`:

```python
_ENQUEUE_START_SQL = ENQUEUE_CONTINUE_SQL  # same columns; action differs


async def enqueue_start_job(
    pool: asyncpg.Pool,
    *,
    task_id: str,
    user_id: str,
) -> None:
    """Insert a `start` job for a (child) task. Payload empty — `start`
    reads everything from `tasks.checkpoint`."""
    async with pool.acquire() as conn:
        await conn.execute(
            ENQUEUE_CONTINUE_SQL,
            _coerce_uuid(task_id),
            _coerce_uuid(user_id),
            "start",
            json.dumps({}),
        )
```

(`ENQUEUE_CONTINUE_SQL` is the generic INSERT from PR-1; the `_ENQUEUE_START_SQL` alias is optional — you can just reuse `ENQUEUE_CONTINUE_SQL` directly. Keep it simple: reuse it.)

- [ ] **Step 4: Implement `store.py`** — add:

```python
async def create_child_task(
    pool: asyncpg.Pool,
    *,
    parent_task_id: str,
    user_id: str,
    conversation_id: str,
    goal: str,
    checkpoint: dict[str, object],
) -> str:
    """INSERT a child task row (status 'queued', parent_task_id set) and
    return its id."""
    sql = """
    INSERT INTO public.tasks (id, user_id, conversation_id, goal, status, parent_task_id, checkpoint)
    VALUES (gen_random_uuid(), $1, $2, $3, 'queued', $4, $5::jsonb)
    RETURNING id;
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            sql,
            _coerce_uuid(user_id),
            _coerce_uuid(conversation_id),
            goal,
            _coerce_uuid(parent_task_id),
            json.dumps(checkpoint),
        )
    return str(row["id"])


async def set_pending_children(
    pool: asyncpg.Pool,
    *,
    task_id: str,
    user_id: str,
    n: int,
) -> None:
    sql = "UPDATE public.tasks SET pending_children = $2, updated_at = now() WHERE id = $1;"
    async with pool.acquire() as conn:
        await conn.execute(sql, _coerce_uuid(task_id), n)


@dataclass(frozen=True)
class ChildResult:
    persona_slug: str
    subgoal: str
    status: str
    final_text: str


async def load_child_results(
    pool: asyncpg.Pool,
    *,
    parent_task_id: str,
    user_id: str,
) -> list[ChildResult]:
    """Load each child task's terminal status + final text (the latest
    `result` event payload's text). `persona_slug`/`subgoal` are read
    from the child's checkpoint metadata (see create_child_task)."""
    sql = """
    SELECT t.id, t.status, t.checkpoint,
      (SELECT e.payload FROM public.task_events e
         WHERE e.task_id = t.id AND e.kind = 'result'
         ORDER BY e.seq DESC LIMIT 1) AS result_payload
    FROM public.tasks t
    WHERE t.parent_task_id = $1
    ORDER BY t.created_at ASC;
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, _coerce_uuid(parent_task_id))
    out: list[ChildResult] = []
    for row in rows:
        cp = _as_dict(row["checkpoint"])
        meta = _as_dict(cp.get("subagent")) if cp else {}
        payload = _as_dict(row["result_payload"])
        out.append(
            ChildResult(
                persona_slug=str(meta.get("personaSlug", "")),
                subgoal=str(meta.get("subgoal", "")),
                status=str(row["status"]),
                final_text=str(payload.get("text", "")) if payload else "",
            )
        )
    return out
```

Add a small `_as_dict(value)` helper if the file lacks one (handles `None` / JSON-string / dict — mirror `jobs._row_to_claimed`'s json handling). Confirm `dataclass` + `json` are imported in `store.py`.

> NOTE on `final_text` source: this reads the child's latest `result` event payload's `text` field. Confirm the `result` event payload key for the final text by reading `emitter.result(...)` / `events.py` `ResultEvent` — adjust `"text"` to the actual field name. If the result text isn't in the event payload, fall back to the child's `checkpoint` accumulated text. The implementer must verify this against the real `ResultEvent` shape.

- [ ] **Step 5: Run to verify tests pass.** (For `load_child_results`, the mocked-pool test supplies `conn.fetch` rows as dicts.)

- [ ] **Step 6: Commit**

```bash
git add services/agent-py/src/agent_py/store.py services/agent-py/src/agent_py/jobs.py services/agent-py/tests/test_store.py services/agent-py/tests/test_jobs.py
git commit -m "feat(agent-py): child-task store/jobs helpers (create/count/results/start)"
```

---

### Task 5: HandoffEvent in the events union + emitter

**Files:** Modify `events.py`, `emitter.py`; Test `tests/test_events.py` / `tests/test_emitter.py` (append).

- [ ] **Step 1: Read** `events.py` — the existing event dataclasses + the `TaskEvent` union near the bottom, and one emitter method in `emitter.py` (e.g. `status`/`plan`) to mirror.

- [ ] **Step 2: Write the failing test** — append a test that `emitter.handoff(agent="researcher", phase="enter")` appends a `HandoffEvent` with the right `kind`/`agent`/`phase` (mirror the existing emitter test for another event). Plus a test that a `HandoffEvent` is in the `TaskEvent` union (constructs one + serializes via whatever `to_payload`/`asdict` the events use).

- [ ] **Step 3: Implement.** In `events.py`, add (mirroring the TS `HandoffEvent` shape + the local dataclass style):

```python
@dataclass(frozen=True)
class HandoffEvent(TaskEventBase):
    kind: Literal["handoff"] = "handoff"
    agent: str = ""
    phase: Literal["enter", "exit"] = "enter"
```

(Match the actual `TaskEventBase` fields + the discriminator style the other events use — copy an existing event dataclass and adapt.) Add `HandoffEvent` to the `TaskEvent` union type.

In `emitter.py`, add a method mirroring the others:

```python
    async def handoff(self, *, agent: str, phase: str = "enter") -> None:
        await self._emit(HandoffEvent(... base fields ..., agent=agent, phase=phase))
```

(Use the exact base-field construction + `_emit`/append mechanism the other emitter methods use.)

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit**

```bash
git add services/agent-py/src/agent_py/events.py services/agent-py/src/agent_py/emitter.py services/agent-py/tests/
git commit -m "feat(agent-py): HandoffEvent in the task-event union + emitter.handoff"
```

---

### Task 6: Aggregation helper (pure)

**Files:** Create `services/agent-py/src/agent_py/aggregate.py`; Test `tests/test_aggregate.py`.

- [ ] **Step 1: Write the failing test** — `tests/test_aggregate.py`:

```python
from __future__ import annotations

from agent_py.aggregate import aggregate_child_results
from agent_py.store import ChildResult


def test_success_and_failure_blocks_in_order() -> None:
    results = [
        ChildResult(persona_slug="researcher", subgoal="find sources", status="done", final_text="Found 3."),
        ChildResult(persona_slug="critic", subgoal="critique", status="failed", final_text=""),
    ]
    text = aggregate_child_results(results)
    assert "### researcher: find sources" in text
    assert "Found 3." in text
    assert "### critic: critique" in text
    assert "[failed" in text
    # order preserved
    assert text.index("researcher") < text.index("critic")
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `aggregate.py`:**

```python
"""Pure formatting of child subagent results into the tool_result text
the orchestrator sees on resume."""

from __future__ import annotations

from agent_py.store import ChildResult


def aggregate_child_results(results: list[ChildResult]) -> str:
    blocks: list[str] = []
    for r in results:
        header = f"### {r.persona_slug}: {r.subgoal}".rstrip()
        if r.status == "done" and r.final_text.strip():
            blocks.append(f"{header}\n{r.final_text.strip()}")
        else:
            reason = r.final_text.strip() or f"no result (status: {r.status})"
            blocks.append(f"{header}\n[failed: {reason}]")
    return "\n\n".join(blocks)
```

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit**

```bash
git add services/agent-py/src/agent_py/aggregate.py services/agent-py/tests/test_aggregate.py
git commit -m "feat(agent-py): aggregate_child_results pure helper"
```

---

### Task 7: Executor fan-out (the `spawned` branch)

**Files:** Modify `executor.py`; Test `tests/test_executor.py` (append).

- [ ] **Step 1: Read** `executor.py:280-461` (the `_run_chunk` body: how `payload`, `checkpoint`, `live_messages`, `emitter`, `pool`, `conversation_id`, `workspace_id` are in scope; the suspended/yielded branches; `_build_checkpoint`). The new branch reuses all of these.

- [ ] **Step 2: Write the failing test** — append to `tests/test_executor.py` a test driving `execute_start` with an injected `make_step_fn` whose step returns `RunStepOutcome(done=False, spawn=SpawnDescriptor("call-1", [SpawnSpec("a","g1"), SpawnSpec("b","g2")]))`, against a mocked pool, asserting: `store.create_child_task` called twice, `jobs.enqueue_start_job` twice, `store.set_pending_children` with `n=2`, the saved checkpoint contains `awaiting_children`, `emitter.handoff` called per child, and `ExecutorOutcome(settled=True)` with NO terminal `update_run`/`settle_task_terminal`. Mirror the existing executor tests' patching style (`patch.object(store, ...)`, `patch.object(jobs, ...)`).

Also a **depth-cap** test: a parent task whose `parent_task_id` is non-null (stub `store.load_parent_task_id` → a uuid) emitting a spawn outcome → no `create_child_task`; a `continue` job is enqueued; a rejection tool_result is appended to `live_messages`.

- [ ] **Step 3: Run to verify they fail.**

- [ ] **Step 4: Implement.** Add a `spawned` branch in `_run_chunk` **after** the `suspended` branch and **before** the `yielded` branch (around executor.py:413). New code:

```python
        if result.kind == "spawned":
            assert result.spawn is not None
            spawn = result.spawn

            # Depth cap (=1): a task that already has a parent may not spawn.
            parent_of_self = await store.load_parent_task_id(
                pool, run_id=payload.run_id, user_id=payload.user_id
            )
            if parent_of_self is not None:
                live_messages.append(_spawn_rejection_tool_result(spawn.tool_call_id))
                await store.save_checkpoint(
                    pool, run_id=payload.run_id, user_id=payload.user_id,
                    checkpoint=_build_checkpoint(checkpoint, live_messages, emitter),
                )
                await jobs.enqueue_continue_job(
                    pool, task_id=payload.run_id, user_id=payload.user_id
                )
                return ExecutorOutcome(settled=True)

            specs = spawn.tasks[:MAX_CHILDREN]
            conversation_id = _conversation_id_from(checkpoint, payload)
            children_meta: list[dict[str, str]] = []
            for spec in specs:
                child_checkpoint = _child_checkpoint(checkpoint, spec)
                child_id = await store.create_child_task(
                    pool,
                    parent_task_id=payload.run_id,
                    user_id=payload.user_id,
                    conversation_id=conversation_id,
                    goal=spec.subgoal,
                    checkpoint=child_checkpoint,
                )
                await jobs.enqueue_start_job(
                    pool, task_id=child_id, user_id=payload.user_id
                )
                await emitter.handoff(agent=spec.persona_slug, phase="enter")
                children_meta.append(
                    {"id": child_id, "personaSlug": spec.persona_slug, "subgoal": spec.subgoal}
                )

            await store.set_pending_children(
                pool, task_id=payload.run_id, user_id=payload.user_id, n=len(specs)
            )
            next_checkpoint = _build_checkpoint(checkpoint, live_messages, emitter)
            next_checkpoint["awaiting_children"] = {
                "tool_call_id": spawn.tool_call_id,
                "children": children_meta,
            }
            await store.save_checkpoint(
                pool, run_id=payload.run_id, user_id=payload.user_id,
                checkpoint=next_checkpoint,
            )
            await store.update_run(
                pool, run_id=payload.run_id, user_id=payload.user_id, status="paused"
            )
            logger.info("executor.spawned", run_id=payload.run_id, children=len(specs))
            return ExecutorOutcome(settled=True)
```

Add module-level helpers near the other `_…` helpers:

```python
def _spawn_rejection_tool_result(tool_call_id: str) -> dict[str, Any]:
    return {
        "role": "user",
        "content": [{
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": "Subagent spawning is not available here (depth limit reached). Continue without subagents.",
        }],
    }


def _child_checkpoint(parent_checkpoint: dict[str, Any], spec: SpawnSpec) -> dict[str, Any]:
    """Build a child's start checkpoint from the parent's config (v1: same
    model + system prompt), pinned to the child's subgoal, recording the
    persona slug for labelling. See PR-2 spec §4.3."""
    parent_cfg = parent_checkpoint.get("config")
    cfg = dict(parent_cfg) if isinstance(parent_cfg, dict) else {}
    return {
        "messages": [{"role": "user", "content": spec.subgoal}],
        "step": 0,
        "seq": 0,
        "config": cfg,
        "subagent": {"personaSlug": spec.persona_slug, "subgoal": spec.subgoal},
    }


def _conversation_id_from(checkpoint: dict[str, Any], payload: "StartActionPayload") -> str:
    cfg = checkpoint.get("config")
    if isinstance(cfg, dict):
        cid = cfg.get("conversationId")
        if isinstance(cid, str) and cid:
            return cid
    return payload.conversation_id  # confirm payload carries this; else read from the task row
```

Add `store.load_parent_task_id`:

```python
# in store.py
async def load_parent_task_id(
    pool: asyncpg.Pool, *, run_id: str, user_id: str
) -> str | None:
    sql = "SELECT parent_task_id FROM public.tasks WHERE id = $1;"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, _coerce_uuid(run_id))
    parent = row["parent_task_id"] if row else None
    return str(parent) if parent is not None else None
```

Imports in `executor.py`: `from agent_py.runner import SpawnSpec` (+ `SpawnDescriptor` if needed), `from agent_py.tools.spawn_subagent import MAX_CHILDREN`.

> NOTE: confirm `conversation_id` availability — read how `StartActionPayload` / the checkpoint carries it (the recon notes config has workspaceId; conversationId may be on the payload or the task row). Adjust `_conversation_id_from` to the real source; if neither, add a `store.load_conversation_id(run_id)`.

- [ ] **Step 5: Run to verify it passes.**

- [ ] **Step 6: Commit**

```bash
git add services/agent-py/src/agent_py/executor.py services/agent-py/src/agent_py/store.py services/agent-py/tests/test_executor.py
git commit -m "feat(agent-py): executor fan-out — create children, set barrier, yield"
```

---

### Task 8: Route terminal settlement through the barrier

**Files:** Modify `executor.py`; Test `tests/test_executor.py` (append).

- [ ] **Step 1: Write the failing test** — append a test that a normal terminal run (`done`) calls `barrier.settle_task_terminal(status="done")` (patch `barrier.settle_task_terminal`, assert awaited with the run id + "done"), and a cancelled run calls it with `"cancelled"`. (These replace the assertions that previously checked `store.update_run` for terminal status.)

- [ ] **Step 2: Run to verify it fails** (currently the terminal paths call `store.update_run`).

- [ ] **Step 3: Implement.** In `_run_chunk` (executor.py:444-460), replace the two terminal `store.update_run(... status="cancelled"/"done", finished=True)` calls with:

```python
        from agent_py import barrier  # or a top-of-file import

        if result.kind == "cancelled":
            await barrier.settle_task_terminal(
                pool, task_id=payload.run_id, user_id=payload.user_id, status="cancelled"
            )
        else:
            await barrier.settle_task_terminal(
                pool, task_id=payload.run_id, user_id=payload.user_id, status="done"
            )
        return ExecutorOutcome(settled=True)
```

(Prefer a top-of-file `from agent_py.barrier import settle_task_terminal` and call it directly. Keep the `step=emitter.step` bookkeeping if other code relies on it — `settle_task_terminal` sets status + finished_at; if a separate `step` write is still needed, add a `store.update_run(..., step=emitter.step)` call WITHOUT a terminal status before the settle. Confirm whether `step` must be persisted on settle by reading the current code.)

The error/except path (executor.py:463+) that marks the row failed should also route through `settle_task_terminal(status="failed")` so a failed child decrements its parent. Update it similarly.

- [ ] **Step 4: Run to verify it passes** + run the whole executor suite: `uv run pytest tests/test_executor.py -q`.

- [ ] **Step 5: Commit**

```bash
git add services/agent-py/src/agent_py/executor.py services/agent-py/tests/test_executor.py
git commit -m "feat(agent-py): settle tasks via the join barrier (children decrement parent)"
```

---

### Task 9: Fan-in resume (execute_continue)

**Files:** Modify `executor.py`; Test `tests/test_executor.py` (append).

- [ ] **Step 1: Read** `execute_continue` (executor.py:171-237) — how it loads the checkpoint, seeds the emitter, and extracts `live_messages`.

- [ ] **Step 2: Write the failing test** — append a test: `execute_continue` with a checkpoint carrying `awaiting_children = {tool_call_id, children:[...]}`, stubbing `store.load_child_results` → two `ChildResult`s. Assert that before the loop runs, a `tool_result` message for `tool_call_id` (containing the aggregated text) is appended to the live messages, and `awaiting_children` is removed from the checkpoint passed onward. (Inject a synthetic step fn that records the messages it sees + returns `done=True`.)

- [ ] **Step 3: Run to verify it fails.**

- [ ] **Step 4: Implement.** In `execute_continue`, after the checkpoint is loaded and `live_messages` extracted, before constructing the step fn / running the loop, add:

```python
        awaiting = checkpoint.get("awaiting_children")
        if isinstance(awaiting, dict):
            tool_call_id = str(awaiting.get("tool_call_id") or "")
            results = await store.load_child_results(
                pool, parent_task_id=payload.run_id, user_id=payload.user_id
            )
            tool_result_text = aggregate_child_results(results)
            live_messages.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": tool_result_text,
                }],
            })
            checkpoint = {k: v for k, v in checkpoint.items() if k != "awaiting_children"}
```

Add imports: `from agent_py.aggregate import aggregate_child_results`. Ensure the mutated `checkpoint` (without `awaiting_children`) is what flows into `_build_checkpoint` / the step fn so the marker isn't re-processed.

> NOTE: confirm `live_messages` is the same list the step fn reads + that appending here lands before the first `run_step`. Mirror how `execute_respond` injects its tool_result (executor.py:884-905) — that is the proven analog; copy its message-shape exactly.

- [ ] **Step 5: Run to verify it passes.**

- [ ] **Step 6: Commit**

```bash
git add services/agent-py/src/agent_py/executor.py services/agent-py/tests/test_executor.py
git commit -m "feat(agent-py): fan-in — inject aggregated child results on parent resume"
```

---

### Task 10: Cancel cascade (Next route)

**Files:** Modify `app/api/tasks/[id]/cancel/route.ts`, `lib/server/agent/store.ts`; Test `app/api/tasks/[id]/cancel/route.test.ts` (new, if testable) — else rely on manual smoke + typecheck.

- [ ] **Step 1: Read** `app/api/tasks/[id]/cancel/route.ts` (the cancel flow) + `lib/server/agent/store.ts` (the Supabase client helpers, `updateRun`).

- [ ] **Step 2: Implement** a helper in `lib/server/agent/store.ts`:

```typescript
/** Cancel all not-yet-settled children of a cancelled parent task. */
export async function cancelChildTasks(
  db: SupabaseClient<Database>,
  parentId: string,
  userId: string
): Promise<void> {
  await db
    .from("tasks")
    .update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("parent_task_id", parentId)
    .eq("user_id", userId)
    .not("status", "in", "(done,failed,cancelled)")
}
```

(Match the file's existing import of the Supabase client type + `Database`.) In `cancel/route.ts`, after the existing `updateRun(..., status: "cancelled")` call (route.ts:48), add `await cancelChildTasks(db, id, userId)`.

- [ ] **Step 3: Typecheck** — `cd /Users/blackmount8/_repository/hummingbird-subagents2 && bun run typecheck 2>&1 | tail -5` → clean.

- [ ] **Step 4: Commit**

```bash
git add app/api/tasks/[id]/cancel/route.ts lib/server/agent/store.ts
git commit -m "feat(tasks): cancel cascade — cancel unsettled children with the parent"
```

---

### Task 11: Full gate

**Files:** none (verification only).

- [ ] **Step 1: Auto-format + agent-py gate**

```bash
cd /Users/blackmount8/_repository/hummingbird-subagents2/services/agent-py
uv run ruff format . && uv run ruff check --fix .
cd /Users/blackmount8/_repository/hummingbird-subagents2 && bun run check:agent-py
```
Expected: ruff + format + mypy clean; pytest all pass (incl. the new spawn/fan-out/fan-in tests).

- [ ] **Step 2: repo TS gate**

Run: `cd /Users/blackmount8/_repository/hummingbird-subagents2 && bun run check`
Expected: typecheck clean, lint 0 errors, tests pass.

- [ ] **Step 3: Commit any gate fixes** (only if needed)

```bash
git add -A && git commit -m "chore: gate fixes for subagent PR-2" || echo "nothing to commit"
```

---

## Notes for the PR description

- PR-2 of `docs/PLAN-subagent-orchestration.md`, **agent-py only** (agent-ts deferred — drifted job schema, flagged in PR-1).
- Full spawn loop: `spawnSubagent` gated tool → `spawn` step outcome → executor fan-out (children + `pending_children` + yield) → PR-1 barrier settles children + re-enqueues parent → fan-in injects aggregated child results as the spawn tool_result → parent synthesises.
- Caps: depth 1 (a child can't spawn), breadth `MAX_CHILDREN` (env `MAX_SPAWN_CHILDREN`, default 5). Cancel cascades to children.
- **v1 children run the parent's config** pinned to their subgoal; true persona-pinning (slug → model/prompt) is a noted follow-up (no confirmed server-side personas table).
- **Verification caveat:** unit tests mock the DB + model, proving control flow + message/SQL shapes, not live concurrency or atomicity. The model-actually-spawns end-to-end needs a live `ANTHROPIC_API_KEY` + Postgres smoke (deferred).
- Several tasks carry NOTEs to confirm exact field names/sources against the real code (result-event text field, conversationId source) — the implementer verifies these while implementing.
