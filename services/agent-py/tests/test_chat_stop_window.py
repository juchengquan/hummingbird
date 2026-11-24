"""Wave 6 (bug 16): a Stop that lands just before an ordinary tool call
runs nothing.

`run_turn_loop` races each tool against a waiter task on the cancel
signal. A Stop set while the loop is writing the call's `tool_input`
entry has not reached the waiter task yet (it runs on the next loop
iteration), so only the signal itself can tell — as the resume path
checks it (`runs/native_harness.py`).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

from agent_py.chat_loop import LoopCancelled, run_turn_loop
from agent_py.emitter import RunEmitter
from agent_py.events import TaskEvent, ToolInputEvent, ToolOutputEvent
from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult


class _Stream:
    async def __aenter__(self) -> _Stream:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    def __aiter__(self) -> AsyncIterator[Any]:
        async def nothing() -> AsyncIterator[Any]:
            return
            yield

        return nothing()

    async def get_final_message(self) -> dict[str, Any]:
        return {"content": [{"type": "tool_use", "id": "t1", "name": "send", "input": {"to": "x"}}]}


class _Client:
    def __init__(self) -> None:
        self.calls = 0

        client = self

        class _Messages:
            def stream(self, **_kw: Any) -> _Stream:
                client.calls += 1
                return _Stream()

        self.messages = _Messages()


async def test_a_stop_while_the_tool_call_is_announced_runs_no_tool() -> None:
    stop = asyncio.Event()
    ran: list[dict[str, Any]] = []
    events: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        events.append(event)
        if isinstance(event, ToolInputEvent):
            # The user presses Stop while this entry is being written.
            stop.set()

    async def send(args: dict[str, Any]) -> ToolInvocationResult:
        ran.append(args)
        return ToolInvocationResult(text="sent", summary="sent")

    tool = ToolDescriptor(
        name="send", description="send", input_schema={"type": "object"}, execute=send
    )
    result = await run_turn_loop(
        client=_Client(),  # type: ignore[arg-type]
        emitter=RunEmitter(run_id="r", sink=sink),
        model="claude-test",
        messages=[{"role": "user", "content": "send it"}],
        tools=[tool],
        cancel=stop,
    )

    assert ran == []
    assert isinstance(result.outcome, LoopCancelled)
    assert result.step_open is True
    assert not any(isinstance(e, ToolOutputEvent) for e in events)
