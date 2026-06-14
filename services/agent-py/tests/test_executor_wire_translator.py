"""Tests for the AI-SDK → Anthropic wire translator in executor.py.

Covers the translation rules in
docs/superpowers/specs/2026-06-14-agent-py-ai-sdk-translator-design.md.
All tests are pure (no DB, no Anthropic SDK call) — the translator is
a pure function over `dict[str, Any]` block shapes.
"""

from __future__ import annotations

import pytest

from agent_py import executor

# ---- Block-level rules ----------------------------------------------------


def test_text_block_passes_through() -> None:
    block = {"type": "text", "text": "hello"}
    assert executor._translate_block(block) == {"type": "text", "text": "hello"}


def test_image_block_url() -> None:
    block = {"type": "image", "image": "https://example.com/x.png"}
    assert executor._translate_block(block) == {
        "type": "image",
        "source": {"type": "url", "url": "https://example.com/x.png"},
    }


def test_image_block_data_uri() -> None:
    block = {"type": "image", "image": "data:image/png;base64,AAAA"}
    assert executor._translate_block(block) == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"},
    }


def test_file_block_pdf_url() -> None:
    block = {
        "type": "file",
        "data": "https://example.com/x.pdf",
        "mediaType": "application/pdf",
        "filename": "x.pdf",
    }
    assert executor._translate_block(block) == {
        "type": "document",
        "source": {"type": "url", "url": "https://example.com/x.pdf"},
    }


def test_file_block_pdf_data_uri() -> None:
    block = {
        "type": "file",
        "data": "data:application/pdf;base64,BBBB",
        "mediaType": "application/pdf",
        "filename": "x.pdf",
    }
    assert executor._translate_block(block) == {
        "type": "document",
        "source": {"type": "base64", "media_type": "application/pdf", "data": "BBBB"},
    }


def test_file_block_non_pdf_is_dropped() -> None:
    block = {
        "type": "file",
        "data": "https://example.com/x.txt",
        "mediaType": "text/plain",
        "filename": "x.txt",
    }
    assert executor._translate_block(block) is None


def test_tool_call_block_maps_to_tool_use() -> None:
    block = {
        "type": "tool-call",
        "toolCallId": "tu_1",
        "toolName": "webFetch",
        "input": {"url": "https://example.com"},
    }
    assert executor._translate_block(block) == {
        "type": "tool_use",
        "id": "tu_1",
        "name": "webFetch",
        "input": {"url": "https://example.com"},
    }


def test_tool_call_empty_id_falls_back_to_unknown() -> None:
    block = {"type": "tool-call", "toolCallId": "", "toolName": "webFetch", "input": {}}
    out = executor._translate_block(block)
    assert out is not None
    assert out["id"] == "unknown"


def test_tool_result_text_envelope() -> None:
    block = {
        "type": "tool-result",
        "toolCallId": "tu_1",
        "output": {"type": "text", "value": "page contents"},
    }
    assert executor._translate_block(block) == {
        "type": "tool_result",
        "tool_use_id": "tu_1",
        "content": "page contents",
        "is_error": False,
    }


def test_tool_result_json_envelope() -> None:
    block = {
        "type": "tool-result",
        "toolCallId": "tu_1",
        "output": {"type": "json", "value": {"answer": 42}},
    }
    out = executor._translate_block(block)
    assert out is not None
    assert out["type"] == "tool_result"
    assert out["tool_use_id"] == "tu_1"
    assert out["is_error"] is False
    assert '"answer": 42' in out["content"]  # JSON stringified


def test_tool_result_error_text_envelope() -> None:
    block = {
        "type": "tool-result",
        "toolCallId": "tu_1",
        "output": {"type": "error-text", "value": "boom"},
    }
    assert executor._translate_block(block) == {
        "type": "tool_result",
        "tool_use_id": "tu_1",
        "content": "boom",
        "is_error": True,
    }


def test_tool_result_error_json_envelope() -> None:
    block = {
        "type": "tool-result",
        "toolCallId": "tu_1",
        "output": {"type": "error-json", "value": {"code": 500}},
    }
    out = executor._translate_block(block)
    assert out is not None
    assert out["is_error"] is True
    assert '"code": 500' in out["content"]


def test_tool_result_content_envelope_with_inner_text_blocks() -> None:
    block = {
        "type": "tool-result",
        "toolCallId": "tu_1",
        "output": {
            "type": "content",
            "value": [{"type": "text", "text": "first"}, {"type": "text", "text": "second"}],
        },
    }
    assert executor._translate_block(block) == {
        "type": "tool_result",
        "tool_use_id": "tu_1",
        "content": [{"type": "text", "text": "first"}, {"type": "text", "text": "second"}],
        "is_error": False,
    }


def test_reasoning_block_maps_to_redacted_thinking() -> None:
    out = executor._translate_block({"type": "reasoning", "text": "deep thoughts"})
    assert out == {
        "type": "redacted_thinking",
        "data": executor._REDACTED_THINKING_SENTINEL,
    }


def test_unknown_block_type_is_dropped() -> None:
    assert executor._translate_block({"type": "tool-output-available", "x": 1}) is None


def test_provider_options_field_is_dropped() -> None:
    out = executor._translate_block(
        {"type": "text", "text": "hi", "providerOptions": {"anthropic": {"x": 1}}}
    )
    assert out == {"type": "text", "text": "hi"}


# ---- Message-level rules --------------------------------------------------


def test_role_tool_message_remaps_to_user() -> None:
    msg = {
        "role": "tool",
        "content": [
            {"type": "tool-result", "toolCallId": "tu_1", "output": {"type": "text", "value": "x"}},
        ],
    }
    assert executor._translate_ai_sdk_message(msg) == {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "tu_1", "content": "x", "is_error": False}
        ],
    }


def test_mixed_shape_messages_array() -> None:
    # A TS-originated user turn (AI SDK image block) + an Anthropic-shaped
    # assistant turn (tool_use block) + a role:'tool' tool_result message.
    # All three must translate cleanly.
    checkpoint = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": "https://example.com/x.png"},
                ],
            },
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "tu_1", "name": "webFetch", "input": {}},
                ],
            },
            {
                "role": "tool",
                "content": [
                    {
                        "type": "tool-result",
                        "toolCallId": "tu_1",
                        "output": {"type": "text", "value": "page"},
                    },
                ],
            },
        ]
    }
    out = executor._messages_from(checkpoint)
    assert out == [
        {
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "url", "url": "https://example.com/x.png"}},
            ],
        },
        {
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": "tu_1", "name": "webFetch", "input": {}},
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "tu_1",
                    "content": "page",
                    "is_error": False,
                },
            ],
        },
    ]


# ---- _messages_from regression guard --------------------------------------


def test_messages_from_anthropic_shape_is_byte_identical_to_pre_change() -> None:
    """A checkpoint in Anthropic shape (what Python writes) must produce
    byte-identical output to the pre-change _messages_from. This is the
    same-stack-Python resume regression guard."""
    checkpoint = {
        "messages": [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "fetching"},
                    {"type": "tool_use", "id": "tu_1", "name": "webFetch", "input": {"url": "x"}},
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "tu_1",
                        "content": "ok",
                        "is_error": False,
                    },
                ],
            },
        ]
    }
    out = executor._messages_from(checkpoint)
    assert out == checkpoint["messages"]


# ---- warn-once ------------------------------------------------------------


def test_warn_unknown_block_kind_fires_once_per_kind(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Per-process set; reset for this test (and via the autouse
    reset_module_state fixture, the set is a module attribute we
    mutate directly here)."""
    calls: list[str] = []
    monkeypatch.setattr(
        executor,
        "structlog",
        type("S", (), {"get_logger": staticmethod(lambda: _Recorder(calls))})(),
    )
    executor._warned_unknown_block_kinds.clear()
    executor._warn_unknown_block_kind("mystery-a")
    executor._warn_unknown_block_kind("mystery-a")
    executor._warn_unknown_block_kind("mystery-b")
    assert calls == [
        "executor.unknown_ai_sdk_block_kind:mystery-a",
        "executor.unknown_ai_sdk_block_kind:mystery-b",
    ]


class _Recorder:
    def __init__(self, sink: list[str]) -> None:
        self.sink = sink

    def warning(self, event: str, **fields: object) -> None:
        self.sink.append(f"{event}:{fields.get('block_type', '')}")
