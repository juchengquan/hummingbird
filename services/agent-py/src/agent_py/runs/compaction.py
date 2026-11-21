"""Log compaction and retention (RUN_EVENTS.md § 7; Q17, Q30).

The run event log is a replay buffer, not the transcript. Once a run has
ended and the delta retention (~24 h) has passed, its output is folded
into one `messages_snapshot` entry (`compact_run`); after a further
retention window an interactive run's log is deleted, the `tasks` row
staying (`purge_expired`). A rejoin then answers `hummingbird.gap`
(`compacted` / `purged`) + `MESSAGES_SNAPSHOT` (`stream.py`).

**Background runs are left alone until Phase 5**: the old task routes
(`/api/tasks/:id/stream`, the tasks panel's fold) read their full logs.
`compact_run` is a no-op for them and the sweeps only select
interactive runs. Anonymous runs are never compacted either — their
memory log expires first (`event_log_memory.py`).

The fold is computed by running the AG-UI encoder over the entries and
applying its events the way a client applies a live stream, so the
snapshot holds exactly the messages (ids included) a client that
watched the run holds.

Wiring (the app lifespan, next to the scheduler loop): every
`SWEEP_INTERVAL` call `retention_sweep(pool, log)` — see its docstring.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import asyncpg
import structlog

from ..events import (
    MessagesSnapshotEvent,
    ResultEvent,
    StatusEvent,
    TaskEvent,
    ToolOutputEvent,
    drop_superseded_events,
)
from .agui_encoder import AgUiRunEncoder
from .event_log import RunEventLog
from .model import RunMode

__all__ = [
    "DELTA_RETENTION",
    "PURGE_RETENTION",
    "SWEEP_INTERVAL",
    "RetentionResult",
    "build_messages_snapshot",
    "compact_due",
    "compact_run",
    "first_closing_seq",
    "fold_messages",
    "purge_expired",
    "retention_sweep",
]

DELTA_RETENTION = timedelta(hours=24)
"""How long after a run ends its full log (every delta) is kept."""

PURGE_RETENTION = timedelta(days=30)
"""How long after a run ends its (compacted) log is kept at all —
interactive runs only; the row stays."""

SWEEP_INTERVAL = timedelta(minutes=10)
"""Suggested cadence for `retention_sweep`."""

_log = structlog.get_logger(__name__)

_CLOSING_STATUSES = ("cancelled", "done", "failed", "paused")


def first_closing_seq(entries: Sequence[TaskEvent]) -> int:
    """`T` of RUN_EVENTS.md § 7: the seq of the first `result` or
    `status` `cancelled` / `done` / `failed` / `paused`, else max seq + 1.
    `entries` must already be free of superseded entries."""
    for entry in entries:
        if isinstance(entry, ResultEvent) or (
            isinstance(entry, StatusEvent) and entry.status in _CLOSING_STATUSES
        ):
            return entry.seq
    return (entries[-1].seq if entries else 0) + 1


def fold_messages(run_id: str, entries: Sequence[TaskEvent]) -> list[dict[str, object]]:
    """The AG-UI messages a client holds after receiving `entries`
    encoded (RUN_EVENTS.md § 7 "The fold"): assistant messages (text
    and tool calls), reasoning, tool results and activities, in the
    order of the entry that created each, with the ids of § 2. Steps,
    sub-agent markers, step errors, approvals and model-context
    compaction leave nothing; an earlier snapshot's messages are kept
    verbatim."""
    encoder = AgUiRunEncoder(run_id)
    messages: list[dict[str, object]] = []
    by_id: dict[str, dict[str, object]] = {}
    calls: dict[str, dict[str, str]] = {}

    def add(message: dict[str, object]) -> dict[str, object]:
        messages.append(message)
        by_id[str(message["id"])] = message
        return message

    for entry in entries:
        if isinstance(entry, MessagesSnapshotEvent):
            for message in entry.messages:
                add(dict(message))
            continue
        for ev in encoder.encode(entry):
            kind = ev["type"]
            if kind == "TEXT_MESSAGE_START":
                add({"id": ev["messageId"], "role": "assistant", "content": ""})
            elif kind == "REASONING_MESSAGE_START":
                add({"id": ev["messageId"], "role": "reasoning", "content": ""})
            elif kind in ("TEXT_MESSAGE_CONTENT", "REASONING_MESSAGE_CONTENT"):
                target = by_id[str(ev["messageId"])]
                target["content"] = f"{target['content']}{ev['delta']}"
            elif kind == "TOOL_CALL_START":
                parent_id = str(ev["parentMessageId"])
                parent = by_id.get(parent_id) or add({"id": parent_id, "role": "assistant"})
                call_fn = {"name": str(ev["toolCallName"]), "arguments": ""}
                tool_calls = parent.setdefault("toolCalls", [])
                if not isinstance(tool_calls, list):  # an earlier snapshot's odd message
                    continue
                tool_calls.append({"id": ev["toolCallId"], "type": "function", "function": call_fn})
                calls[str(ev["toolCallId"])] = call_fn
            elif kind == "TOOL_CALL_ARGS":
                call_fn = calls[str(ev["toolCallId"])]
                call_fn["arguments"] += str(ev["delta"])
            elif kind == "TOOL_CALL_RESULT" and isinstance(entry, ToolOutputEvent):
                tool_message: dict[str, object] = {
                    "id": ev["messageId"],
                    "role": "tool",
                    "toolCallId": ev["toolCallId"],
                    "content": ev["content"],
                }
                if entry.is_error:
                    tool_message["error"] = entry.summary
                tool_message["metadata"] = {"hummingbird": {"toolName": entry.tool_name}}
                add(tool_message)
            elif kind == "ACTIVITY_SNAPSHOT":
                existing = by_id.get(str(ev["messageId"]))
                if existing is not None and existing.get("role") == "activity":
                    existing["content"] = ev["content"]
                else:
                    add(
                        {
                            "id": ev["messageId"],
                            "role": "activity",
                            "activityType": ev["activityType"],
                            "content": ev["content"],
                        }
                    )
    return messages


def build_messages_snapshot(
    run_id: str, entries: Sequence[TaskEvent]
) -> MessagesSnapshotEvent | None:
    """The `messages_snapshot` entry that compacts `entries` (a run's
    whole log, ascending), or None when there is nothing to fold:
    nothing below `T`, or only an earlier snapshot (already compacted)."""
    live = drop_superseded_events(entries)
    closing = first_closing_seq(live)
    folded = [e for e in live if e.seq < closing]
    if not folded or (len(folded) == 1 and isinstance(folded[0], MessagesSnapshotEvent)):
        return None
    last = folded[-1]
    return MessagesSnapshotEvent(
        run_id=run_id,
        seq=last.seq,
        step=last.step,
        created_at=last.created_at,
        messages=tuple(fold_messages(run_id, folded)),
    )


async def compact_run(log: RunEventLog, run_id: str, *, mode: RunMode) -> bool:
    """Compact one ended run's log (RUN_EVENTS.md § 7). True when the log
    changed. The caller decides the run is due (ended, delta retention
    passed); this does not look at the row.

    A no-op for background runs until Phase 5 (the old task routes fold
    their full logs)."""
    if mode != "interactive":
        return False
    snapshot = build_messages_snapshot(run_id, await log.read(run_id))
    if snapshot is None:
        return False
    return await log.compact(run_id, snapshot)


# --- Sweeps (Postgres) ---------------------------------------------------------------

# Ended interactive runs past the delta retention whose log has something
# to fold: no snapshot yet, and an entry that is not a closing one.
_DUE_FOR_COMPACTION_SQL = """
SELECT t.id::text AS id
  FROM public.tasks t
 WHERE t.mode = 'interactive'
   AND t.status IN ('done', 'failed', 'cancelled', 'paused')
   AND t.finished_at IS NOT NULL
   AND t.finished_at < $1
   AND NOT EXISTS (SELECT 1 FROM public.task_events e
                    WHERE e.task_id = t.id AND e.kind = 'messages_snapshot')
   AND EXISTS (SELECT 1 FROM public.task_events e
                WHERE e.task_id = t.id
                  AND e.kind <> 'result'
                  AND NOT (e.kind = 'status'
                           AND e.payload->>'status' IN ('done', 'failed', 'cancelled', 'paused')))
 ORDER BY t.finished_at
 LIMIT $2;
"""

_DUE_FOR_PURGE_SQL = """
SELECT t.id::text AS id
  FROM public.tasks t
 WHERE t.mode = 'interactive'
   AND t.status IN ('done', 'failed', 'cancelled', 'paused')
   AND t.finished_at IS NOT NULL
   AND t.finished_at < $1
   AND EXISTS (SELECT 1 FROM public.task_events e WHERE e.task_id = t.id)
 ORDER BY t.finished_at
 LIMIT $2;
"""


async def _due(pool: asyncpg.Pool, sql: str, before: datetime, limit: int) -> list[str]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, before, limit)
    return [str(r["id"]) for r in rows]


async def compact_due(
    pool: asyncpg.Pool,
    log: RunEventLog,
    *,
    retention: timedelta = DELTA_RETENTION,
    limit: int = 100,
    now: datetime | None = None,
) -> int:
    """Compact up to `limit` interactive runs that ended more than
    `retention` ago and are not compacted yet. Returns how many logs
    changed. A failure on one run is logged and skipped."""
    before = (now or datetime.now(UTC)) - retention
    changed = 0
    for run_id in await _due(pool, _DUE_FOR_COMPACTION_SQL, before, limit):
        try:
            if await compact_run(log, run_id, mode="interactive"):
                changed += 1
        except Exception:
            _log.warning("runs.compaction.failed", run_id=run_id, exc_info=True)
    return changed


async def purge_expired(
    pool: asyncpg.Pool,
    log: RunEventLog,
    *,
    retention: timedelta = PURGE_RETENTION,
    limit: int = 500,
    now: datetime | None = None,
) -> int:
    """Delete the logs of up to `limit` interactive runs that ended more
    than `retention` ago (Q30). The `tasks` rows stay; a rejoin answers
    `gap { reason: "purged" }`. Background runs keep their logs as long
    as the row exists (Q17). Returns how many logs were deleted."""
    before = (now or datetime.now(UTC)) - retention
    purged = 0
    for run_id in await _due(pool, _DUE_FOR_PURGE_SQL, before, limit):
        await log.purge(run_id)
        purged += 1
    return purged


@dataclass(frozen=True)
class RetentionResult:
    compacted: int
    purged: int


async def retention_sweep(
    pool: asyncpg.Pool,
    log: RunEventLog,
    *,
    compact_after: timedelta = DELTA_RETENTION,
    purge_after: timedelta = PURGE_RETENTION,
    now: datetime | None = None,
) -> RetentionResult:
    """One pass of both: compact what is due, then purge what expired.
    Bounded per call (100 compactions, 500 purges); a backlog drains
    over consecutive sweeps. Call it every `SWEEP_INTERVAL` from one
    process (several are safe — compaction is idempotent and takes a
    per-run advisory lock; purging twice deletes nothing)."""
    compacted = await compact_due(pool, log, retention=compact_after, now=now)
    purged = await purge_expired(pool, log, retention=purge_after, now=now)
    if compacted or purged:
        _log.info("runs.retention_sweep", compacted=compacted, purged=purged)
    return RetentionResult(compacted=compacted, purged=purged)
