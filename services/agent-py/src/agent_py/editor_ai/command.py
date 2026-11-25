"""The editor's AI over Anthropic (wave 9, Q101-Q104): the Next route's
`handler.ts` (`/api/ai/command`) and `/api/ai/complete`, ported.

`command_frames` yields the AI SDK UI message stream (v1) as SSE frames:

* no `tool_name` → one forced `json` tool call classifies the instruction
  (`generate`, `edit` while selecting, `comment`) and the stream opens with
  `data-toolName` — the Next route's `generateObject` enum;
* `start`, `start-step`;
* `generate` / `edit` → the text, through `MarkdownJoiner` (the route's
  `markdownJoinerTransform`, its per-chunk pause included);
* `comment` / an `edit` of table cells → a forced `json` tool call whose
  input is `{"elements": [...]}`, each finished element one `data-comment`
  / `data-table` part (the route's `streamObject` array), then the
  `finished` part;
* `finish-step`; a failure is an `error` part; always `data: [DONE]`.

Not sent: the route's `tool-input-available` / `tool-output-available`
parts. Its comment / table tool is a model call with an empty prompt
whose only output is those parts; Plate's client ignores them.

`complete_text` streams the ghost-text continuation as plain text."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any, Literal

import structlog

from .elements import ArrayElements
from .markdown_joiner import MarkdownJoiner
from .prompts import (
    EditorDocument,
    EditorMessage,
    choose_tool_prompt,
    comment_prompt,
    complete_prompt,
    edit_prompt,
    generate_prompt,
    table_prompt,
)

logger = structlog.get_logger(__name__)

#: An `anthropic.AsyncAnthropic` (`chat.resolve_anthropic_client`). Typed
#: loosely: this module uses `messages.create`, `messages.stream` with tools
#: and temperature, and raw stream events — beyond the chat loop's Protocol.
AnthropicClient = Any

ToolName = Literal["generate", "edit", "comment"]

#: The Next route sets no output cap (the AI SDK's Anthropic default, 4096).
TEXT_MAX_TOKENS = 4096
ELEMENTS_MAX_TOKENS = 4096
CHOOSE_MAX_TOKENS = 64
#: `/api/ai/complete`'s `maxOutputTokens` / `temperature`.
COMPLETE_MAX_TOKENS = 60
COMPLETE_TEMPERATURE = 0.2

STRUCTURED_TOOL = "json"

_COMMENT_ITEM: dict[str, Any] = {
    "type": "object",
    "properties": {
        "blockId": {
            "type": "string",
            "description": "The id of the starting block. If the comment spans multiple blocks, use the id of the first block.",
        },
        "comment": {
            "type": "string",
            "description": "A brief comment or explanation for this fragment.",
        },
        "content": {
            "type": "string",
            "description": (
                "The original document fragment to be commented on.It can be the entire block, "
                "a small part within a block, or span multiple blocks. If spanning multiple "
                "blocks, separate them with two \\n\\n."
            ),
        },
    },
    "required": ["blockId", "comment", "content"],
}

_CELL_ITEM: dict[str, Any] = {
    "type": "object",
    "properties": {
        "content": {
            "type": "string",
            "description": "The new content for the cell. Can contain multiple paragraphs separated by \\n\\n.",
        },
        "id": {"type": "string", "description": "The id of the table cell to update."},
    },
    "required": ["content", "id"],
}


class EditorAiError(Exception):
    """A failure the stream reports as an `error` part (message shown)."""


@dataclass(frozen=True)
class CommandInput:
    messages: tuple[EditorMessage, ...]
    document: EditorDocument
    tool_name: ToolName | None


def frame(part: dict[str, Any] | str) -> str:
    data = (
        part
        if isinstance(part, str)
        else json.dumps(part, ensure_ascii=False, separators=(",", ":"))
    )
    return f"data: {data}\n\n"


DONE = frame("[DONE]")


def _id() -> str:
    return uuid.uuid4().hex


def _structured_tool(schema: dict[str, Any]) -> dict[str, Any]:
    return {
        "tools": [
            {
                "name": STRUCTURED_TOOL,
                "description": "Respond with a JSON object.",
                "input_schema": schema,
            }
        ],
        "tool_choice": {"type": "tool", "name": STRUCTURED_TOOL},
    }


def _field(block: Any, name: str) -> Any:
    return block.get(name) if isinstance(block, dict) else getattr(block, name, None)


async def choose_tool(client: AnthropicClient, model: str, request: CommandInput) -> ToolName:
    """The route's `generateObject({ output: "enum" })`."""
    options: list[ToolName] = (
        ["generate", "edit", "comment"]
        if request.document.is_selecting
        else ["generate", "comment"]
    )
    prompt = choose_tool_prompt(
        is_selecting=request.document.is_selecting, messages=request.messages
    )
    message = await client.messages.create(
        model=model,
        max_tokens=CHOOSE_MAX_TOKENS,
        messages=[{"role": "user", "content": prompt}],
        **_structured_tool(
            {
                "type": "object",
                "properties": {"result": {"type": "string", "enum": list(options)}},
                "required": ["result"],
            }
        ),
    )
    for block in _field(message, "content") or []:
        if _field(block, "type") == "tool_use":
            result = (_field(block, "input") or {}).get("result")
            if result in options:
                return result  # type: ignore[no-any-return]
    raise EditorAiError("The model didn't pick an action the editor offers. Try again.")


async def _text(
    client: AnthropicClient,
    model: str,
    prompt: str,
    delay: Callable[[int], float],
) -> AsyncIterator[str]:
    joiner = MarkdownJoiner()
    text_id = _id()
    started = False
    async with client.messages.stream(
        model=model,
        max_tokens=TEXT_MAX_TOKENS,
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        async for chunk in stream.text_stream:
            if not started:
                started = True
                yield frame({"type": "text-start", "id": text_id})
            out = joiner.process_text(chunk)
            if out:
                yield frame({"type": "text-delta", "id": text_id, "delta": out})
                pause = delay(joiner.delay_ms)
                if pause > 0:
                    await asyncio.sleep(pause)
    if started:
        rest = joiner.flush()
        if rest:
            yield frame({"type": "text-delta", "id": text_id, "delta": rest})
        yield frame({"type": "text-end", "id": text_id})


def _comment(value: Any) -> dict[str, str] | None:
    if isinstance(value, dict) and all(
        isinstance(value.get(k), str) for k in ("blockId", "comment", "content")
    ):
        return {
            "blockId": value["blockId"],
            "comment": value["comment"],
            "content": value["content"],
        }
    return None


def _cell(value: Any) -> dict[str, str] | None:
    if isinstance(value, dict) and all(isinstance(value.get(k), str) for k in ("content", "id")):
        return {"content": value["content"], "id": value["id"]}
    return None


async def _elements(
    client: AnthropicClient,
    model: str,
    prompt: str,
    *,
    item: dict[str, Any],
    part: Literal["data-comment", "data-table"],
    key: Literal["comment", "cellUpdate"],
    valid: Callable[[Any], dict[str, str] | None],
) -> AsyncIterator[str]:
    scanner = ArrayElements()
    async with client.messages.stream(
        model=model,
        max_tokens=ELEMENTS_MAX_TOKENS,
        messages=[{"role": "user", "content": prompt}],
        **_structured_tool(
            {
                "type": "object",
                "properties": {"elements": {"type": "array", "items": item}},
                "required": ["elements"],
            }
        ),
    ) as stream:
        async for event in stream:
            if _field(event, "type") != "content_block_delta":
                continue
            delta = _field(event, "delta")
            if _field(delta, "type") != "input_json_delta":
                continue
            for element in scanner.feed(_field(delta, "partial_json") or ""):
                value = valid(element)
                if value is None:
                    logger.info("editor_ai.element_skipped", part=part)
                    continue
                yield frame(
                    {"id": _id(), "data": {key: value, "status": "streaming"}, "type": part}
                )
    yield frame({"id": _id(), "data": {key: None, "status": "finished"}, "type": part})


def _error_text(exc: BaseException) -> str:
    if isinstance(exc, EditorAiError):
        return str(exc)
    status = getattr(exc, "status_code", None)
    if status == 429:
        return "The model is rate limited. Try again shortly."
    return "The model call failed. Try again."


async def command_frames(
    *,
    client: AnthropicClient,
    model: str,
    request: CommandInput,
    delay: Callable[[int], float],
) -> AsyncIterator[str]:
    doc = request.document
    try:
        tool = request.tool_name
        if tool is None:
            tool = await choose_tool(client, model, request)
            yield frame({"data": tool, "type": "data-toolName"})
        yield frame({"type": "start", "messageId": _id()})
        yield frame({"type": "start-step"})
        messages = request.messages
        if tool == "comment":
            async for out in _elements(
                client,
                model,
                comment_prompt(context=doc.comment_context, messages=messages),
                item=_COMMENT_ITEM,
                part="data-comment",
                key="comment",
                valid=_comment,
            ):
                yield out
        elif tool == "edit" and doc.edit is not None and doc.edit.kind == "table":
            async for out in _elements(
                client,
                model,
                table_prompt(context=doc.edit.context, messages=messages),
                item=_CELL_ITEM,
                part="data-table",
                key="cellUpdate",
                valid=_cell,
            ):
                yield out
        else:
            if tool == "edit":
                if doc.edit is None:
                    raise EditorAiError("Edit needs a selection.")
                prompt = edit_prompt(
                    kind=doc.edit.kind, context=doc.edit.context, messages=messages
                )
            else:
                context = doc.generate_context if doc.is_selecting else None
                prompt = generate_prompt(context=context, messages=messages)
            async for out in _text(client, model, prompt, delay):
                yield out
        yield frame({"type": "finish-step"})
    except Exception as exc:  # the stream is open: report in-band
        logger.warning("editor_ai.command_failed", error=str(exc), kind=type(exc).__name__)
        yield frame({"type": "error", "errorText": _error_text(exc)})
    yield DONE


async def complete_text(
    *,
    client: AnthropicClient,
    model: str,
    block_text: str,
    prefix: str | None,
) -> AsyncIterator[str]:
    """The ghost-text continuation; a failure ends the text (the editor
    swallows completion errors)."""
    try:
        async with client.messages.stream(
            model=model,
            max_tokens=COMPLETE_MAX_TOKENS,
            temperature=COMPLETE_TEMPERATURE,
            messages=[
                {"role": "user", "content": complete_prompt(block_text=block_text, prefix=prefix)}
            ],
        ) as stream:
            async for chunk in stream.text_stream:
                yield chunk
    except Exception as exc:
        logger.warning("editor_ai.complete_failed", error=str(exc), kind=type(exc).__name__)


__all__ = [
    "CommandInput",
    "EditorAiError",
    "ToolName",
    "command_frames",
    "complete_text",
]
