"""The state of the tool turn being executed — so every call gets one
result, and a reclaimed run never silently runs a side-effecting tool twice.

A worker can die anywhere, including while a tool runs. Its job is then
reclaimed and the run resumes from its last checkpoint. For a read-only
tool (`webFetch`, `webSearch`, `searchFiles`, …) re-running is harmless.
For a side-effecting one it is not: an MCP tool that sent an email or
wrote a row would do it again.

So a tool turn is checkpointed as it executes
(`checkpoint["inflight_tools"]`), alongside `messages` ending with the
assistant turn whose `tool_use` blocks are being answered:

    {"started": ["<tool_call_id>"],          # side-effecting, executing now
     "results": [<tool_result block>, ...],  # answered so far in this turn
     "ask":     ["<tool_call_id>"],          # wait for the user, in call order
     "spawn":   {"<tool_call_id>": args},    # sub-agents to fan out
     "classified": true,                     # saved before any call ran
     "stepOpen": false}                      # a step was open at the save

It is saved when the model's calls are classified (before any runs),
before a side-effecting tool executes, after every result, and with a
pause or a spawn: the results wait there until the turn is complete, then
become one user turn (`executor._resolve_turn`). A reclaimed run that
loads such a checkpoint completes that turn instead of asking the model
again: a call with a result reuses it; a call in `started` without a
result is NOT re-run — it gets an `interrupted_tool_result` telling the
model the outcome is unknown, so it can verify or ask; a call in `ask` is
asked; any other (read-only, or side-effecting but never started) runs
now. An answered question leaves `ask`; an approved tool is `started`
before it executes, like any side effect. Checkpoints saved before wave
5c have no `classified`, and their record may hold `started` / `results`
alone.

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

from collections.abc import Awaitable, Callable, Iterator, Mapping, Sequence
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
    ask: frozenset[str] = frozenset()
    spawn: dict[str, dict[str, Any]] = field(default_factory=dict)
    classified: bool = False
    step_open: bool = False

    @property
    def empty(self) -> bool:
        return not (self.classified or self.started or self.results or self.ask or self.spawn)


def record_payload(
    started: Sequence[str],
    results: Sequence[dict[str, Any]],
    *,
    ask: Sequence[str] = (),
    spawn: Mapping[str, dict[str, Any]] | None = None,
    classified: bool = False,
    step_open: bool = False,
) -> dict[str, Any]:
    """The jsonb value stored under `INFLIGHT_KEY`."""
    return {
        "started": list(started),
        "results": [dict(r) for r in results],
        "ask": list(ask),
        "spawn": dict(spawn or {}),
        "classified": classified,
        "stepOpen": step_open,
    }


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
    ask_raw = raw.get("ask")
    spawn_raw = raw.get("spawn")
    # Before wave 5c a record was only ever saved inside an open step.
    step_open = raw["stepOpen"] is True if "stepOpen" in raw else bool(started or results)
    return InflightRecord(
        started=started,
        results=results,
        ask=frozenset(a for a in ask_raw if isinstance(a, str))
        if isinstance(ask_raw, list)
        else frozenset(),
        spawn={k: v for k, v in spawn_raw.items() if isinstance(v, dict)}
        if isinstance(spawn_raw, dict)
        else {},
        classified=raw.get("classified") is True,
        step_open=step_open,
    )


SaveRecordFn = Callable[[dict[str, Any]], Awaitable[None]]


class ToolLedger:
    """One run's tool-turn state, written through `save`.

    `save` persists a checkpoint carrying the given record (the executor
    builds it from the run's live messages + emitter position), and
    raises when the run has ended, which stops it before the next side
    effect."""

    def __init__(self, *, save: SaveRecordFn, gated_tool_names: frozenset[str] = frozenset()):
        self._save = save
        self._gated = gated_tool_names
        self.reset()

    def reset(self, record: InflightRecord | None = None) -> None:
        """The state of `record`; none → no turn in flight."""
        record = record or InflightRecord()
        self.started: set[str] = set(record.started)
        self.results: dict[str, dict[str, Any]] = dict(record.results)
        self.ask: set[str] = set(record.ask)
        self.spawn: dict[str, dict[str, Any]] = dict(record.spawn)
        self.classified = record.classified
        self.step_open = record.step_open

    @property
    def empty(self) -> bool:
        return not (self.classified or self.started or self.results or self.ask or self.spawn)

    def payload(self) -> dict[str, Any]:
        return record_payload(
            sorted(self.started),
            list(self.results.values()),
            ask=sorted(self.ask),
            spawn=self.spawn,
            classified=self.classified,
            step_open=self.step_open,
        )

    def is_side_effecting(self, name: str, descriptor: ToolDescriptor | None) -> bool:
        if descriptor is not None and descriptor.side_effecting:
            return True
        return name in self._gated

    async def record_turn(self, *, ask: set[str], spawn: Mapping[str, dict[str, Any]]) -> None:
        """Persist what the model's calls are — before any of them runs."""
        self.reset()
        self.ask, self.spawn = set(ask), dict(spawn)
        self.classified = self.step_open = True
        await self._save(self.payload())

    async def record_started(self, tool_call_id: str) -> None:
        """Persist "`tool_call_id` is executing" — before it executes."""
        self.started.add(tool_call_id)
        await self._save(self.payload())

    def answer(self, result: dict[str, Any]) -> None:
        """`result` answers its call; persisted by the next save."""
        tool_call_id = result["tool_use_id"]
        self.results[tool_call_id] = result
        self.started.discard(tool_call_id)
        self.ask.discard(tool_call_id)
        self.spawn.pop(tool_call_id, None)

    async def record_finished(self, result: dict[str, Any]) -> None:
        """Persist a call's result — right after it is known."""
        self.answer(result)
        await self._save(self.payload())


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
