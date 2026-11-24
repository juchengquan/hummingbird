"""Wave 6 (bug 13): a background step's output ceiling, and an answer cut
at it, through the real SDK.

As `test_anthropic_payloads.py`: the SDK streams from an in-process
transport, so `stop_reason` comes from a real `message_delta` and each
request body is checked against the SDK's own request param types.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from anthropic import AsyncAnthropic

from agent_py.emitter import RunEmitter
from agent_py.events import TaskEvent, TokenEvent
from agent_py.providers import anthropic_provider
from agent_py.providers.anthropic_provider import AnthropicStepConfig, make_anthropic_step_fn
from agent_py.runner import run_agent_loop

from .test_anthropic_payloads import _lookup, refused


def _sse(blocks: list[dict[str, Any]], stop_reason: str) -> bytes:
    events: list[dict[str, Any]] = [
        {
            "type": "message_start",
            "message": {
                "id": "msg",
                "type": "message",
                "role": "assistant",
                "model": "claude-sonnet-4-6",
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        }
    ]
    for index, block in enumerate(blocks):
        if block["type"] == "text":
            start = {"type": "text", "text": ""}
            delta = {"type": "text_delta", "text": block["text"]}
        else:
            start = {**block, "input": {}}
            delta = {"type": "input_json_delta", "partial_json": block["partial"]}
        events += [
            {"type": "content_block_start", "index": index, "content_block": start},
            {"type": "content_block_delta", "index": index, "delta": delta},
            {"type": "content_block_stop", "index": index},
        ]
    events += [
        {
            "type": "message_delta",
            "delta": {"stop_reason": stop_reason, "stop_sequence": None},
            "usage": {"output_tokens": 1},
        },
        {"type": "message_stop"},
    ]
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


async def test_a_reply_cut_at_max_tokens_is_continued_through_the_sdk() -> None:
    sent: list[dict[str, Any]] = []
    replies = [
        (
            [
                {"type": "text", "text": "Part one, cut mid-sen"},
                # A call cut while its arguments streamed: never run.
                {
                    "type": "tool_use",
                    "id": "toolu_cut",
                    "name": "lookup",
                    "partial": '{"q": "x"}',
                },
            ],
            "max_tokens",
        ),
        ([{"type": "text", "text": "tence. Part two."}], "end_turn"),
    ]

    def answer(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        blocks, stop = replies[len(sent) - 1]
        return httpx.Response(
            200, content=_sse(blocks, stop), headers={"content-type": "text/event-stream"}
        )

    client = AsyncAnthropic(
        api_key="test",
        base_url="http://model.test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(answer)),
    )
    ran: list[dict[str, Any]] = []
    tool = _lookup()
    original = tool.execute

    async def execute(args: dict[str, Any]) -> Any:
        ran.append(args)
        return await original(args)

    events: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        events.append(event)

    messages: list[dict[str, Any]] = [{"role": "user", "content": "Write the report."}]
    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,  # type: ignore[arg-type]
            model="claude-sonnet-4-6",
            system=None,
            messages=messages,
            tools=[tool.__class__(**{**tool.__dict__, "execute": execute})],
        )
    )

    async def never() -> bool:
        return False

    result = await run_agent_loop(
        emitter=RunEmitter(run_id="r", sink=sink),
        max_steps=5,
        run_step=step,
        is_cancelled=never,
    )

    assert result.kind == "settled"
    # The cut call never ran, and the text goes on after the cut.
    assert ran == []
    text = "".join(e.text for e in events if isinstance(e, TokenEvent) and e.channel == "text")
    assert text == "Part one, cut mid-sentence. Part two."
    assert len(sent) == 2
    assert [p for body in sent for p in refused(body)] == []
    assert sent[0]["max_tokens"] >= 16_000
    assert sent[1]["messages"][1:] == [
        {"role": "assistant", "content": [{"type": "text", "text": "Part one, cut mid-sen"}]},
        {
            "role": "user",
            "content": [{"type": "text", "text": anthropic_provider.MAX_TOKENS_CONTINUE}],
        },
    ]
