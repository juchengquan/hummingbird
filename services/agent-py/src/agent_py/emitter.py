"""RunEmitter — sequenced event producer for the agent loop.

Mirror of `lib/shared/agent/emitter.ts`. The runner calls
`emitter.status(...)` / `emitter.start_step()` / `emitter.token(...)` /
etc.; the emitter stamps the next `seq`, the current `step`, and
the timestamp, then hands the event to a sink callback (typically
"persist into task_events + optionally fan out to a Realtime stream").

Two invariants the consumer can rely on:

  1. **Monotonic seq.** Every emit bumps the counter by 1. No gaps.
  2. **Settle-once.** The first terminal event (`status: cancelled` or
     `result: done|failed`) latches the emitter — subsequent emits are
     dropped silently. This is what makes the loop safe against late
     tool callbacks that try to append past the end.

The emitter does NOT own DB I/O — the sink does. That lets the runner
be exercised with a list-sink in tests and a real DB sink in
production without duplicating the control flow.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Literal

from .events import (
    ApprovalEvent,
    ApprovalRequestKind,
    InputRequestOption,
    ResultEvent,
    RunStatus,
    StatusEvent,
    StepEndEvent,
    StepErrorEvent,
    StepStartEvent,
    TaskEvent,
    TokenEvent,
    ToolCallResult,
    ToolInputEvent,
    ToolOutputEvent,
    is_terminal_status,
)

# Sink signature: receives one TaskEvent, persists / forwards it.
EventSink = Callable[[TaskEvent], Awaitable[None]]


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class RunEmitter:
    """Sequenced event producer with settle-once semantics."""

    def __init__(
        self,
        *,
        run_id: str,
        sink: EventSink,
        start_seq: int = 0,
        start_step: int = 0,
    ) -> None:
        """Construct an emitter.

        `start_seq` / `start_step` are non-zero on a resume: the
        continuation invocation seeds them from the checkpoint so the
        next emit follows monotonically. A fresh run uses defaults.
        """
        self._run_id = run_id
        self._sink = sink
        self._seq = start_seq
        self._step = start_step
        self._settled = False

    @property
    def step(self) -> int:
        """Current step number — read by the runner to decide whether
        to emit `status: running` (only on a fresh start, step == 0)."""
        return self._step

    @property
    def seq(self) -> int:
        """Highest seq emitted so far — read by the executor on
        chunk-break yield to persist into the new checkpoint, so the
        next chunk's emitter seeds at `seq+1`."""
        return self._seq

    @property
    def settled(self) -> bool:
        return self._settled

    async def status(self, status: RunStatus) -> None:
        """Emit a status transition. The terminal kinds latch."""
        if self._settled:
            return
        await self._emit(
            StatusEvent(
                run_id=self._run_id,
                seq=self._next_seq(),
                step=self._step,
                created_at=_now_iso(),
                status=status,
            )
        )
        if is_terminal_status(status):
            self._settled = True

    async def start_step(self) -> None:
        if self._settled:
            return
        self._step += 1
        await self._emit(
            StepStartEvent(
                run_id=self._run_id,
                seq=self._next_seq(),
                step=self._step,
                created_at=_now_iso(),
            )
        )

    async def end_step(self) -> None:
        if self._settled:
            return
        await self._emit(
            StepEndEvent(
                run_id=self._run_id,
                seq=self._next_seq(),
                step=self._step,
                created_at=_now_iso(),
            )
        )

    async def token(self, text: str, *, channel: Literal["text", "reasoning"] = "text") -> None:
        if self._settled:
            return
        await self._emit(
            TokenEvent(
                run_id=self._run_id,
                seq=self._next_seq(),
                step=self._step,
                created_at=_now_iso(),
                text=text,
                channel=channel,
            )
        )

    async def tool_input(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        args: dict[str, object],
    ) -> None:
        """Emit a `tool_input` event — the model called a tool. Args
        are final/complete at emit time (the Anthropic SDK collects
        the streamed JSON deltas into a final input object before we
        emit)."""
        if self._settled:
            return
        await self._emit(
            ToolInputEvent(
                run_id=self._run_id,
                seq=self._next_seq(),
                step=self._step,
                created_at=_now_iso(),
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                args=args,
            )
        )

    async def tool_output(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        summary: str,
        results: list[ToolCallResult] | None = None,
    ) -> None:
        """Emit a `tool_output` event — the tool resolved. `summary`
        is a one-line user-facing description ("Fetched <title>",
        "5 results"); `results` is set when the output is a list of
        sources for the rail (`webSearch`-shaped)."""
        if self._settled:
            return
        await self._emit(
            ToolOutputEvent(
                run_id=self._run_id,
                seq=self._next_seq(),
                step=self._step,
                created_at=_now_iso(),
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                summary=summary,
                results=results,
            )
        )

    async def input_request(
        self,
        *,
        approval_id: str,
        request_kind: ApprovalRequestKind | None = None,
        tool: str | None = None,
        tool_call_id: str | None = None,
        args: dict[str, object] | None = None,
        prompt: str | None = None,
        options: list[InputRequestOption] | None = None,
        multi: bool | None = None,
    ) -> None:
        """Emit `approval` with `phase='request'` — the run is
        suspending and the user needs to pick an answer. The executor
        pairs this with a `status: paused` emit so the projection
        flips the run into the paused state."""
        if self._settled:
            return
        await self._emit(
            ApprovalEvent(
                run_id=self._run_id,
                seq=self._next_seq(),
                step=self._step,
                created_at=_now_iso(),
                approval_id=approval_id,
                phase="request",
                request_kind=request_kind,
                tool=tool,
                tool_call_id=tool_call_id,
                args=args,
                prompt=prompt,
                options=options,
                multi=multi,
            )
        )

    async def input_response(
        self,
        *,
        approval_id: str,
        approved: bool | None = None,
        selection: list[str] | None = None,
        value: str | None = None,
    ) -> None:
        """Emit `approval` with `phase='response'` — the user answered.
        Clears `pending_input` on the client's projection. Emitted
        from the `respond` action before the loop resumes; the
        approval-id pairs with the matching request emit."""
        if self._settled:
            return
        await self._emit(
            ApprovalEvent(
                run_id=self._run_id,
                seq=self._next_seq(),
                step=self._step,
                created_at=_now_iso(),
                approval_id=approval_id,
                phase="response",
                approved=approved,
                selection=selection,
                value=value,
            )
        )

    async def step_error(self, message: str, *, will_retry: bool = True) -> None:
        """Emit a non-fatal step error. The model usually recovers next
        step; this is just a UI signal that *something* went sideways
        without aborting the run."""
        if self._settled:
            return
        await self._emit(
            StepErrorEvent(
                run_id=self._run_id,
                seq=self._next_seq(),
                step=self._step,
                created_at=_now_iso(),
                message=message,
                will_retry=will_retry,
            )
        )

    async def result(
        self,
        status: Literal["done", "failed"],
        *,
        final_text: str | None = None,
        error: str | None = None,
    ) -> None:
        """Emit the terminal `result` event. Latches the emitter so
        nothing further is sent — call exactly once at the end of a
        run."""
        if self._settled:
            return
        await self._emit(
            ResultEvent(
                run_id=self._run_id,
                seq=self._next_seq(),
                step=self._step,
                created_at=_now_iso(),
                status=status,
                final_text=final_text,
                error=error,
            )
        )
        self._settled = True

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    async def _emit(self, event: TaskEvent) -> None:
        await self._sink(event)
