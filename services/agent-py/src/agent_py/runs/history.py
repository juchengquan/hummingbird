"""AG-UI `RunAgentInput.messages` → Anthropic Messages API input.

The browser owns the conversation history and sends it with every run
(Q15). This module turns those AG-UI messages into what
`messages.stream(...)` accepts, for the native harness adapter:

| AG-UI message | Anthropic |
|---|---|
| `user` (text, or `text` / `image` / `document` parts) | `user` turn (text / image / document blocks — see *Attachments*) |
| `assistant` (`content` + `toolCalls`) | `assistant` turn (`text` + `tool_use` blocks; `arguments` JSON-decoded) |
| `tool` | `tool_result` block in a `user` turn (`error` → `is_error`) |
| `system` / `developer` | not a turn: their text joins the system prompt (`system_texts`) |
| `reasoning` / `activity` | dropped — display state, never sent to the model (`activity` per RUN_EVENTS.md § 3.3; reasoning has no signature to replay) |

Anthropic's rules are then enforced (`normalize`): turns alternate (same
roles merge), every `tool_use` is answered in the very next `user` turn
(a call the history never answered — an abandoned interrupt — gets an
error `tool_result`; a `tool_result` answering nothing is dropped), and
the first turn is the user's.

**Attachments** (Q32, wave 4b-D) — the media parts of a `user` message:

| part | source | Anthropic block |
|---|---|---|
| `image` | `data`, `mimeType` one of `IMAGE_MEDIA_TYPES` | `image`, base64 source |
| `image` | `url` (`https://` only) | `image`, url source |
| `document` | `data`, `mimeType` `text/*` (extracted text, UTF-8) | `document`, text source |
| `document` | `data`, `application/pdf` | `document`, base64 source |
| `document` | `url` (`https://`, a PDF) | `document`, url source |

A document's `metadata.name` becomes the block's `title`, and
`metadata.truncated: true` adds a `context` note that the text was cut.
Anything else — an `audio` / `video` part, a provider `file` handle, an
unsupported media type, malformed base64, a part over its size limit, or
more images / documents than the limits allow — is refused:
`check_attachments` raises `AttachmentRejected` (the API answers `400
invalid_attachment` before the run exists), rather than the model
silently never seeing what the user attached. `to_anthropic` drops such
a part (defensive: the API already refused it).

Pure — no I/O, no settings.
"""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

__all__ = [
    "IMAGE_MEDIA_TYPES",
    "MAX_DOCUMENTS",
    "MAX_IMAGES",
    "MAX_IMAGE_BASE64_CHARS",
    "MAX_PDF_BASE64_CHARS",
    "MAX_TEXT_DOCUMENT_BYTES",
    "UNANSWERED_TOOL_RESULT",
    "AttachmentRejected",
    "attach_tool_results",
    "attachment_taint",
    "check_attachments",
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

# --- Attachment limits -------------------------------------------------------------

#: The image media types Anthropic accepts.
IMAGE_MEDIA_TYPES: frozenset[str] = frozenset(
    {"image/jpeg", "image/png", "image/gif", "image/webp"}
)
#: Images per request, over the whole history (Anthropic's per-image
#: dimension limit tightens beyond 20; the client attaches images to the
#: newest user message only, as `buildTransmittedMessages` does).
MAX_IMAGES = 20
#: One inline image, as base64 text — Anthropic's 5 MB image limit.
MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024
#: Documents per request — the Next route's `CHAT_ATTACHMENTS_MAX`.
MAX_DOCUMENTS = 40
#: One text document, decoded (the Next route's attachment text fields
#: stay under 220k characters, ≤ 660 KB of UTF-8).
MAX_TEXT_DOCUMENT_BYTES = 1024 * 1024
#: One inline PDF, as base64 text (the request body is capped at 16 MB).
MAX_PDF_BASE64_CHARS = 10 * 1024 * 1024
_MAX_TITLE = 500
_TRUNCATED_CONTEXT = "The text was extracted from the file and truncated."


class AttachmentRejected(ValueError):
    """A user message part the model cannot be given (see *Attachments*
    in the module docstring). The API maps it to `400
    {"code": "invalid_attachment", "message": str(exc)}`."""

    code = "invalid_attachment"


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


#: `attachment_taint`'s label per `RunAttachment` kind — Next's
#: `requestTaint` labels (`untrusted-content-policy.ts`): every attachment
#: kind is content read from outside (a file's extracted text, a fetched
#: page, an MCP resource).
_ATTACHMENT_TAINT: Mapping[str, str] = {
    "file": "an attached file",
    "inlineFile": "an attached file",
    "bookmark": "an attached URL bookmark",
    "mcpResource": "an attached MCP resource",
}


def attachment_taint(kinds: Iterable[str]) -> str | None:
    """The label of the turn's first attachment, by its `RunAttachment`
    `kind` (`forwardedProps.attachments`), else None — the attachment half
    of Next's `requestTaint`."""
    for kind in kinds:
        return _ATTACHMENT_TAINT.get(kind, "an attachment")
    return None


def request_taint(
    messages: Sequence[AgUiMessage], attachment_kinds: Iterable[str] = ()
) -> str | None:
    """Third-party content the request itself puts in context, as a short
    label — mirror of `requestTaint` in
    `lib/server/memory/untrusted-content-policy.ts`: an attachment
    (`attachment_taint`, checked first as Next does), an uploaded image /
    document in a user message, or any tool result after the latest user
    message (this turn's tool output, replayed by the client).
    `attachment_kinds`: the `kind` of each of the turn's attachments."""
    label = attachment_taint(attachment_kinds)
    if label is not None:
        return label
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
        if not isinstance(part, Mapping):
            continue
        try:
            block = _part_block(part)
        except AttachmentRejected:
            continue  # refused at the API (`check_attachments`)
        if block is not None:
            blocks.append(block)
    return blocks


def check_attachments(messages: Iterable[AgUiMessage]) -> None:
    """Raise `AttachmentRejected` unless every media part of every `user`
    message converts (see *Attachments*) and the counts are within
    `MAX_IMAGES` / `MAX_DOCUMENTS`."""
    images = documents = 0
    for i, m in enumerate(messages):
        content = m.get("content")
        if m.get("role") != "user" or not isinstance(content, list):
            continue
        for j, part in enumerate(content):
            if not isinstance(part, Mapping) or part.get("type") == "text":
                continue
            try:
                block = _part_block(part)
            except AttachmentRejected as exc:
                raise AttachmentRejected(f"messages[{i}].content[{j}]: {exc}") from None
            if block is None:
                continue
            if block["type"] == "image":
                images += 1
            else:
                documents += 1
    if images > MAX_IMAGES:
        raise AttachmentRejected(f"Too many images: {images} (at most {MAX_IMAGES} per run).")
    if documents > MAX_DOCUMENTS:
        raise AttachmentRejected(
            f"Too many documents: {documents} (at most {MAX_DOCUMENTS} per run)."
        )


def _mib(n: int) -> str:
    return f"{n / (1024 * 1024):g} MiB"


def _b64decode(value: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise AttachmentRejected("the data is not valid base64.") from None


def _https(value: str, kind: str) -> str:
    if not value.lower().startswith("https://"):
        raise AttachmentRejected(f"an {kind} URL must be an https:// URL.")
    return value


def _part_block(part: Mapping[str, object]) -> dict[str, Any] | None:
    """One user message part as an Anthropic block; None for an empty
    text part. Raises `AttachmentRejected` for a media part that cannot
    be given to the model."""
    kind = part.get("type")
    if kind == "text":
        text = part.get("text")
        return {"type": "text", "text": text} if isinstance(text, str) and text else None
    if kind not in ("image", "document"):
        raise AttachmentRejected(f"{kind!s} parts are not supported (images and documents are).")
    source = part.get("source")
    if not isinstance(source, Mapping):
        raise AttachmentRejected(f"the {kind} has no source.")
    src_type = source.get("type")
    value = source.get("value")
    mime = source.get("mimeType")
    if not isinstance(value, str) or not value:
        raise AttachmentRejected(f"the {kind} source is empty.")
    if src_type == "file":
        raise AttachmentRejected("provider file handles are not supported; send the data inline.")
    if kind == "image":
        if src_type == "url":
            return {"type": "image", "source": {"type": "url", "url": _https(value, "image")}}
        if mime not in IMAGE_MEDIA_TYPES:
            raise AttachmentRejected(
                f"image type {mime!s} is not supported ({', '.join(sorted(IMAGE_MEDIA_TYPES))})."
            )
        if len(value) > MAX_IMAGE_BASE64_CHARS:
            raise AttachmentRejected(
                f"the image is too large ({_mib(len(value))} of base64; "
                f"at most {_mib(MAX_IMAGE_BASE64_CHARS)})."
            )
        _b64decode(value)
        return {"type": "image", "source": {"type": "base64", "media_type": mime, "data": value}}
    block: dict[str, Any]
    if src_type == "url":
        if isinstance(mime, str) and mime != "application/pdf":
            raise AttachmentRejected("a document URL must point to a PDF.")
        block = {"type": "document", "source": {"type": "url", "url": _https(value, "document")}}
    elif mime == "application/pdf":
        if len(value) > MAX_PDF_BASE64_CHARS:
            raise AttachmentRejected(
                f"the PDF is too large ({_mib(len(value))} of base64; "
                f"at most {_mib(MAX_PDF_BASE64_CHARS)})."
            )
        _b64decode(value)
        block = {
            "type": "document",
            "source": {"type": "base64", "media_type": mime, "data": value},
        }
    elif isinstance(mime, str) and mime.startswith("text/"):
        raw = _b64decode(value)
        if len(raw) > MAX_TEXT_DOCUMENT_BYTES:
            raise AttachmentRejected(
                f"the document is too large ({_mib(len(raw))}; "
                f"at most {_mib(MAX_TEXT_DOCUMENT_BYTES)} of text)."
            )
        text = raw.decode("utf-8", errors="replace")
        if not text.strip():
            raise AttachmentRejected("the document is empty.")
        block = {
            "type": "document",
            "source": {"type": "text", "media_type": "text/plain", "data": text},
        }
    else:
        raise AttachmentRejected(
            f"document type {mime!s} is not supported (text/* or application/pdf)."
        )
    metadata = part.get("metadata")
    if isinstance(metadata, Mapping):
        name = metadata.get("name")
        if isinstance(name, str) and name.strip():
            block["title"] = name.strip()[:_MAX_TITLE]
        if metadata.get("truncated") is True:
            block["context"] = _TRUNCATED_CONTEXT
    return block


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
