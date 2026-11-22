"""What the Messages API is sent, as the real SDK serialises it.

The fakes elsewhere take any kwargs, so they can't see a body the API
refuses. Here the SDK streams from an in-process transport and each
request body is checked against the SDK's own request param types.
"""

from __future__ import annotations

import json
from typing import Any, get_args, get_type_hints

import httpx
import pytest
from anthropic import AsyncAnthropic
from anthropic.types import (
    TextBlockParam,
    ThinkingBlockParam,
    ToolResultBlockParam,
    ToolUseBlockParam,
)

from agent_py.chat_loop import run_turn_loop
from agent_py.emitter import RunEmitter
from agent_py.providers.anthropic_provider import AnthropicStepConfig, make_anthropic_step_fn
from agent_py.runner import RunStepContext
from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult

PARAMS: dict[str, Any] = {
    "text": TextBlockParam,
    "tool_use": ToolUseBlockParam,
    "tool_result": ToolResultBlockParam,
    "thinking": ThinkingBlockParam,
}


def refused(body: dict[str, Any]) -> list[str]:
    """What the API would refuse: a null `system`, a block key that isn't a
    request param, or null for a param that doesn't take it."""
    problems = []
    if "system" in body and body["system"] is None:
        problems.append("system: null")
    for i, message in enumerate(body["messages"]):
        for block in message["content"] if isinstance(message["content"], list) else []:
            hints = get_type_hints(PARAMS[block["type"]])
            for key, value in block.items():
                if key not in hints:
                    problems.append(f"messages.{i}.{block['type']}.{key}: extra")
                elif value is None and type(None) not in get_args(hints[key]):
                    problems.append(f"messages.{i}.{block['type']}.{key}: null")
    return problems


def _sse(blocks: list[dict[str, Any]]) -> bytes:
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
            delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
        events += [
            {"type": "content_block_start", "index": index, "content_block": start},
            {"type": "content_block_delta", "index": index, "delta": delta},
            {"type": "content_block_stop", "index": index},
        ]
    events += [
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 1},
        },
        {"type": "message_stop"},
    ]
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def _sdk() -> tuple[AsyncAnthropic, list[dict[str, Any]]]:
    sent: list[dict[str, Any]] = []
    turns = [
        [
            {"type": "text", "text": "Looking."},
            {"type": "tool_use", "id": "toolu_1", "name": "lookup", "input": {"q": "x"}},
        ],
        [{"type": "text", "text": "Done."}],
    ]

    def answer(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(
            200, content=_sse(turns[len(sent) - 1]), headers={"content-type": "text/event-stream"}
        )

    client = AsyncAnthropic(
        api_key="test",
        base_url="http://model.test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(answer)),
    )
    return client, sent


def _lookup() -> ToolDescriptor:
    async def execute(_args: dict[str, Any]) -> ToolInvocationResult:
        return ToolInvocationResult(text="found", summary="found")

    return ToolDescriptor(
        name="lookup",
        description="Look up.",
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
        execute=execute,
    )


def _emitter() -> RunEmitter:
    async def sink(_event: object) -> None:
        return None

    return RunEmitter(run_id="r", sink=sink)


@pytest.mark.parametrize("system", [None, "", "Be terse."])
async def test_the_executors_step_sends_what_the_api_takes(system: str | None) -> None:
    client, sent = _sdk()
    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model="claude-sonnet-4-6",
            system=system,
            messages=[{"role": "user", "content": "go"}],
            tools=[_lookup()],
        )
    )
    emitter = _emitter()
    for _ in range(2):
        await emitter.start_step()
        await step(RunStepContext(step=emitter.step, emitter=emitter))
        await emitter.end_step()
    assert len(sent) == 2
    assert [p for body in sent for p in refused(body)] == []
    assert all(("system" in body) == bool(system) for body in sent)


async def test_the_chat_loop_sends_what_the_api_takes() -> None:
    client, sent = _sdk()
    await run_turn_loop(
        client=client,
        emitter=_emitter(),
        model="claude-sonnet-4-6",
        messages=[{"role": "user", "content": "go"}],
        tools=[_lookup()],
    )
    assert len(sent) == 2
    assert [p for body in sent for p in refused(body)] == []


async def test_turns_saved_before_the_fix_are_cleaned_when_sent() -> None:
    client, sent = _sdk()
    saved = [
        {"role": "user", "content": "go"},
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "Looking.", "citations": None, "parsed_output": None},
                {"type": "tool_use", "id": "t0", "name": "lookup", "input": {}, "caller": None},
            ],
        },
        {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "t0", "content": "found"}],
        },
    ]
    await run_turn_loop(
        client=client,
        emitter=_emitter(),
        model="claude-sonnet-4-6",
        messages=saved,
        tools=[_lookup()],
    )
    assert [p for body in sent for p in refused(body)] == []
