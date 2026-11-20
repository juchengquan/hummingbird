"""Side-effecting tool execution record — so a reclaimed run never
silently runs a side-effecting tool twice.

A worker can die anywhere, including while a tool runs. Its job is then
reclaimed and the run resumes from its last checkpoint. For a read-only
tool (`webFetch`, `webSearch`, `searchFiles`, …) re-running is harmless.
For a side-effecting one it is not: an MCP tool that sent an email or
wrote a row would do it again.

So before a side-effecting tool executes, the run checkpoints an
execution record (`checkpoint["inflight_tools"]`), and again once the
tool's result is known:

    {"started": ["<tool_call_id>"],          # executing right now
     "results": [<tool_result block>, ...]}  # finished in this turn

alongside `messages` ending with the assistant turn whose `tool_use`
blocks are being executed. A reclaimed run that loads such a checkpoint
completes that turn instead of asking the model again
(`executor._complete_inflight_turn`): a call with a recorded result
reuses it; a call in `started` without a result is NOT re-run — it gets
an `interrupted_tool_result` telling the model the outcome is unknown,
so it can verify or ask; any other call (read-only, or side-effecting
but never started) runs now. The next ordinary checkpoint save drops
the record (`executor._build_checkpoint` never carries it).

The respond path uses the same field for the approved tool it runs:
`started` is saved before the tool executes, and a reclaimed respond
that finds it (with no `tool_result` persisted) feeds the model the
interrupted result instead of executing the approved tool again.

What counts as side-effecting (`ToolLedger.is_side_effecting`): a tool
whose descriptor sets `side_effecting=True` — every MCP tool (an
arbitrary third-party action we can't classify) — plus any
approval-gated tool (the user's `requireApprovalFor` list, MCP servers
that require approval): gating a tool is the user saying it acts on the
world. Built-in tools are read-only (`generateImage` re-generating an
image costs a call but changes nothing the user relies on).

Like `lease.py`, the ledger travels as a contextvar so the step fn (and
every test fake) needn't thread it through `AnthropicStepConfig`.
Outside a bound ledger, recording is a no-op.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterator, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from .tools.registry import ToolDescriptor

#: Checkpoint key carrying the in-flight execution record. Python-only;
#: the TS worker ignores unknown checkpoint keys.
INFLIGHT_KEY = "inflight_tools"

#: What the model is told about a side-effecting tool whose execution
#: was interrupted by a worker crash.
INTERRUPTED_TOOL_TEXT = (
    "The previous execution of this tool call was interrupted (the worker "
    "running it stopped) and its outcome is unknown: it may or may not have "
    "taken effect. It was NOT run again automatically. Verify the current "
    "state, or ask the user, before retrying it."
)

#: UI pill text for the same.
INTERRUPTED_TOOL_SUMMARY = "Interrupted — outcome unknown"


def interrupted_tool_result(tool_call_id: str) -> dict[str, Any]:
    """The `tool_result` block recorded for an interrupted call."""
    return {
        "type": "tool_result",
        "tool_use_id": tool_call_id,
        "content": INTERRUPTED_TOOL_TEXT,
        "is_error": True,
    }


@dataclass(frozen=True)
class InflightRecord:
    """A decoded `inflight_tools` checkpoint field."""

    started: frozenset[str] = frozenset()
    results: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def empty(self) -> bool:
        return not self.started and not self.results


def record_payload(started: Sequence[str], results: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """The jsonb value stored under `INFLIGHT_KEY`."""
    return {"started": list(started), "results": [dict(r) for r in results]}


def read_record(checkpoint: dict[str, Any]) -> InflightRecord:
    """Decode the checkpoint's record. Defensive — the checkpoint is
    owner-writable jsonb, so anything malformed reads as no record."""
    raw = checkpoint.get(INFLIGHT_KEY)
    if not isinstance(raw, dict):
        return InflightRecord()
    started_raw = raw.get("started")
    started = (
        frozenset(s for s in started_raw if isinstance(s, str) and s)
        if isinstance(started_raw, list)
        else frozenset()
    )
    results: dict[str, dict[str, Any]] = {}
    results_raw = raw.get("results")
    if isinstance(results_raw, list):
        for block in results_raw:
            if (
                isinstance(block, dict)
                and block.get("type") == "tool_result"
                and isinstance(block.get("tool_use_id"), str)
            ):
                results[block["tool_use_id"]] = dict(block)
    return InflightRecord(started=started, results=results)


SaveRecordFn = Callable[[dict[str, Any]], Awaitable[None]]


class ToolLedger:
    """Writes the execution record for one run's side-effecting tools.

    `save` persists a checkpoint carrying the given record (the executor
    builds it from the run's live messages + emitter position)."""

    def __init__(self, *, save: SaveRecordFn, gated_tool_names: frozenset[str] = frozenset()):
        self._save = save
        self._gated = gated_tool_names

    def is_side_effecting(self, name: str, descriptor: ToolDescriptor | None) -> bool:
        if descriptor is not None and descriptor.side_effecting:
            return True
        return name in self._gated

    async def record_started(self, tool_call_id: str, results: Sequence[dict[str, Any]]) -> None:
        """Persist "`tool_call_id` is executing" — before it executes."""
        await self._save(record_payload([tool_call_id], results))

    async def record_finished(self, results: Sequence[dict[str, Any]]) -> None:
        """Persist the turn's results so far — right after a
        side-effecting tool's result is known."""
        await self._save(record_payload([], results))


_current: ContextVar[ToolLedger | None] = ContextVar("agent_py_tool_ledger", default=None)


@contextmanager
def bound(ledger: ToolLedger) -> Iterator[ToolLedger]:
    token = _current.set(ledger)
    try:
        yield ledger
    finally:
        _current.reset(token)


def current() -> ToolLedger | None:
    return _current.get()
