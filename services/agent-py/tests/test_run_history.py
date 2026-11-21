"""`runs/history.py` — AG-UI history → Anthropic turns (wave 3b-C)."""

from __future__ import annotations

import base64
from typing import Any

from agent_py.runs.history import (
    UNANSWERED_TOOL_RESULT,
    attach_tool_results,
    normalize,
    request_taint,
    to_anthropic,
)


def _use(cid: str) -> dict[str, Any]:
    return {"type": "tool_use", "id": cid, "name": "t", "input": {}}


def _res(cid: str, content: str = "r") -> dict[str, Any]:
    return {"type": "tool_result", "tool_use_id": cid, "content": content}


def test_normalize_pairs_calls_drops_orphans_and_starts_with_the_user() -> None:
    msgs = [
        {"role": "assistant", "content": "earlier"},
        {"role": "user", "content": [_res("ghost"), {"type": "text", "text": "q"}]},
        {"role": "assistant", "content": [_use("a"), _use("b")]},
        {
            "role": "user",
            "content": [{"type": "text", "text": "next"}, _res("b"), _res("b", "dup")],
        },
        {"role": "assistant", "content": [_use("c")]},
    ]
    out = normalize(msgs)
    unanswered = {**_res("a", UNANSWERED_TOOL_RESULT), "is_error": True}
    assert out == [
        {"role": "user", "content": "(The conversation continues.)"},
        {"role": "assistant", "content": "earlier"},
        {"role": "user", "content": [{"type": "text", "text": "q"}]},
        {"role": "assistant", "content": [_use("a"), _use("b")]},
        {"role": "user", "content": [unanswered, _res("b"), {"type": "text", "text": "next"}]},
        {"role": "assistant", "content": [_use("c")]},
        {"role": "user", "content": [{**_res("c", UNANSWERED_TOOL_RESULT), "is_error": True}]},
    ]
    assert normalize(out) == out


def test_attach_tool_results_lands_after_the_calling_turn() -> None:
    msgs: list[dict[str, Any]] = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": [_use("a")]},
    ]
    attach_tool_results(msgs, [_res("a", "x"), _res("unknown")])
    assert msgs[-1] == {"role": "user", "content": [_res("a", "x")]}


def test_documents_and_taint() -> None:
    text_doc = base64.b64encode(b"hello").decode()
    msgs = [
        {
            "id": "u",
            "role": "user",
            "content": [
                {
                    "type": "document",
                    "source": {"type": "data", "value": text_doc, "mimeType": "text/plain"},
                },
                {
                    "type": "document",
                    "source": {"type": "data", "value": "AAAA", "mimeType": "application/pdf"},
                },
                {
                    "type": "audio",
                    "source": {"type": "data", "value": "AAAA", "mimeType": "audio/wav"},
                },
            ],
        }
    ]
    (turn,) = to_anthropic(msgs)
    assert turn["content"] == [
        {
            "type": "document",
            "source": {"type": "text", "media_type": "text/plain", "data": "hello"},
        },
        {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": "AAAA"},
        },
    ]
    assert request_taint(msgs) == "an uploaded image or file"
    assert request_taint([{"id": "u", "role": "user", "content": "plain"}]) is None
    tool_before_user = [
        {"id": "t", "role": "tool", "toolCallId": "x", "content": "r"},
        {"id": "u", "role": "user", "content": "q"},
    ]
    assert request_taint(tool_before_user) is None
