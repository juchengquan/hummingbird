"""AG-UI `RunAgentInput.messages` → Anthropic Messages API input.

The browser owns the conversation history and sends it with every run
(Q15). This module turns those AG-UI messages into what
`messages.stream(...)` accepts, for the native harness adapter:

| AG-UI message | Anthropic |
|---|---|
| `user` (text, or `text` / `image` / `document` parts) | `user` turn (text / image / document blocks) |
| `assistant` (`content` + `toolCalls`) | `assistant` turn (`text` + `tool_use` blocks; `arguments` JSON-decoded) |
| `tool` | `tool_result` block in a `user` turn (`error` → `is_error`) |
| `system` / `developer` | not a turn: their text joins the system prompt (`system_texts`) |
| `reasoning` / `activity` | dropped — display state, never sent to the model (`activity` per RUN_EVENTS.md § 3.3; reasoning has no signature to replay) |

Anthropic's rules are then enforced (`normalize`): turns alternate (same
roles merge), every `tool_use` is answered in the very next `user` turn
(a call the history never answered — an abandoned interrupt — gets an
error `tool_result`; a `tool_result` answering nothing is dropped), and
the first turn is the user's.

Pure — no I/O, no settings.
"""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

__all__ = [
    "UNANSWERED_TOOL_RESULT",
    "attach_tool_results",
    "find_tool_call",
    "last_user_index",
    "last_user_text",
    "normalize",
    "request_taint",
    "system_texts",
    "to_anthropic",
]

UNANSWERED_TOOL_RESULT = "(No result: this tool call was never completed.)"

AgUiMessage = Mapping[str, object]


def last_user_index(messages: Sequence[AgUiMessage]) -> int:
    """Index of the last `user` message, -1 when there is none."""
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            return i
    return -1


def last_user_text(messages: Sequence[AgUiMessage]) -> str:
    """The last `user` message's text (its `text` parts joined by
    newlines); "" when there is none."""
    i = last_user_index(messages)
    if i < 0:
        return ""
    content = messages[i].get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        str(p.get("text"))
        for p in content
        if isinstance(p, Mapping) and p.get("type") == "text" and isinstance(p.get("text"), str)
    )


def system_texts(messages: Iterable[AgUiMessage]) -> list[str]:
    """The text of every `system` / `developer` message, in order."""
    out: list[str] = []
    for m in messages:
        if m.get("role") in ("system", "developer"):
            content = m.get("content")
            if isinstance(content, str) and content.strip():
                out.append(content)
    return out


def request_taint(messages: Sequence[AgUiMessage]) -> str | None:
    """Third-party content the history itself puts in context, as a short
    label — mirror of `requestTaint` in
    `lib/server/memory/untrusted-content-policy.ts`: an uploaded image /
    document in a user message, or any tool result after the latest user
    message (this turn's tool output, replayed by the client)."""
    last_user = last_user_index(messages)
    for i, m in enumerate(messages):
        role = m.get("role")
        content = m.get("content")
        if role == "user" and isinstance(content, list):
            for part in content:
                if isinstance(part, Mapping) and part.get("type") in (
                    "image",
                    "document",
                    "audio",
                    "video",
                ):
                    return "an uploaded image or file"
        if i > last_user and role == "tool":
            return "a tool result in the history"
    return None


def find_tool_call(
    messages: Sequence[AgUiMessage], tool_call_id: str
) -> tuple[str, dict[str, Any]] | None:
    """`(tool name, args)` of the assistant tool call with this id, the
    most recent first; None when no assistant message holds it."""
    for m in reversed(messages):
        if m.get("role") != "assistant":
            continue
        for call in _tool_calls(m):
            if call["id"] == tool_call_id:
                return call["name"], call["input"]
    return None


# --- Translation -------------------------------------------------------------------


def to_anthropic(messages: Iterable[AgUiMessage]) -> list[dict[str, Any]]:
    """Translate, dropping what the model never sees, and merge adjacent
    same-role turns. Tool-call pairing is left to `normalize`."""
    out: list[dict[str, Any]] = []
    for m in messages:
        turn = _translate(m)
        if turn is not None:
            _append_merged(out, turn)
    return out


def _translate(m: AgUiMessage) -> dict[str, Any] | None:
    role = m.get("role")
    if role == "user":
        content = _user_content(m.get("content"))
        return None if not content else {"role": "user", "content": content}
    if role == "assistant":
        blocks: list[dict[str, Any]] = []
        text = m.get("content")
        if isinstance(text, str) and text:
            blocks.append({"type": "text", "text": text})
        for call in _tool_calls(m):
            blocks.append(
                {"type": "tool_use", "id": call["id"], "name": call["name"], "input": call["input"]}
            )
        return {"role": "assistant", "content": blocks} if blocks else None
    if role == "tool":
        call_id = m.get("toolCallId")
        if not isinstance(call_id, str) or not call_id:
            return None
        result = _tool_result_text(m.get("content"))
        error = m.get("error")
        block: dict[str, Any] = {"type": "tool_result", "tool_use_id": call_id}
        if isinstance(error, str) and error:
            block["content"] = result or error
            block["is_error"] = True
        else:
            block["content"] = result
        return {"role": "user", "content": [block]}
    return None


def _tool_calls(m: AgUiMessage) -> list[dict[str, Any]]:
    raw = m.get("toolCalls")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for call in raw:
        if not isinstance(call, Mapping):
            continue
        call_id = call.get("id")
        fn = call.get("function")
        if not isinstance(call_id, str) or not call_id or not isinstance(fn, Mapping):
            continue
        name = fn.get("name")
        if not isinstance(name, str) or not name:
            continue
        args: dict[str, Any] = {}
        raw_args = fn.get("arguments")
        if isinstance(raw_args, str) and raw_args.strip():
            try:
                decoded = json.loads(raw_args)
            except ValueError:
                decoded = None
            if isinstance(decoded, dict):
                args = decoded
        out.append({"id": call_id, "name": name, "input": args})
    return out


def _user_content(content: object) -> str | list[dict[str, Any]]:
    if isinstance(content, str):
        return content if content.strip() else ""
    if not isinstance(content, list):
        return ""
    blocks: list[dict[str, Any]] = []
    for part in content:
        if isinstance(part, Mapping):
            block = _part_block(part)
            if block is not None:
                blocks.append(block)
    return blocks


def _part_block(part: Mapping[str, object]) -> dict[str, Any] | None:
    kind = part.get("type")
    if kind == "text":
        text = part.get("text")
        return {"type": "text", "text": text} if isinstance(text, str) and text else None
    source = part.get("source")
    if kind not in ("image", "document") or not isinstance(source, Mapping):
        return None
    src_type = source.get("type")
    value = source.get("value")
    mime = source.get("mimeType")
    if not isinstance(value, str) or not value:
        return None
    if src_type == "url":
        return {"type": kind, "source": {"type": "url", "url": value}}
    if src_type != "data" or not isinstance(mime, str):
        return None  # provider file handles are not ours to resolve
    if kind == "image" and mime.startswith("image/"):
        return {"type": "image", "source": {"type": "base64", "media_type": mime, "data": value}}
    if kind == "document" and mime == "application/pdf":
        return {
            "type": "document",
            "source": {"type": "base64", "media_type": mime, "data": value},
        }
    if kind == "document" and mime.startswith("text/"):
        try:
            text = base64.b64decode(value, validate=True).decode("utf-8", errors="replace")
        except (binascii.Error, ValueError):
            return None
        return {
            "type": "document",
            "source": {"type": "text", "media_type": "text/plain", "data": text},
        }
    return None


def _tool_result_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = [
            p["text"]
            for p in content
            if isinstance(p, Mapping) and p.get("type") == "text" and isinstance(p.get("text"), str)
        ]
        return "\n".join(texts)
    return ""


def _as_blocks(content: object) -> list[dict[str, Any]]:
    if isinstance(content, list):
        return list(content)
    if isinstance(content, str) and content:
        return [{"type": "text", "text": content}]
    return []


def _append_merged(out: list[dict[str, Any]], turn: dict[str, Any]) -> None:
    if out and out[-1]["role"] == turn["role"]:
        prev = out[-1]
        out[-1] = {
            "role": prev["role"],
            "content": _as_blocks(prev["content"]) + _as_blocks(turn["content"]),
        }
    else:
        out.append(turn)


# --- Anthropic's turn rules ------------------------------------------------------------


def _tool_use_ids(turn: Mapping[str, Any]) -> list[str]:
    content = turn.get("content")
    if turn.get("role") != "assistant" or not isinstance(content, list):
        return []
    return [
        str(b.get("id"))
        for b in content
        if isinstance(b, Mapping) and b.get("type") == "tool_use" and b.get("id")
    ]


def attach_tool_results(messages: list[dict[str, Any]], results: Iterable[dict[str, Any]]) -> None:
    """Put each `tool_result` block into the user turn right after the
    assistant turn holding its `tool_use` (creating that turn), in place.
    A result whose call is not in `messages` is ignored."""
    for block in results:
        call_id = block.get("tool_use_id")
        for i in range(len(messages) - 1, -1, -1):
            if call_id in _tool_use_ids(messages[i]):
                nxt = messages[i + 1] if i + 1 < len(messages) else None
                if nxt is not None and nxt["role"] == "user":
                    nxt["content"] = [*_as_blocks(nxt["content"]), block]
                else:
                    messages.insert(i + 1, {"role": "user", "content": [block]})
                break


def normalize(
    messages: Iterable[dict[str, Any]], *, user_first: bool = True
) -> list[dict[str, Any]]:
    """Enforce the pairing and alternation rules (see the module
    docstring). Returns a new list; idempotent. `user_first=False` for a
    slice that continues a conversation (it may start with the
    assistant)."""
    out: list[dict[str, Any]] = []
    expected: list[str] = []
    for turn in messages:
        if turn["role"] == "user":
            blocks = _as_blocks(turn["content"])
            results: dict[str, dict[str, Any]] = {}
            rest: list[dict[str, Any]] = []
            for b in blocks:
                if isinstance(b, Mapping) and b.get("type") == "tool_result":
                    cid = b.get("tool_use_id")
                    if cid in expected and cid not in results:
                        results[str(cid)] = dict(b)
                else:
                    rest.append(b)
            if expected:
                paired = [results.get(cid) or _unanswered(cid) for cid in expected]
                content: str | list[dict[str, Any]] = paired + rest
            elif not rest:
                continue
            else:
                content = turn["content"] if isinstance(turn["content"], str) else rest
            expected = []
            _append_merged(out, {"role": "user", "content": content})
            continue
        if expected:
            _append_merged(out, {"role": "user", "content": [_unanswered(cid) for cid in expected]})
        _append_merged(out, {"role": turn["role"], "content": turn["content"]})
        # (Merging never joins two turns with calls: a turn with calls is
        # always followed by its results turn, inserted just above.)
        expected = _tool_use_ids(out[-1])
    if expected:
        out.append({"role": "user", "content": [_unanswered(cid) for cid in expected]})
    if user_first and out and out[0]["role"] != "user":
        out.insert(0, {"role": "user", "content": "(The conversation continues.)"})
    return out


def _unanswered(call_id: str) -> dict[str, Any]:
    return {
        "type": "tool_result",
        "tool_use_id": call_id,
        "content": UNANSWERED_TOOL_RESULT,
        "is_error": True,
    }
