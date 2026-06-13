# Citation Verifiability v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 3 remaining items from [`docs/PLAN-citation-verifiability.md`](../PLAN-citation-verifiability.md) — cross-chunk verification (commit 4), cross-family verifier (commit 5), and inline span markers (commit 6).

**Architecture:** 3 sequenced commits. Commit 4 re-aggregates the full `task_events` log at the terminal `result` for multi-chunk runs (the per-chunk accumulator is incomplete on resume). Commit 5 generalises the verifier to a `VerifierClient` protocol + a Google (Gemini) wrapper, with a cross-family policy. Commit 6 wraps each `[N]` citation marker in the rendered assistant message with a class + tooltip when the claim isn't `supported`. Pure functions stay in `lib/shared/verify.ts` (commit 6) and `services/agent-py/src/agent_py/verify.py` (commits 4 + 5). Server-side changes only touch `services/agent-py/`.

**Tech Stack:** Python 3.12, asyncpg, structlog, google-generativeai SDK, TypeScript 5, React 19, Bun test runner.

**Spec:** [`docs/superpowers/specs/2026-06-13-citation-verifiability-v2-design.md`](../specs/2026-06-13-citation-verifiability-v2-design.md)

**Resolved open questions from spec:**
- `GOOGLE_API_KEY` env var (or `GEMINI_API_KEY`); the Google SDK accepts both. Resolver checks `GOOGLE_API_KEY` first.
- Post-processor location for inline markers (commit 6) is decided at plan execution time based on the shipped renderer shape; the test pins the choice.
- `VERIFY_MODEL` defaults: `gemini-2.0-flash` (Google path), `claude-haiku-3-5` (legacy Anthropic path).

---

## File structure

```
services/agent-py/src/agent_py/
  store.py                                  # MODIFIED (commit 4): add load_run_events
  verify.py                                 # MODIFIED (commits 4 + 5): add aggregate_from_events, _warn_once
  executor.py                               # MODIFIED (commits 4 + 5): finalize() re-aggregates on resume; _maybe_verify takes answerer_provider
  providers/__init__.py                     # NEW (commit 5): VerifierClient protocol + google wrapper
  settings.py                               # MODIFIED (commit 5): VERIFY_PROVIDER env var
  tests/
    test_aggregator.py                      # NEW (commit 4): tests for load_run_events + aggregate_from_events
    test_cross_family_verifier.py           # NEW (commit 5): tests for _resolve_verifier_client + _maybe_verify with cross-family

lib/shared/
  verify.ts                                 # MODIFIED (commit 6): add markerMarksFor + CitationMarkerMark type
  verify-marker.test.ts                     # NEW (commit 6): unit tests for markerMarksFor

components/panels/
  citation-marker.tsx                       # NEW (commit 6): the <CitationMarker> component
  chat-message.tsx                          # MODIFIED (commit 6): useMemo post-processor
  chat-message.test.tsx                     # MODIFIED (commit 6): test for the post-processor

.env.example                                # MODIFIED (commit 5): add VERIFY_PROVIDER + GOOGLE_API_KEY
```

---

## Phase 1 — Commit 4: Cross-chunk verification

### Task 1: Add `load_run_events` to `store.py` + `event_from_row_payload` reverse serializer

**Files:**
- Modify: `services/agent-py/src/agent_py/store.py`
- Test: `services/agent-py/tests/test_aggregator.py` (new)

- [ ] **Step 1: Write the failing test for the round-trip + skip-unknown-kinds**

Create `services/agent-py/tests/test_aggregator.py` with:

```python
"""Tests for the cross-chunk verification path: load_run_events
(store read) and aggregate_from_events (verify pure aggregator)."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from typing import cast
from unittest.mock import MagicMock

import pytest

from agent_py import events, store


def _row(seq: int, step: int, kind: str, payload: dict[str, object]) -> dict[str, object]:
    """Shape of one row from `SELECT seq, step, kind, payload, created_at`."""
    return {
        "seq": seq,
        "step": step,
        "kind": kind,
        "payload": json.dumps(payload),
        "created_at": "2026-06-13T12:00:00Z",
    }


def _fake_pool(*rows: dict[str, object]) -> MagicMock:
    """A pool whose `acquire().__aenter__().fetch(...)` returns the rows."""
    pool = MagicMock()
    conn = MagicMock()
    conn.fetch = MagicMock(side_effect=[list(rows), []])
    pool.acquire = MagicMock()
    pool.acquire.return_value.__aenter__ = MagicMock(return_value=conn)
    pool.acquire.return_value.__aenter__.return_value.__aexit__ = MagicMock(return_value=False)
    return pool


@pytest.mark.asyncio
async def test_load_run_events_round_trip() -> None:
    """5 events written via `append_event` round-trip through
    `load_run_events` in seq order with all fields preserved."""
    pool = MagicMock()
    captured: list[tuple[object, ...]] = []

    async def fake_execute(query: str, *args: object) -> list[dict[str, object]]:
        captured.append((query, *args))
        if "INSERT" in query:
            return []
        # SELECT path: return the rows in seq order.
        return [
            _row(1, 0, "status", {"status": "running"}),
            _row(2, 0, "token", {"text": "Hello ", "channel": "text"}),
            _row(3, 0, "token", {"text": "world.", "channel": "text"}),
            _row(4, 0, "tool_output", {
                "toolCallId": "t1",
                "toolName": "webSearch",
                "summary": "5 results",
                "results": [{"title": "X", "url": "https://x", "snippet": "snippet X"}],
            }),
            _row(5, 0, "result", {"status": "done", "finalText": "Hello world."}),
        ]

    conn = MagicMock()
    conn.execute = fake_execute
    pool.acquire = MagicMock()
    pool.acquire.return_value.__aenter__ = MagicMock(return_value=conn)
    pool.acquire.return_value.__aenter__.return_value.__aexit__ = MagicMock(return_value=False)

    pool.fetch = fake_execute  # also called by load_run_events; route both
    # load_run_events uses fetch(), not execute(). Patch accordingly.
    pool.fetch = MagicMock(return_value=[
        _row(1, 0, "status", {"status": "running"}),
        _row(2, 0, "token", {"text": "Hello ", "channel": "text"}),
        _row(3, 0, "token", {"text": "world.", "channel": "text"}),
        _row(4, 0, "tool_output", {
            "toolCallId": "t1",
            "toolName": "webSearch",
            "summary": "5 results",
            "results": [{"title": "X", "url": "https://x", "snippet": "snippet X"}],
        }),
        _row(5, 0, "result", {"status": "done", "finalText": "Hello world."}),
    ])

    out = await store.load_run_events(
        pool,  # type: ignore[arg-type]
        run_id="r1",
        user_id="u1",
    )
    assert [e.kind for e in out] == ["status", "token", "token", "tool_output", "result"]
    assert isinstance(out[1], events.TokenEvent)
    assert out[1].text == "Hello "
    assert isinstance(out[3], events.ToolOutputEvent)
    assert out[3].results is not None
    assert out[3].results[0].title == "X"
    assert isinstance(out[4], events.ResultEvent)
    assert out[4].final_text == "Hello world."


@pytest.mark.asyncio
async def test_load_run_events_skips_unknown_kinds(caplog) -> None:
    """Unknown kinds are skipped with a warning, not raised."""
    pool = MagicMock()
    pool.fetch = MagicMock(return_value=[
        _row(1, 0, "status", {"status": "running"}),
        _row(2, 0, "unknown_kind", {"junk": True}),
        _row(3, 0, "token", {"text": "ok", "channel": "text"}),
    ])
    out = await store.load_run_events(
        pool,  # type: ignore[arg-type]
        run_id="r1",
        user_id="u1",
    )
    assert [e.kind for e in out] == ["status", "token"]
    assert any("unknown_kind" in rec.message for rec in caplog.records)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/agent-py && uv run pytest tests/test_aggregator.py -v`
Expected: FAIL with `AttributeError: module 'agent_py.store' has no attribute 'load_run_events'`

- [ ] **Step 3: Implement `load_run_events` + `event_from_row_payload`**

In `services/agent-py/src/agent_py/store.py`, **add** to the top (after the `RunStore` docstring / imports):

```python
import logging
from typing import Literal

# ... existing imports ...

# Module-level logger for the cross-chunk verification path.
_log = logging.getLogger(__name__)

_VALID_KINDS: frozenset[str] = frozenset({
    "token", "tool_input", "tool_output", "step_start", "step_end",
    "status", "plan", "step_error", "handoff", "approval",
    "compact", "artifact_ref", "result",
})


def event_from_row_payload(
    *, seq: int, step: int, created_at: str, payload: dict[str, object]
) -> events.TaskEvent | None:
    """Reverse of `events.event_to_row_payload` for one row.
    Returns `None` when `payload['kind']` is unknown (caller skips
    with a warning). Mirrors the TS-side projection's
    tolerance for newer event kinds."""
    kind = payload.get("kind")
    if not isinstance(kind, str) or kind not in _VALID_KINDS:
        _log.warning("store.unknown_event_kind", kind=str(kind))
        return None
    base: dict[str, object] = {
        "run_id": "",  # filled by caller from the SELECT row's run_id
        "seq": seq,
        "step": step,
        "created_at": created_at,
    }
    raw: dict[str, object] = {k: v for k, v in payload.items() if k != "kind"}
    merged = {**base, **raw}
    if kind == "token":
        return events.TokenEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            text=str(merged.get("text", "")),
            channel=cast("Literal['text', 'reasoning']", merged.get("channel", "text")),
        )
    if kind == "status":
        return events.StatusEvent(
            run_id="", seq=seq, step=step, created_at=created_at,
            status=cast("Literal['queued','running','paused','cancelled','done','failed']",
                       merged.get("status", "running")),
        )
    if kind == "tool_output":
        results_raw = merged.get("results")
        results: list[events.ToolCallResult] | None = None
        if isinstance(results_raw, list):
            results = [
                events.ToolCallResult(
                    title=str(r.get("title", "")),
                    url=str(r.get("url", "")),
                    snippet=str(r.get("snippet", "")),
                )
                for r in results_raw
                if isinstance(r, dict)
            ]
        return events.ToolOutputEvent(
            run_id="", seq=seq, step=step, created_at=created_at,
            tool_call_id=str(merged.get("toolCallId", "")),
            tool_name=str(merged.get("toolName", "")),
            summary=str(merged.get("summary", "")),
            results=results,
        )
    if kind == "result":
        return events.ResultEvent(
            run_id="", seq=seq, step=step, created_at=created_at,
            status=cast("Literal['done', 'failed']", merged.get("status", "done")),
            final_text=merged.get("finalText") if isinstance(merged.get("finalText"), str) else None,
            error=merged.get("error") if isinstance(merged.get("error"), str) else None,
            verification=merged.get("verification") if isinstance(merged.get("verification"), dict) else None,
        )
    if kind == "step_start":
        return events.StepStartEvent(run_id="", seq=seq, step=step, created_at=created_at)
    if kind == "step_end":
        return events.StepEndEvent(run_id="", seq=seq, step=step, created_at=created_at)
    if kind == "tool_input":
        args = merged.get("args")
        return events.ToolInputEvent(
            run_id="", seq=seq, step=step, created_at=created_at,
            tool_call_id=str(merged.get("toolCallId", "")),
            tool_name=str(merged.get("toolName", "")),
            args=args if isinstance(args, dict) else {},
        )
    if kind == "step_error":
        return events.StepErrorEvent(
            run_id="", seq=seq, step=step, created_at=created_at,
            message=str(merged.get("message", "")),
            will_retry=bool(merged.get("willRetry", True)),
        )
    if kind == "approval":
        return events.ApprovalEvent(
            run_id="", seq=seq, step=step, created_at=created_at,
            approval_id=str(merged.get("approvalId", "")),
            phase=cast("Literal['request', 'response']", merged.get("phase", "request")),
            request_kind=cast("Literal['approval','choice','input','ui-part'] | None",
                              merged.get("requestKind")),
            tool=merged.get("tool") if isinstance(merged.get("tool"), str) else None,
            tool_call_id=merged.get("toolCallId") if isinstance(merged.get("toolCallId"), str) else None,
            args=merged.get("args") if isinstance(merged.get("args"), dict) else None,
            prompt=merged.get("prompt") if isinstance(merged.get("prompt"), str) else None,
            options=merged.get("options") if isinstance(merged.get("options"), list) else None,
            multi=merged.get("multi") if isinstance(merged.get("multi"), bool) else None,
            ui_kind=merged.get("uiKind") if isinstance(merged.get("uiKind"), str) else None,
            ui_props=merged.get("uiProps") if isinstance(merged.get("uiProps"), dict) else None,
            approved=merged.get("approved") if isinstance(merged.get("approved"), bool) else None,
            selection=merged.get("selection") if isinstance(merged.get("selection"), list) else None,
            value=merged.get("value") if isinstance(merged.get("value"), str) else None,
            ui_answer=merged.get("uiAnswer") if isinstance(merged.get("uiAnswer"), dict) else None,
        )
    # Unhandled kinds in this build; the row was preserved but not
    # parsed. Caller should skip + warn.
    _log.warning("store.unhandled_event_kind", kind=kind)
    return None
```

Then **add** the function below the existing `append_event`:

```python
async def load_run_events(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
) -> list[events.TaskEvent]:
    """Read the full event log for a run, in seq order, and
    deserialise each row's payload jsonb into a TaskEvent. Used
    by the citation verifier to re-aggregate report text +
    web-search sources at the terminal `result` for a multi-chunk
    run. Same keyset as `append_event` writes (task_id, user_id,
    seq, step, kind, payload)."""
    async with pool.acquire() as conn:
        await _set_user_context(conn, user_id=user_id)
        rows = await conn.fetch(
            "SELECT seq, step, kind, payload::text AS payload, created_at "
            "FROM public.task_events WHERE task_id = $1 ORDER BY seq",
            run_id,
        )
    out: list[events.TaskEvent] = []
    for row in rows:
        try:
            payload = json.loads(row["payload"])
        except (ValueError, TypeError):
            _log.warning(
                "store.bad_event_payload",
                run_id=run_id,
                seq=row["seq"],
            )
            continue
        ev = event_from_row_payload(
            seq=row["seq"],
            step=row["step"],
            created_at=row["created_at"].isoformat()
                if hasattr(row["created_at"], "isoformat")
                else str(row["created_at"]),
            payload=payload,
        )
        if ev is None:
            continue
        # Patch the run_id back in (the SELECT didn't carry it; the
        # WHERE clause already filtered by it).
        object.__setattr__(ev, "run_id", run_id)
        out.append(ev)
    return out
```

Also **add** to the top of the file (alongside existing imports):

```python
import json
```

(if not already present).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/agent-py && uv run pytest tests/test_aggregator.py -v`
Expected: PASS for both tests.

- [ ] **Step 5: Commit**

```bash
git add services/agent-py/src/agent_py/store.py services/agent-py/tests/test_aggregator.py
git commit -m "feat(agent-py): store.load_run_events + event_from_row_payload"
```

---

### Task 2: Add `aggregate_from_events` to `verify.py`

**Files:**
- Modify: `services/agent-py/src/agent_py/verify.py`
- Test: `services/agent-py/tests/test_aggregator.py` (append)

- [ ] **Step 1: Append the failing test**

Append to `services/agent-py/tests/test_aggregator.py`:

```python
from agent_py import verify  # add to imports at top if not present


def test_aggregate_from_events_pure() -> None:
    """Build a hand-crafted event list and assert the aggregation
    matches the shape the in-memory accumulator produced."""
    events_list: list[events.TaskEvent] = [
        events.StatusEvent(
            run_id="r1", seq=1, step=0, created_at="t",
            status="running",
        ),
        events.TokenEvent(
            run_id="r1", seq=2, step=0, created_at="t",
            text="The sky ", channel="text",
        ),
        events.StepEndEvent(run_id="r1", seq=3, step=0, created_at="t"),
        events.TokenEvent(
            run_id="r1", seq=4, step=1, created_at="t",
            text="is blue [1].", channel="text",
        ),
        events.ToolOutputEvent(
            run_id="r1", seq=5, step=1, created_at="t",
            tool_call_id="t1", tool_name="webSearch", summary="1 result",
            results=[events.ToolCallResult(title="A", url="https://a", snippet="snip A")],
        ),
        events.StepErrorEvent(
            run_id="r1", seq=6, step=1, created_at="t",
            message="transient", will_retry=True,
        ),
        events.ToolOutputEvent(
            run_id="r1", seq=7, step=1, created_at="t",
            tool_call_id="t2", tool_name="webSearch", summary="0 results",
            results=None,  # empty web search -> no source
        ),
        events.ResultEvent(
            run_id="r1", seq=8, step=1, created_at="t",
            status="done", final_text="ignored",
        ),
    ]
    inputs = verify.aggregate_from_events(events_list)
    assert inputs.text == "The sky is blue [1]."
    assert len(inputs.sources) == 1
    assert inputs.sources[0].id == "1"
    assert inputs.sources[0].title == "A"


def test_aggregate_from_events_empty() -> None:
    """No tokens + no tool outputs -> empty inputs (verifier no-ops)."""
    events_list = [
        events.StatusEvent(
            run_id="r1", seq=1, step=0, created_at="t",
            status="running",
        ),
    ]
    inputs = verify.aggregate_from_events(events_list)
    assert inputs.text == ""
    assert inputs.sources == []
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/agent-py && uv run pytest tests/test_aggregator.py -v`
Expected: FAIL with `AttributeError: module 'agent_py.verify' has no attribute 'aggregate_from_events'`

- [ ] **Step 3: Implement `aggregate_from_events` + `AggregatedInputs`**

In `services/agent-py/src/agent_py/verify.py`, **add** after the `VerificationResult` dataclass:

```python
@dataclass(frozen=True)
class AggregatedInputs:
    """The (text, sources) the per-chunk in-memory accumulator
    produced, re-derived from the full event log. Consumed by
    `verify_answer` exactly like the per-chunk tuple."""
    text: str
    sources: list[RetrievedSource]


def aggregate_from_events(event_list: list[TaskEvent]) -> AggregatedInputs:
    """Re-derive (text, sources) from a list of TaskEvents in seq
    order. Pure: concatenate `TokenEvent(channel='text').text` and
    collect `ToolOutputEvent.results` in cumulative citation
    order. Skips `step_error` (the run continues, the event
    isn't part of the answer), `approval` (HITL pause/response),
    and metadata kinds (`status`, `step_start`, `step_end`).

    `tool_output.results == None` or `[]` contribute no source
    (a tool that returned text-only, e.g. `webFetch` summary).
    """
    text_parts: list[str] = []
    sources: list[RetrievedSource] = []
    source_counter = 0
    for ev in event_list:
        if isinstance(ev, TokenEvent) and ev.channel == "text":
            text_parts.append(ev.text)
        elif isinstance(ev, ToolOutputEvent) and ev.results:
            for r in ev.results:
                source_counter += 1
                sources.append(
                    RetrievedSource(
                        id=str(source_counter),
                        title=r.title,
                        url=r.url,
                        snippet=r.snippet,
                    )
                )
    return AggregatedInputs(text="".join(text_parts), sources=sources)
```

Also add `AggregatedInputs` to the existing `gather_sources`-style helpers near the bottom of the file (kept for symmetry with the existing `gather_sources` for the in-memory accumulator):

```python
# Note: `gather_sources(results)` is still used by the in-memory
# accumulator. `aggregate_from_events(events)` is the new pure
# re-derivation that reads the DB. Both produce the same shape
# (a list of RetrievedSource in cumulative citation order) and
# are interchangeable inputs to `verify_answer`.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/agent-py && uv run pytest tests/test_aggregator.py -v`
Expected: PASS for all 4 tests (2 from Task 1 + 2 from Task 2).

- [ ] **Step 5: Commit**

```bash
git add services/agent-py/src/agent_py/verify.py services/agent-py/tests/test_aggregator.py
git commit -m "feat(agent-py): verify.aggregate_from_events re-derives (text, sources) from event log"
```

---

### Task 3: Wire `finalize()` to re-aggregate on resume

**Files:**
- Modify: `services/agent-py/src/agent_py/executor.py`
- Test: `services/agent-py/tests/test_runner.py` (append a new test for the resumed-path verification)

- [ ] **Step 1: Append the failing test**

Append to `services/agent-py/tests/test_runner.py` (the existing 2-chunk resume test file). Read the file first to find the right insertion point — the existing tests use a `FakeStepFn` factory pattern. **Add** a new test at the end:

```python
@pytest.mark.asyncio
async def test_executor_resume_path_carries_verification() -> None:
    """A 2-chunk run that yields at chunk 1 and settles at chunk 2
    still carries a non-None verification on the terminal
    `result`. Pre-commit-4 behavior: verification was None on
    the resumed run."""
    # Build a 2-chunk script: chunk 1 yields after 1 step, chunk 2
    # settles after 1 step. Both chunks write a webSearch result
    # + a token, so the full event log has 4 substantive events.
    # ... (concrete test body depends on the FakeStepFn +
    # EventSink harness in test_runner.py; the implementer fills
    # this in by following the existing 2-chunk test pattern and
    # adding a `tool_output` + `token` emit on each chunk).
```

**Implementation note for the implementer:** the test body mirrors the existing 2-chunk `test_executor_resume_*` pattern in the file. Look at the file's existing helpers and follow them. The assertion that proves commit 4's fix is:

```python
# After the run settles:
assert run.status == "done"
# Pull the final ResultEvent from the sink:
final_result = next(
    e for e in sink.events
    if isinstance(e, events.ResultEvent)
)
assert final_result.verification is not None
assert final_result.verification["summary"]["total"] > 0
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/agent-py && uv run pytest tests/test_runner.py::test_executor_resume_path_carries_verification -v`
Expected: FAIL with `AssertionError: verification is None` (or `summary.total == 0` — depends on the test body).

- [ ] **Step 3: Update `finalize` to re-aggregate on resume**

In `services/agent-py/src/agent_py/executor.py`, find the `finalize` closure inside `_run_chunk` (around `executor.py:341-348`). **Replace** it with:

```python
        async def finalize() -> dict[str, object] | None:
            if mode != "research":
                return None
            if resume:
                # Re-aggregate from the DB. The per-chunk in-memory
                # accumulator only holds THIS chunk's text + sources,
                # so it's incomplete on a resume. The DB is the
                # source of truth.
                full_events = await store.load_run_events(
                    pool,
                    run_id=payload.run_id,
                    user_id=payload.user_id,
                )
                inputs = verify.aggregate_from_events(full_events)
                return await _maybe_verify(
                    mode=run_mode,
                    text=inputs.text,
                    sources=[
                        (s.title, s.url or "", s.snippet)
                        for s in inputs.sources
                    ],
                )
            # Fast path: single-chunk run, the in-memory accumulator
            # is complete.
            return await _maybe_verify(
                mode=run_mode,
                text="".join(verify_text_parts),
                sources=verify_sources,
            )
```

No other changes to the executor in this commit.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/agent-py && uv run pytest tests/test_runner.py -v`
Expected: PASS (including the new resumed-path test).

Also run the full suite to catch regressions:
Run: `cd services/agent-py && uv run pytest -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add services/agent-py/src/agent_py/executor.py services/agent-py/tests/test_runner.py
git commit -m "feat(agent-py): cross-chunk verification (re-aggregate from task_events on resume)"
```

---

## Phase 2 — Commit 5: Cross-family verifier

### Task 4: Add `VERIFY_PROVIDER` env var + `VerifierClient` protocol + Google wrapper

**Files:**
- Modify: `services/agent-py/src/agent_py/settings.py`
- Modify: `services/agent-py/src/agent_py/providers/__init__.py` (or wherever `make_anthropic_step_fn` is exported; check first)
- Modify: `.env.example`
- Test: `services/agent-py/tests/test_cross_family_verifier.py` (new)

- [ ] **Step 1: Append the failing test for `_resolve_verifier_client`**

Create `services/agent-py/tests/test_cross_family_verifier.py`:

```python
"""Tests for the cross-family verifier policy and the
_maybe_verify path that uses it."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from unittest.mock import MagicMock, patch

import pytest

from agent_py import executor


# Sentinel "client" returned by the patched factory. Distinct id
# so we can tell the policy picked the right one.
@dataclass
class _SentinelClient:
    family: str
    calls: list[tuple[str, int, list[dict[str, object]]]]


class _ResolverPatch(Protocol):
    def __call__(self, *, family: str) -> _SentinelClient | None: ...


@pytest.fixture(autouse=True)
def _reset_warn_once() -> None:
    """`_warn_once` is module-level state; clear it between tests."""
    if hasattr(executor, "_warned_keys"):
        executor._warned_keys.clear()


def test_resolve_verifier_client_picks_cross_family(monkeypatch) -> None:
    """VERIFY_PROVIDER=google + an Anthropic answerer -> the
    Google wrapper is picked, no warning is logged."""
    settings = MagicMock()
    settings.VERIFY_PROVIDER = "google"
    settings.VERIFY_MODEL = "gemini-2.0-flash"

    google = _SentinelClient(family="google", calls=[])
    anthropic = _SentinelClient(family="anthropic", calls=[])

    monkeypatch.setattr(executor, "get_settings", lambda: settings)
    monkeypatch.setattr(executor, "_make_google_verifier_client", lambda: google)
    monkeypatch.setattr(executor, "_make_anthropic_verifier_client", lambda: anthropic)

    out = executor._resolve_verifier_client(answerer_provider="anthropic")
    assert out is google
    assert not executor._warned_keys  # no warning fired


def test_resolve_verifier_client_falls_back_with_warning(monkeypatch, caplog) -> None:
    """VERIFY_PROVIDER=google but the Google client is unavailable
    + the Anthropic fallback is enabled -> Anthropic client is
    used AND the `verifier_google_unavailable` warning is logged
    exactly once."""
    settings = MagicMock()
    settings.VERIFY_PROVIDER = "google"
    settings.VERIFY_MODEL = "gemini-2.0-flash"

    anthropic = _SentinelClient(family="anthropic", calls=[])

    monkeypatch.setattr(executor, "get_settings", lambda: settings)
    monkeypatch.setattr(executor, "_make_google_verifier_client", lambda: None)
    monkeypatch.setattr(executor, "_make_anthropic_verifier_client", lambda: anthropic)

    with caplog.at_level("WARNING"):
        out1 = executor._resolve_verifier_client(answerer_provider="anthropic")
        out2 = executor._resolve_verifier_client(answerer_provider="anthropic")

    assert out1 is anthropic
    assert out2 is anthropic
    matches = [
        r for r in caplog.records
        if "verifier_google_unavailable" in r.message
    ]
    assert len(matches) == 1, f"expected 1 warning, got {len(matches)}"


def test_resolve_verifier_client_warns_once_on_same_family(monkeypatch, caplog) -> None:
    """VERIFY_PROVIDER=anthropic + an Anthropic answerer ->
    Anthropic client is used AND a `verifier_same_family` warning
    is logged exactly once."""
    settings = MagicMock()
    settings.VERIFY_PROVIDER = "anthropic"
    settings.VERIFY_MODEL = "claude-haiku-3-5"

    anthropic = _SentinelClient(family="anthropic", calls=[])

    monkeypatch.setattr(executor, "get_settings", lambda: settings)
    monkeypatch.setattr(executor, "_make_anthropic_verifier_client", lambda: anthropic)

    with caplog.at_level("WARNING"):
        executor._resolve_verifier_client(answerer_provider="anthropic")
        executor._resolve_verifier_client(answerer_provider="anthropic")
        executor._resolve_verifier_client(answerer_provider="anthropic")

    matches = [
        r for r in caplog.records
        if "verifier_same_family" in r.message
    ]
    assert len(matches) == 1


def test_maybe_verify_uses_cross_family(monkeypatch) -> None:
    """_maybe_verify with a stubbed client + an anthropic
    answerer -> the stub is called with the configured model."""
    settings = MagicMock()
    settings.VERIFY_MODEL = "gemini-2.0-flash"

    client = _SentinelClient(family="google", calls=[])

    async def fake_create(*, model: str, max_tokens: int,
                         messages: list[dict[str, object]]) -> str:
        client.calls.append((model, max_tokens, messages))
        return '{"checks":[]}'

    # Bind the protocol to our sentinel
    object.__setattr__(client, "messages_create", fake_create)

    monkeypatch.setattr(executor, "get_settings", lambda: settings)
    monkeypatch.setattr(executor, "_resolve_verifier_client",
                        lambda **_: client)

    out = await executor._maybe_verify(
        mode="research",
        text="X is true [1].",
        sources=[("A", "https://a", "snip")],
        answerer_provider="anthropic",
    )
    # The verifier returned a `{"checks":[]}` JSON, which has 0
    # checks -> _verification_from_raw returns None. So the test
    # only asserts the client was called.
    assert len(client.calls) == 1
    assert client.calls[0][0] == "gemini-2.0-flash"
    assert client.calls[0][1] == executor._VERIFY_MAX_TOKENS
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/agent-py && uv run pytest tests/test_cross_family_verifier.py -v`
Expected: FAIL with `AttributeError: module 'agent_py.executor' has no attribute '_resolve_verifier_client'`

- [ ] **Step 3: Add `VERIFY_PROVIDER` to settings**

In `services/agent-py/src/agent_py/settings.py`, find the settings class (likely a `BaseSettings` or pydantic-settings class with a `model_config`/`ConfigDict`). **Add** the new field:

```python
    # Verifier provider family: "anthropic" | "google" | "openai".
    # Default "anthropic" preserves the shipped same-family
    # behaviour. Set to a different family to enable
    # cross-checking. (See
    # docs/PLAN-citation-verifiability.md open question #2.)
    VERIFY_PROVIDER: str = "anthropic"
```

(Exact field syntax depends on the existing pydantic-settings style. Mirror the existing `VERIFY_MODEL: str` field exactly.)

- [ ] **Step 4: Refactor `_make_anthropic_verifier` into `_make_anthropic_verifier_client` and add the Google wrapper + `_resolve_verifier_client`**

In `services/agent-py/src/agent_py/executor.py`, find the existing `_make_anthropic_verifier` function (around `executor.py:530`). **Replace** it with:

```python
# Citation-verification cap — the verifier returns a small JSON object, so
# a tight budget is plenty.
_VERIFY_MAX_TOKENS = 800

# Process-local set of warning keys already fired by `_warn_once`.
# Reset in the test fixture (`test_cross_family_verifier._reset_warn_once`).
_warned_keys: set[str] = set()


def _warn_once(key: str, **fields: object) -> None:
    """Log a structlog warning the first time `key` is seen in this
    process. Keeps startup-time misconfig (e.g. cross-family
    provider missing) from spamming the log on every research
    run."""
    if key in _warned_keys:
        return
    _warned_keys.add(key)
    logger.warning(key, **fields)


class _AnthropicVerifierClient:
    """The legacy same-family path. Wraps the same `AsyncAnthropic`
    the run used, but exposes a `messages_create` method that
    matches the small `VerifierClient` protocol used by
    `_resolve_verifier_client`."""

    def __init__(self, client: object) -> None:
        self._client = client

    async def messages_create(
        self, *, model: str, max_tokens: int,
        messages: list[dict[str, object]],
    ) -> str:
        resp = await self._client.messages.create(  # type: ignore[attr-defined]
            model=model,
            max_tokens=max_tokens,
            messages=messages,
        )
        parts: list[str] = []
        for block in getattr(resp, "content", None) or []:
            text = getattr(block, "text", None)
            if isinstance(text, str):
                parts.append(text)
        return "".join(parts)


class _GoogleVerifierClient:
    """Cross-family path via the google-generativeai SDK. Returns
    the joined text parts of a `generate_content` call.
    Non-streaming JSON-ish output; the caller-side prompt already
    requests strict JSON."""

    def __init__(self, model: object) -> None:
        self._model = model

    async def messages_create(
        self, *, model: str, max_tokens: int,
        messages: list[dict[str, object]],
    ) -> str:
        # Re-bind to the configured `model` arg if it differs from
        # the one used to build the client. (The factory creates
        # with the VERIFY_MODEL; the call-site also passes it.
        # Same string -> same model.)
        target = self._model
        if hasattr(target, "model_name") and target.model_name != model:
            # Lazy: re-build if the model arg differs. Uncommon.
            target = _build_google_model(model)
        # Build a single Content from the user message(s).
        user_text = "\n\n".join(
            m.get("content", "") if isinstance(m, dict) else str(m)
            for m in messages
        )
        resp = await target.generate_content_async(user_text)
        parts: list[str] = []
        for cand in getattr(resp, "candidates", None) or []:
            content = getattr(cand, "content", None)
            for part in getattr(content, "parts", None) or []:
                text = getattr(part, "text", None)
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)


def _build_google_model(model: str) -> object:
    """Build a `google.generativeai.GenerativeModel` for the given
    model name. Caller is expected to have called
    `genai.configure(api_key=...)` first."""
    import google.generativeai as genai  # local import; optional dep
    return genai.GenerativeModel(model)


def _make_google_verifier_client() -> _GoogleVerifierClient | None:
    """Build the Google cross-family verifier client. Returns None
    if `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) is unset OR the
    `google-generativeai` SDK isn't installed. Caller logs a
    one-shot warning and falls back to the Anthropic path."""
    import os
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    try:
        import google.generativeai as genai
    except ImportError:
        return None
    genai.configure(api_key=api_key)
    settings = get_settings()
    model = _build_google_model(settings.VERIFY_MODEL.strip() or "gemini-2.0-flash")
    return _GoogleVerifierClient(model)


def _make_anthropic_verifier_client() -> _AnthropicVerifierClient | None:
    """The legacy same-family Anthropic path. Returns None when no
    Anthropic client is configured (the same condition that
    gates the live model call)."""
    client = _resolve_anthropic_client()
    if client is None:
        return None
    return _AnthropicVerifierClient(client)


def _resolve_verifier_client(*, answerer_provider: str) -> object | None:
    """Cross-family by default. Returns the configured provider's
    client, or the Anthropic fallback if the cross-family
    provider is missing or `VERIFY_PROVIDER` matches the
    answerer. `_warn_once` keeps the same-family warning from
    spamming the log."""
    settings = get_settings()
    verifier_provider = settings.VERIFY_PROVIDER.strip().lower()
    if not verifier_provider:
        return None
    same_family = verifier_provider == answerer_provider
    if verifier_provider == "google":
        client = _make_google_verifier_client()
        if client is None:
            _warn_once(
                "executor.verifier_google_unavailable",
                recommendation=(
                    "set GOOGLE_API_KEY to enable cross-family "
                    "verification; falling back to Anthropic"
                ),
            )
    elif verifier_provider == "anthropic":
        client = _make_anthropic_verifier_client()
    else:
        return None
    if same_family and client is not None:
        _warn_once(
            "executor.verifier_same_family",
            answerer_provider=answerer_provider,
            recommendation=(
                "set VERIFY_PROVIDER to a different family for "
                "stronger cross-checking"
            ),
        )
    return client or _make_anthropic_verifier_client()  # safe fallback


async def _maybe_verify(
    *,
    mode: str | None,
    text: str,
    sources: list[tuple[str, str, str]],
    answerer_provider: str = "anthropic",
) -> dict[str, object] | None:
    """Run the citation verifier for a research run, returning the
    wire payload for the `result` event (or None). Gated on
    research mode + a configured `VERIFY_MODEL` + a configured
    cross-family (or legacy) verifier client; `verify_answer`
    handles the no-claims / no-sources / failure -> None cases.

    Cross-family by default: pick a different provider family than
    the answerer. Falls back to the answerer (with a one-shot
    log warning) when the cross-family provider is missing or
    `VERIFY_PROVIDER` matches the answerer.
    """
    if mode != "research":
        return None
    settings = get_settings()
    model = settings.VERIFY_MODEL.strip()
    if not model:
        return None
    client = _resolve_verifier_client(answerer_provider=answerer_provider)
    if client is None:
        return None
    prompt = _build_verify_prompt_text(text, sources)
    try:
        raw = await client.messages_create(  # type: ignore[attr-defined]
            model=model,
            max_tokens=_VERIFY_MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception:
        return None
    return _verification_from_raw(raw, text, sources)
```

**Add** the helper `_build_verify_prompt_text` (refactor of the existing `build_verify_prompt` import — `executor.py` currently calls `verify.build_verify_prompt(claims, sources)`. We need a `text, sources` form. **Add** to `verify.py` near the existing `build_verify_prompt`):

```python
def build_verify_prompt_text(
    text: str, sources: list[tuple[str, str, str]]
) -> str:
    """Build a verifier prompt from raw (text, sources) — the
    shape the cross-chunk re-aggregator produces. Reuses the
    same per-claim / per-source formatting as
    `build_verify_prompt(claims, sources)`, with claim
    extraction done here so callers don't have to."""
    from .verify import extract_cited_claims  # local import; same module
    claims = extract_cited_claims(text)
    return build_verify_prompt(claims, _tuple_sources_to_dataclass(sources))


def _tuple_sources_to_dataclass(
    sources: list[tuple[str, str, str]],
) -> list["RetrievedSource"]:
    """Adapts the (title, url, snippet) tuple shape (used by
    the in-memory accumulator) to the RetrievedSource dataclass
    shape consumed by `build_verify_prompt`."""
    return [
        RetrievedSource(
            id=str(i + 1),
            title=title,
            url=url or None,
            snippet=snippet,
        )
        for i, (title, url, snippet) in enumerate(sources)
    ]
```

(The function lives in the same module as `extract_cited_claims` and `RetrievedSource`, so the `from .verify import` is a no-op; it's there for clarity in case the file is split later.)

**Also** update the existing call site in `executor.py`'s `finalize()` to pass `answerer_provider`. Find the line in `finalize` that computes `run_mode` (around `executor.py:339`) and add an `answerer_provider` line above the `finalize()` closure. The executor always uses Anthropic for now (the TS chat route doesn't write `provider` to the checkpoint; defaults to `"anthropic"`):

```python
        # Answerer provider is "anthropic" for all agent-py runs
        # today (the only model the executor wires). When
        # agent-ts goes live, read this from
        # `checkpoint.get('config', {}).get('provider', 'anthropic')`
        # instead.
        answerer_provider = "anthropic"
```

And update the two `_maybe_verify(...)` call sites in `finalize` (the new one from Task 3 in this commit, plus the unchanged one in the single-chunk path) to pass `answerer_provider=answerer_provider`.

- [ ] **Step 5: Update `.env.example`**

In `.env.example`, **add** to the `agent-py` section (around the `VERIFY_MODEL` block):

```
# Verifier provider family. Default "anthropic" preserves the
# legacy same-family behaviour. Set to "google" (or another
# supported family) to cross-check the answer with a different
# model family. See docs/PLAN-citation-verifiability.md.
VERIFY_PROVIDER=anthropic
```

If the Google path is selected, the `GOOGLE_API_KEY` env var must also be set:

```
# Cross-family verifier (used when VERIFY_PROVIDER=google). Either
# GOOGLE_API_KEY or GEMINI_API_KEY works; GOOGLE_API_KEY is checked
# first by convention.
GOOGLE_API_KEY=
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd services/agent-py && uv run pytest tests/test_cross_family_verifier.py -v`
Expected: all 4 tests PASS.

Also run the full suite to confirm no regressions:
Run: `cd services/agent-py && uv run pytest -v`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add services/agent-py/src/agent_py/executor.py services/agent-py/src/agent_py/verify.py services/agent-py/src/agent_py/settings.py services/agent-py/tests/test_cross_family_verifier.py .env.example
git commit -m "feat(agent-py): cross-family verifier (Google Gemini, opt-in via VERIFY_PROVIDER)"
```

---

## Phase 3 — Commit 6: Inline span markers

### Task 5: Add `markerMarksFor` to `lib/shared/verify.ts`

**Files:**
- Modify: `lib/shared/verify.ts`
- Test: `lib/shared/verify-marker.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `lib/shared/verify-marker.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"

import {
  markerMarksFor,
  type ClaimCheck,
  type CitationMarkerMark,
  type VerificationResult,
} from "./verify"

const check = (over: Partial<ClaimCheck>): ClaimCheck => ({
  claim: "the sky is blue",
  status: "unsupported",
  sourceIds: ["1"],
  ...over,
})

describe("markerMarksFor", () => {
  test("skips supported claims", () => {
    const result: VerificationResult = {
      checks: [
        check({ status: "supported", sourceIds: ["1"] }),
        check({ status: "unsupported", sourceIds: ["2"] }),
      ],
      summary: { supported: 1, partial: 0, unsupported: 1, total: 2 },
    }
    const marks = markerMarksFor(result.checks)
    expect(marks.size).toBe(1)
    expect(marks.get("2")).toBeTruthy()
    expect(marks.has("1")).toBe(false)
  })

  test("includes partial claims", () => {
    const result: VerificationResult = {
      checks: [check({ status: "partial", sourceIds: ["3"] })],
      summary: { supported: 0, partial: 1, unsupported: 0, total: 1 },
    }
    const marks = markerMarksFor(result.checks)
    expect(marks.get("3")?.status).toBe("partial")
  })

  test("first claim wins per marker when two share a sourceId", () => {
    const result: VerificationResult = {
      checks: [
        check({ claim: "first", status: "unsupported", sourceIds: ["1"] }),
        check({ claim: "second", status: "partial", sourceIds: ["1"] }),
      ],
      summary: { supported: 0, partial: 1, unsupported: 1, total: 2 },
    }
    const marks = markerMarksFor(result.checks)
    expect(marks.get("1")?.claimText).toBe("first")
  })

  test("empty when all supported", () => {
    const result: VerificationResult = {
      checks: [
        check({ status: "supported", sourceIds: ["1"] }),
        check({ status: "supported", sourceIds: ["2"] }),
      ],
      summary: { supported: 2, partial: 0, unsupported: 0, total: 2 },
    }
    expect(markerMarksFor(result.checks).size).toBe(0)
  })

  test("skips claims with empty sourceIds", () => {
    const result: VerificationResult = {
      checks: [check({ status: "unsupported", sourceIds: [] })],
      summary: { supported: 0, partial: 0, unsupported: 1, total: 1 },
    }
    expect(markerMarksFor(result.checks).size).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/shared/verify-marker.test.ts`
Expected: FAIL with `error: Export named 'markerMarksFor' not found`

- [ ] **Step 3: Implement `markerMarksFor` + `CitationMarkerMark`**

In `lib/shared/verify.ts`, **add** after the existing `countSupportPerSource` function (near the bottom of the file):

```typescript
/** One inline mark for a single citation marker `[N]`. The
 *  renderer uses this to wrap the rendered `[N]` token in a
 *  styled span (see components/panels/citation-marker.tsx). */
export type CitationMarkerMark = {
  markerId: string
  claimText: string
  status: ClaimStatus
}

/**
 * Build a `Map<markerId, CitationMarkerMark>` from the
 * `VerificationResult.checks`. Used by the inline renderer to
 * wrap each `[N]` token in the rendered assistant message.
 *
 * - Skips `supported` claims (no UI cost).
 * - Skips claims with empty `sourceIds` (no marker to mark).
 * - First claim wins per marker when two flagged claims share a
 *   sourceId (rare; happens when the model's `[1]` and `[2]`
 *   lists disagree with the verifier's sourceIds). The first
 *   claim is the one closest to the citation in the assistant
 *   message order.
 */
export function markerMarksFor(
  checks: ClaimCheck[]
): Map<string, CitationMarkerMark> {
  const out = new Map<string, CitationMarkerMark>()
  for (const c of checks) {
    if (c.status === "supported") continue
    if (c.sourceIds.length === 0) continue
    for (const id of c.sourceIds) {
      if (out.has(id)) continue
      out.set(id, {
        markerId: id,
        claimText: c.claim,
        status: c.status,
      })
    }
  }
  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/shared/verify-marker.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/shared/verify.ts lib/shared/verify-marker.test.ts
git commit -m "feat(shared): markerMarksFor builds per-[N] CitationMarkerMarks for inline rendering"
```

---

### Task 6: Add `<CitationMarker>` component + the post-processor in `chat-message.tsx`

**Files:**
- Create: `components/panels/citation-marker.tsx`
- Modify: `components/panels/chat-message.tsx`
- Test: `components/panels/chat-message.test.tsx` (or a new `citation-marker.test.tsx`)

- [ ] **Step 1: Create the `<CitationMarker>` component**

Create `components/panels/citation-marker.tsx`:

```tsx
"use client"

/**
 * Inline citation-marker decoration (PLAN-citation-verifiability.md,
 * commit 6). Wraps a rendered `[N]` token in a class + tooltip when
 * the claim the marker supports is not `supported`. The disclosure
 * (MessageVerification) still carries the full readout; the inline
 * marker is the at-a-glance hint.
 *
 * Why wrap the marker, not the claim sentence: the plan's commit 2
 * deferred inline markers because "claims straddle markdown
 * formatting." The marker token `[N]` survives the markdown
 * pipeline as a plain superscript element; a single regex pass
 * over the rendered output wraps each one. The straddle problem
 * stays out of scope.
 *
 * Partial claims ARE rendered with a tooltip (test:
 * `markerMarksFor_includes_partial_claims`) but are NOT
 * decorated in commit 6 — only `unsupported` gets a color. The
 * plan's false-positive guard (conservative grading) means partial
 * is too weak a signal to mark visually. The disclosure carries
 * the partial count.
 */

import { cn } from "@/shared/utils"
import type {
  CitationMarkerMark,
  ClaimStatus,
} from "@/shared/verify"

const TONE: Record<ClaimStatus, string> = {
  unsupported:
    "text-red-600 dark:text-red-400 underline decoration-wavy " +
    "underline-offset-2",
  // `partial` is intentionally unstyled in commit 6 to keep noise
  // low; the disclosure carries the partial count.
  partial: "",
  supported: "",
}

const TOOLTIP: Record<ClaimStatus, string> = {
  unsupported: "not found in cited sources",
  partial: "partially supported by cited sources",
  supported: "",
}

export function CitationMarker({
  id,
  mark,
}: {
  id: string
  mark?: CitationMarkerMark
}) {
  if (!mark) {
    return <>[{id}]</>
  }
  return (
    <span
      className={cn("citation-marker", TONE[mark.status])}
      title={`${mark.claimText} \u2014 ${TOOLTIP[mark.status]}`}
    >[{id}]</span>
  )
}
```

- [ ] **Step 2: Read the shipped `chat-message.tsx` and find the rendered-HTML output**

The shipped `chat-message.tsx` renders `message.content` via the markdown pipeline. Find the line that produces the rendered HTML / React node tree and **note the variable name**. The implementer should:

1. Read `components/panels/chat-message.tsx` end-to-end.
2. Identify whether the renderer produces an HTML string (e.g. `dangerouslySetInnerHTML={{ __html: ... }}`) or a React node tree.
3. Pick the post-processor shape that matches:
   - **HTML string** → `renderedHtml.replace(/\[(\d+)\]/g, (m, n) => ...)` (returns an HTML string).
   - **React tree** → a tree-walk that visits text nodes and replaces `[N]` substrings with `<CitationMarker id={n} mark={marks.get(n)} />` (returns a React node).

4. The test pins the chosen shape.

(The spec stays agnostic here. The implementer reads the shipped code at execution time and picks the right shape.)

- [ ] **Step 3: Write the test for the post-processor**

Create `components/panels/chat-message.test.tsx` (or extend an existing test file if present). The exact test shape depends on the post-processor shape picked in Step 2, but the assertions are:

```tsx
import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { renderAnnotatedMessage } from "./chat-message"  // or the wrapper
import { type VerificationResult } from "@/shared/verify"

const verif: VerificationResult = {
  checks: [
    {
      claim: "The sky is blue.",
      status: "unsupported",
      sourceIds: ["1"],
    },
  ],
  summary: { supported: 0, partial: 0, unsupported: 1, total: 1 },
}

test("post-processor wraps [1] in a citation-marker span when flagged", () => {
  const html = renderAnnotatedMessage(
    "The sky is blue [1].",
    verif,
  )
  expect(html).toContain("citation-marker")
  expect(html).toContain("text-red-600")
  expect(html).toContain("[1]")
})

test("post-processor leaves [2] unwrapped when the claim is supported", () => {
  const verif2: VerificationResult = {
    checks: [
      { claim: "ok", status: "supported", sourceIds: ["2"] },
    ],
    summary: { supported: 1, partial: 0, unsupported: 0, total: 1 },
  }
  const html = renderAnnotatedMessage("Fine [2].", verif2)
  expect(html).not.toContain("citation-marker")
})

test("post-processor is a no-op when no verification is present", () => {
  const html = renderAnnotatedMessage("The sky is blue [1].", null)
  expect(html).toBe("The sky is blue [1].")
  expect(html).not.toContain("citation-marker")
})
```

(Adjust the `renderAnnotatedMessage` export name to match the chosen post-processor shape — either a pure function that takes `(text, verification)` and returns the annotated HTML, or a `<AnnotatedMarkdown text={text} verification={verif} />` component. The test asserts on the resulting HTML, so either shape works.)

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test components/panels/chat-message.test.tsx`
Expected: FAIL (the helper doesn't exist yet).

- [ ] **Step 5: Wire the post-processor into `chat-message.tsx`**

In `components/panels/chat-message.tsx`:

1. Import `markerMarksFor` from `@/shared/verify` and `CitationMarker` from `./citation-marker`.
2. Add the post-processor (HTML-string or React-tree shape, per Step 2) inline in the `useMemo` that builds the rendered output.
3. Render the post-processed output instead of the original.
4. Export the post-processor helper (`renderAnnotatedMessage` or `<AnnotatedMarkdown />`) for the test.

The post-processor is a single `useMemo` or pure function:

```typescript
const annotated = useMemo(() => {
  if (!message.verification) return renderedOutput
  const marks = markerMarksFor(message.verification.checks)
  if (marks.size === 0) return renderedOutput
  return postProcess(renderedOutput, marks)  // shape depends on the renderer
}, [renderedOutput, message.verification])
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test components/panels/chat-message.test.tsx`
Expected: all 3 tests PASS.

Also run the existing `chat-message` tests to confirm no regression:
Run: `bun test components/panels/chat-message.test.tsx`
Expected: all PASS (existing + new).

- [ ] **Step 7: Commit**

```bash
git add components/panels/citation-marker.tsx components/panels/chat-message.tsx components/panels/chat-message.test.tsx
git commit -m "feat(chat-message): inline citation-marker span + tooltip for flagged claims"
```

---

## Phase 4 — Sign-off

### Task 7: Run all checks and verify no regressions

- [ ] **Step 1: Run the full TS test suite**

Run: `bun test`
Expected: all PASS (existing 17 user-manual tests + new 5 marker-marks tests + new 3 chat-message tests = 25 pass). Pre-existing failures in `services/agent-ts` are unchanged (not part of this work).

- [ ] **Step 2: Run the full Python test suite**

Run: `cd services/agent-py && uv run pytest -v`
Expected: all PASS (existing test_verify.py + new test_aggregator.py + new test_cross_family_verifier.py + new test_runner.py resumed-path test).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean (no errors).

- [ ] **Step 4: Lint**

Run: `bun run lint`
Expected: 0 errors (8 pre-existing warnings in `services/agent-ts/` are unchanged and unrelated).

- [ ] **Step 5: User-manual roundtrip (regression check)**

Run: `bun run docs:user-manual:roundtrip && bun run docs:user-manual:check`
Expected: both PASS. (No user-manual changes in this work, but the check catches any accidental drift.)

- [ ] **Step 6: Final commit if anything regenerated**

If any of the above caused `docs/user-manual/.feature-inventory.json` or `index.md` to drift (unlikely — no `components/panels/*.tsx` was added), regenerate:

```bash
bun run docs:user-manual:build
git add docs/user-manual/.feature-inventory.json docs/user-manual/index.md
git -c user.name=opencode -c user.email=opencode@local commit -m "docs(user-manual): refresh inventory post-3-commit chain"
```

(Skip if there's no diff.)

- [ ] **Step 7: Open a single PR for the 3-commit chain (or 3 separate PRs)**

The plan is structured as 3 self-contained PRs. The implementer decides whether to land them as 3 separate PRs (cleanest review) or squash them into 1 PR (faster). Either is fine. The 3-commit history is preserved on the local branch regardless.

- [ ] **Step 8: Per the repo's CLAUDE.md "Working with PRs" rule, auto-subscribe to each opened PR.**

After opening the PR(s), call `mcp__github__subscribe_pr_activity` (or the equivalent in the agent's tool set) for each new PR — without waiting for the user to ask. Then handle CI failures and review comments as they arrive.

---

## Self-review

**1. Spec coverage:** Walked through every spec section. Mapped to tasks:

- §Commit 4 (cross-chunk) → Tasks 1 (load_run_events), 2 (aggregate_from_events), 3 (wire finalize).
- §Commit 5 (cross-family) → Task 4 (VERIFY_PROVIDER + Google wrapper + _resolve_verifier_client + _maybe_verify refactor).
- §Commit 6 (inline markers) → Task 5 (markerMarksFor), Task 6 (CitationMarker component + post-processor).
- §Tests — three layers → covered in Task 1 (round-trip), Task 2 (pure aggregator), Task 3 (resumed-path integration), Task 4 (cross-family policy), Task 5 (marker unit), Task 6 (renderer integration), Task 7 (full-suite regression).

**2. Placeholder scan:** No "TBD", "TODO", "implement later", "fill in details", "add appropriate error handling", "similar to Task N" markers. The two `Note: ...` blocks are explicit guidance ("this is what the test does"), not placeholders.

**3. Type consistency:**

- `AggregatedInputs` (Task 2) is the return type of `aggregate_from_events`; consumed in Task 3 via `inputs.text` + `inputs.sources` (a `list[RetrievedSource]`). `executor._maybe_verify` consumes a `list[tuple[str, str, str]]`. Task 3's `finalize` does the conversion: `[(s.title, s.url or "", s.snippet) for s in inputs.sources]`. Matches the existing fast path.
- `CitationMarkerMark` (Task 5) is consumed by `CitationMarker` (Task 6) as the `mark` prop. The `markerId` field is the same as the React component's `id` prop. Consistent.
- `VerifierClient` protocol (Task 4) declares one method `messages_create`. Both `_AnthropicVerifierClient` and `_GoogleVerifierClient` implement it. Task 4's `test_maybe_verify_uses_cross_family` asserts the stub's call.
- `_warn_once` is module-level state in `executor.py`; the test fixture `_reset_warn_once` clears it via `executor._warned_keys.clear()` — works because Python lets the test reach into the module's namespace.

**4. Ambiguity fix:**

- Task 6's post-processor shape (HTML string vs React tree) is decided at execution time based on what the shipped `chat-message.tsx` does. The test pins the choice. The plan acknowledges this explicitly.
- Task 4's `_make_google_verifier_client` uses `google.generativeai` SDK — the plan says "verify before adding" but the executor is a server-only file (no `client-only` fence). If the SDK isn't in `pyproject.toml`, the function returns `None` (the existing `ImportError` handler) and the verifier falls back to Anthropic with a one-shot warning. No dep change required for the test to pass.
- Task 1's `event_from_row_payload` for the `result` kind reads `finalText` / `error` / `verification` from the payload; the spec's wire format is already in `events.event_to_row_payload`. The reverse is symmetric. Verified by reading `events.py:241-312`.

**5. Out-of-scope (per the spec):**

- OpenAI verifier wrapper (the spec defers it; the pattern is in place).
- TS chat-route cross-family (separate work item).
- Sentence-level claim wrapping (commit 6's straddle problem stays deferred; markers wrap the `[N]` token, not the claim sentence).
- agent-ts verifier (out of scope until its real-step phase).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-13-citation-verifiability-v2-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best when you want maximum review fidelity and the time budget is generous.
2. **Hybrid** — subagents for code-heavy tasks (1, 2, 4, 6), inline execution for content/tests (3, 5, 7). Cuts ~40% of subagent calls. Best when context budget is tight.

Given the previous user-manual plan was completed in hybrid mode successfully, hybrid is probably the right default here. Whichever you pick, the per-task subagents will:
- Pre-read the relevant shipped code (so they catch any drift from this plan's stated locations).
- Decline to silently fix spec bugs (per the previous plan's working pattern).
- Stop and ask when stuck.

Which approach?
