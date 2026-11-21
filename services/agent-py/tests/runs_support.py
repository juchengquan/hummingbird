"""Shared helpers for the wave-3b-A run tests: an entry builder and the
pinned AG-UI JSON Schema validator."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from functools import cache
from pathlib import Path
from typing import Any

import jsonschema

from agent_py.events import (
    ApprovalEvent,
    HandoffEvent,
    ResultEvent,
    StatusEvent,
    StepEndEvent,
    StepStartEvent,
    TaskEvent,
    TokenEvent,
    TokenUsage,
    ToolCallResult,
    ToolInputEvent,
    ToolOutputEvent,
)
from agent_py.runs.model import RunOwner, RunRecord

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = REPO_ROOT / "packages" / "contract" / "agui" / "1.0" / "schema.json"

RUN_ID = "8a6e0804-0000-4000-8000-00000000f907"
THREAD_ID = "11111111-2222-4333-8444-555555555555"
NOW = "2026-11-21T00:00:00Z"


@cache
def _schema() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(SCHEMA_PATH.read_text())
    return loaded


@cache
def _validator(definition: str) -> jsonschema.Draft202012Validator:
    schema = {**_schema(), "$ref": f"#/$defs/{definition}"}
    return jsonschema.Draft202012Validator(schema)


def assert_valid(value: object, definition: str = "Event") -> None:
    """Raise if `value` is not a valid AG-UI `definition` (default `Event`)."""
    errors = sorted(_validator(definition).iter_errors(value), key=lambda e: list(e.path))
    if errors:
        detail = "; ".join(f"{list(e.path)}: {e.message}" for e in errors[:5])
        raise AssertionError(f"invalid AG-UI {definition}: {detail}\n{json.dumps(value)}")


def run_record(
    *,
    run_id: str = RUN_ID,
    status: str = "running",
    mode: str = "interactive",
    **kw: Any,
) -> RunRecord:
    at = datetime(2026, 11, 21, tzinfo=UTC)
    return RunRecord(
        id=run_id,
        owner=RunOwner.user("u1"),
        thread_id=THREAD_ID,
        mode=mode,  # type: ignore[arg-type]
        internal_status=status,  # type: ignore[arg-type]
        created_at=at,
        updated_at=at,
        **kw,
    )


class Log:
    """Builds a run's entries with consecutive seqs."""

    def __init__(self, run_id: str = RUN_ID) -> None:
        self.run_id = run_id
        self.seq = 0
        self.step = 0
        self.entries: list[TaskEvent] = []

    def _base(self) -> dict[str, Any]:
        self.seq += 1
        return {"run_id": self.run_id, "seq": self.seq, "step": self.step, "created_at": NOW}

    def add(self, cls: type[Any], **fields: Any) -> TaskEvent:
        event: TaskEvent = cls(**self._base(), **fields)
        self.entries.append(event)
        return event

    def step_start(self) -> TaskEvent:
        self.step += 1
        return self.add(StepStartEvent)

    def step_end(self) -> TaskEvent:
        return self.add(StepEndEvent)

    def text(self, text: str) -> TaskEvent:
        return self.add(TokenEvent, text=text)

    def think(self, text: str) -> TaskEvent:
        return self.add(TokenEvent, text=text, channel="reasoning")

    def tool(self, call_id: str, name: str, args: dict[str, object]) -> TaskEvent:
        return self.add(ToolInputEvent, tool_call_id=call_id, tool_name=name, args=args)

    def output(
        self,
        call_id: str,
        name: str,
        summary: str,
        results: list[ToolCallResult] | None = None,
        *,
        is_error: bool = False,
    ) -> TaskEvent:
        return self.add(
            ToolOutputEvent,
            tool_call_id=call_id,
            tool_name=name,
            summary=summary,
            results=results,
            is_error=is_error,
        )

    def status(self, status: str, **kw: Any) -> TaskEvent:
        return self.add(StatusEvent, status=status, **kw)

    def result(self, status: str = "done", **kw: Any) -> TaskEvent:
        return self.add(ResultEvent, status=status, **kw)

    def approval(self, approval_id: str, phase: str = "request", **kw: Any) -> TaskEvent:
        return self.add(ApprovalEvent, approval_id=approval_id, phase=phase, **kw)

    def handoff(self, agent: str, phase: str, **kw: Any) -> TaskEvent:
        return self.add(HandoffEvent, agent=agent, phase=phase, **kw)


USAGE = (TokenUsage(provider="anthropic", model="claude-x", input_tokens=10, output_tokens=5),)
