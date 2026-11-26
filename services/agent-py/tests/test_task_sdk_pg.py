"""Wave 5c — the next model call's history as the real Anthropic SDK
sends it: the executor and provider on a real Postgres, the SDK
streaming from a fake Messages API (in-process transport, no network)."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import pytest_asyncio
from anthropic import AsyncAnthropic

from .task_world import READ, SEND, WRITE, World, open_world, pairing_problem, pg_only

pytestmark = [pg_only, pytest.mark.asyncio]


def sse(blocks: list[dict[str, Any]]) -> bytes:
    def frame(kind: str, **data: Any) -> str:
        return f"event: {kind}\ndata: {json.dumps({'type': kind, **data})}\n\n"

    message = {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-haiku-4-5",
        "content": [],
        "stop_reason": None,
        "stop_sequence": None,
        "usage": {"input_tokens": 1, "output_tokens": 1},
    }
    out = [frame("message_start", message=message)]
    for index, block in enumerate(blocks):
        if block["type"] == "text":
            start: dict[str, Any] = {"type": "text", "text": ""}
            delta = {"type": "text_delta", "text": block["text"]}
        else:
            start = {**block, "input": {}}
            delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
        out += [
            frame("content_block_start", index=index, content_block=start),
            frame("content_block_delta", index=index, delta=delta),
            frame("content_block_stop", index=index),
        ]
    reason = "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn"
    out += [
        frame(
            "message_delta",
            delta={"stop_reason": reason, "stop_sequence": None},
            usage={"output_tokens": 2},
        ),
        frame("message_stop"),
    ]
    return "".join(out).encode()


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


async def test_the_sdk_sends_one_result_per_call(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    turn = [
        {"type": "text", "text": "Three things."},
        {"type": "tool_use", "id": "toolu_w", "name": WRITE, "input": {"n": 1}},
        {"type": "tool_use", "id": "toolu_q1", "name": SEND, "input": {"n": 2}},
        {"type": "tool_use", "id": "toolu_q2", "name": SEND, "input": {"n": 3}},
        {"type": "tool_use", "id": "toolu_r", "name": READ, "input": {}},
    ]
    sent: list[dict[str, Any]] = []

    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.append(body)
        blocks = turn if len(sent) == 1 else [{"type": "text", "text": "All done."}]
        return httpx.Response(
            200, content=sse(blocks), headers={"content-type": "text/event-stream"}
        )

    client = AsyncAnthropic(
        api_key="test",
        base_url="http://model.test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(answer)),
    )
    monkeypatch.setattr("agent_py.executor._resolve_anthropic_client", lambda *_: client)
    task = await world.start()
    await world.work()
    for question, approved in (("toolu_q1", True), ("toolu_q2", False)):
        assert await world.status(task) == "paused", await world.error(task)
        await world.respond(task, question, approved=approved)
        await world.work()
    assert await world.status(task) == "done", await world.error(task)
    assert len(sent) == 2
    history = sent[1]["messages"]
    assert pairing_problem(history) is None
    results = [b["tool_use_id"] for b in history[-1]["content"]]
    assert results == ["toolu_w", "toolu_q1", "toolu_q2", "toolu_r"]
    assert (world.count(WRITE), world.count(SEND), world.count(READ)) == (1, 1, 1)
