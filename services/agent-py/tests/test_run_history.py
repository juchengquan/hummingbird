"""`runs/history.py` — AG-UI history → Anthropic turns (wave 3b-C)."""

from __future__ import annotations

import base64
import re
from typing import Any

import pytest

from agent_py.runs.history import (
    MAX_DOCUMENTS,
    MAX_IMAGE_BASE64_CHARS,
    MAX_IMAGES,
    MAX_PDF_BASE64_CHARS,
    MAX_TEXT_DOCUMENT_BYTES,
    UNANSWERED_TOOL_RESULT,
    AttachmentRejected,
    attach_tool_results,
    check_attachments,
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


# --- attachments (wave 4b-D) -----------------------------------------------------------

PNG = base64.b64encode(b"\x89PNG fake").decode()
HELLO = base64.b64encode("héllo".encode()).decode()


def _img(value: str = PNG, mime: str = "image/png", src: str = "data") -> dict[str, Any]:
    source: dict[str, Any] = {"type": src, "value": value}
    if src == "data":
        source["mimeType"] = mime
    return {"type": "image", "source": source}


def _doc(
    value: str = HELLO,
    mime: str | None = "text/plain",
    src: str = "data",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    source: dict[str, Any] = {"type": src, "value": value}
    if mime is not None:
        source["mimeType"] = mime
    part: dict[str, Any] = {"type": "document", "source": source}
    if metadata is not None:
        part["metadata"] = metadata
    return part


def _msg(*parts: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"id": "u", "role": "user", "content": [*parts, {"type": "text", "text": "what?"}]}]


CONVERTS: list[tuple[str, dict[str, Any], dict[str, Any]]] = [
    (
        "png data",
        _img(),
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": PNG}},
    ),
    (
        "webp data",
        _img(mime="image/webp"),
        {"type": "image", "source": {"type": "base64", "media_type": "image/webp", "data": PNG}},
    ),
    (
        "image url",
        _img("https://cdn.example/a.png", src="url"),
        {"type": "image", "source": {"type": "url", "url": "https://cdn.example/a.png"}},
    ),
    (
        "text document (utf-8)",
        _doc(),
        {
            "type": "document",
            "source": {"type": "text", "media_type": "text/plain", "data": "héllo"},
        },
    ),
    (
        "markdown document, titled and truncated",
        _doc(mime="text/markdown", metadata={"name": " notes.md ", "truncated": True}),
        {
            "type": "document",
            "source": {"type": "text", "media_type": "text/plain", "data": "héllo"},
            "title": "notes.md",
            "context": "The text was extracted from the file and truncated.",
        },
    ),
    (
        "pdf data",
        _doc("AAAA", "application/pdf"),
        {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": "AAAA"},
        },
    ),
    (
        "pdf url",
        _doc("https://x.example/a.pdf", None, "url"),
        {"type": "document", "source": {"type": "url", "url": "https://x.example/a.pdf"}},
    ),
]


@pytest.mark.parametrize(("part", "block"), [c[1:] for c in CONVERTS], ids=[c[0] for c in CONVERTS])
def test_attachment_parts_become_anthropic_blocks(
    part: dict[str, Any], block: dict[str, Any]
) -> None:
    msgs = _msg(part)
    check_attachments(msgs)
    (turn,) = to_anthropic(msgs)
    assert turn["content"] == [block, {"type": "text", "text": "what?"}]


REJECTS: list[tuple[str, list[dict[str, Any]], str]] = [
    (
        "audio part",
        _msg(
            {"type": "audio", "source": {"type": "data", "value": "AA==", "mimeType": "audio/wav"}}
        ),
        "audio parts are not supported",
    ),
    ("provider file handle", _msg(_img("file_123", src="file")), "provider file handles"),
    ("svg image", _msg(_img(mime="image/svg+xml")), "image type image/svg+xml is not supported"),
    ("http image url", _msg(_img("http://x.example/a.png", src="url")), "https:// URL"),
    (
        "data: url as url source",
        _msg(_img("data:image/png;base64,AAAA", src="url")),
        "https:// URL",
    ),
    ("bad base64 image", _msg(_img("not base64!")), "not valid base64"),
    ("bad base64 document", _msg(_doc("@@@")), "not valid base64"),
    ("oversized image", _msg(_img("A" * (MAX_IMAGE_BASE64_CHARS + 4))), "the image is too large"),
    (
        "oversized pdf",
        _msg(_doc("A" * (MAX_PDF_BASE64_CHARS + 4), "application/pdf")),
        "the PDF is too large",
    ),
    (
        "oversized text document",
        _msg(_doc(base64.b64encode(b"x" * (MAX_TEXT_DOCUMENT_BYTES + 1)).decode())),
        "the document is too large",
    ),
    ("empty text document", _msg(_doc(base64.b64encode(b"  ").decode())), "the document is empty"),
    (
        "docx document",
        _msg(_doc(mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
        "is not supported (text/* or application/pdf)",
    ),
    (
        "non-pdf document url",
        _msg(_doc("https://x.example/a.txt", "text/plain", "url")),
        "must point to a PDF",
    ),
    ("no source", _msg({"type": "image"}), "has no source"),
    ("too many images", _msg(*[_img()] * (MAX_IMAGES + 1)), f"Too many images: {MAX_IMAGES + 1}"),
    (
        "too many documents",
        _msg(*[_doc()] * (MAX_DOCUMENTS + 1)),
        f"Too many documents: {MAX_DOCUMENTS + 1}",
    ),
]


@pytest.mark.parametrize(("msgs", "message"), [c[1:] for c in REJECTS], ids=[c[0] for c in REJECTS])
def test_attachments_beyond_the_rules_are_refused(msgs: list[dict[str, Any]], message: str) -> None:
    with pytest.raises(AttachmentRejected, match=re.escape(message)) as info:
        check_attachments(msgs)
    assert info.value.code == "invalid_attachment"


def test_rejection_names_the_part_and_conversion_drops_it() -> None:
    msgs = [
        {"id": "a", "role": "assistant", "content": "earlier"},
        *_msg(_img(), _img(mime="image/tiff")),
    ]
    with pytest.raises(AttachmentRejected, match=r"^messages\[1\]\.content\[1\]: image type"):
        check_attachments(msgs)
    # Defensive: the converter (behind the API's check) drops what it
    # cannot convert rather than failing the run.
    turns = to_anthropic(msgs)
    assert [b["type"] for b in turns[-1]["content"]] == ["image", "text"]


def test_limits_count_the_whole_history_and_ignore_other_roles() -> None:
    half = [_img()] * (MAX_IMAGES // 2)
    history = [
        {"id": "u1", "role": "user", "content": half},
        {"id": "a1", "role": "assistant", "content": "ok"},
        {"id": "t", "role": "tool", "toolCallId": "x", "content": [_img(mime="image/tiff")]},
        {"id": "u2", "role": "user", "content": half},
    ]
    check_attachments(history)  # exactly MAX_IMAGES, the tool message is not checked
    with pytest.raises(AttachmentRejected, match="Too many images"):
        check_attachments([*history, {"id": "u3", "role": "user", "content": [_img()]}])
