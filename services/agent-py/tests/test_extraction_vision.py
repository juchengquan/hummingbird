"""The PDF vision pass (wave 12) — port of `lib/server/extraction/heuristics.ts`,
`vision.ts`, `vision-model.ts`, `render-pdf.ts` and `maybeAddVision`
(`lib/server/extraction.ts`)."""

from __future__ import annotations

import io
import struct
import zlib
from collections.abc import AsyncIterator
from typing import Any

import pytest

from agent_py import extraction_vision as ev
from agent_py.extraction import ExtractionResult
from agent_py.model_allowlist import parse_allowlist
from agent_py.model_routes import Provider


def _pdf(text: str = "") -> ExtractionResult:
    return ExtractionResult(kind="pdf", text=text, truncated=False)


# --- should_use_vision -------------------------------------------------------


def test_low_yield_pdf_wants_vision() -> None:
    assert ev.should_use_vision(_pdf("x" * 50), 200 * 1024) is True


def test_table_dense_pdf_wants_vision() -> None:
    assert ev.should_use_vision(_pdf("\n".join(["A   1   2   3"] * 40)), 4 * 1024) is True
    # Two-space gaps sharing a boundary character still count twice.
    assert ev.should_use_vision(_pdf("\n".join(["A  B  C"] * 40)), 4 * 1024) is True


def test_prose_pdf_and_other_kinds_do_not() -> None:
    prose = "This is a normal paragraph of prose. " * 200
    assert ev.should_use_vision(_pdf(prose), 8 * 1024) is False
    assert (
        ev.should_use_vision(ExtractionResult(kind="markdown", text="x", truncated=False), 10)
        is False
    )
    assert (
        ev.should_use_vision(ExtractionResult(kind="image", text="", truncated=False), 10) is False
    )


def test_the_full_text_is_what_is_judged() -> None:
    result = ExtractionResult(kind="pdf", text="x", truncated=True, full_text="x" * 10_000)
    assert ev.should_use_vision(result, 100_000) is False


# --- merge_vision_text --------------------------------------------------------


def test_merge_replaces_the_text_and_keeps_the_kind() -> None:
    merged = ev.merge_vision_text(_pdf("flat"), "| A | B |\n|---|---|")
    assert merged.kind == "pdf"
    assert merged.text == "| A | B |\n|---|---|"
    assert merged.truncated is False and merged.full_text is None


def test_merge_respects_the_budgets() -> None:
    merged = ev.merge_vision_text(_pdf("small"), "y" * (2 * 1024 * 1024))
    assert merged.truncated is True
    assert len(merged.text) == 100 * 1024
    assert merged.full_text is not None and len(merged.full_text) == 1024 * 1024


# --- resolve_vision_model ------------------------------------------------------


def _allowlist(*, gateway: bool = True) -> Any:
    raw = {
        "models": [
            {"id": "anthropic/claude-haiku-4.5", "anthropicModelId": "claude-haiku-4-5"},
            {
                "id": "anthropic/claude-sonnet-4.6",
                "anthropicModelId": "claude-sonnet-4-6",
                "supportsVision": True,
            },
            {
                "id": "anthropic/claude-opus-4.7",
                "anthropicModelId": "claude-opus-4-7",
                "supportsVision": True,
            },
        ]
    }
    providers = (
        {"anthropic": Provider("anthropic", "https://api.anthropic.com", api_key="k")}
        if gateway
        else {}
    )
    return parse_allowlist(raw, default_model="anthropic/claude-haiku-4.5", providers=providers)


def test_vision_model_is_the_override_when_it_sees() -> None:
    allow = _allowlist()
    assert (
        ev.resolve_vision_model(allow, "anthropic/claude-opus-4.7") == "anthropic/claude-opus-4.7"
    )


def test_vision_model_falls_back_to_the_first_seeing_catalog_model() -> None:
    allow = _allowlist()
    assert ev.resolve_vision_model(allow, "") == "anthropic/claude-sonnet-4.6"
    # An override that can't see is ignored, as on Next.
    assert (
        ev.resolve_vision_model(allow, "anthropic/claude-haiku-4.5")
        == "anthropic/claude-sonnet-4.6"
    )


def test_no_served_vision_model_means_none() -> None:
    assert ev.resolve_vision_model(_allowlist(gateway=False), "") is None


# --- rendering -----------------------------------------------------------------


def _png_size(png: bytes) -> tuple[int, int]:
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    width, height = struct.unpack(">II", png[16:24])
    return width, height


def test_encode_png_is_a_valid_rgb_png() -> None:
    rgb = bytes([255, 0, 0]) * 4  # 2x2 red
    png = ev.encode_png(rgb, width=2, height=2, stride=6)
    assert _png_size(png) == (2, 2)
    # IDAT holds the four pixels behind per-row filter bytes.
    idat = png.index(b"IDAT")
    (length,) = struct.unpack(">I", png[idat - 4 : idat])
    raw = zlib.decompress(png[idat + 4 : idat + 4 + length])
    assert raw == b"\x00" + bytes([255, 0, 0]) * 2 + b"\x00" + bytes([255, 0, 0]) * 2


def test_render_pdf_pages_caps_the_page_count() -> None:
    from pypdf import PdfWriter

    writer = PdfWriter()
    for _ in range(3):
        writer.add_blank_page(width=100, height=50)
    buf = io.BytesIO()
    writer.write(buf)
    pages = ev.render_pdf_pages(buf.getvalue(), max_pages=2, scale=1.0)
    assert len(pages) == 2
    assert _png_size(pages[0]) == (100, 50)


def test_render_rejects_a_non_pdf() -> None:
    with pytest.raises(RuntimeError):  # pypdfium2's PdfiumError
        ev.render_pdf_pages(b"not a pdf")


# --- transcription ---------------------------------------------------------------


class _Stream:
    def __init__(self, text: str) -> None:
        self._text = text

    async def __aenter__(self) -> _Stream:
        return self

    async def __aexit__(self, *_: Any) -> None:
        return None

    @property
    def text_stream(self) -> AsyncIterator[str]:
        async def gen() -> AsyncIterator[str]:
            yield self._text

        return gen()

    async def get_final_message(self) -> dict[str, Any]:
        return {"content": [{"type": "text", "text": self._text}]}


class _Client:
    def __init__(self, *texts: str) -> None:
        self.texts = list(texts)
        self.calls: list[dict[str, Any]] = []
        self.messages = self

    def stream(self, **kwargs: Any) -> _Stream:
        self.calls.append(kwargs)
        return _Stream(self.texts.pop(0))


async def test_transcribe_sends_the_page_image_and_the_prompt() -> None:
    client = _Client("| A |")
    out = await ev.transcribe_page(client, "claude-sonnet-4-6", b"PNGDATA")
    assert out == "| A |"
    [call] = client.calls
    assert call["model"] == "claude-sonnet-4-6"
    [message] = call["messages"]
    text, image = message["content"]
    assert text == {"type": "text", "text": ev.PAGE_PROMPT}
    assert image["type"] == "image"
    assert image["source"]["media_type"] == "image/png"
    assert image["source"]["data"] == "UE5HREFUQQ=="


async def test_extract_with_vision_joins_pages_in_order() -> None:
    async def transcribe(png: bytes, page: int) -> str:
        return f"md{page}:{png.decode()}"

    text = await ev.extract_with_vision(
        b"pdf", render=lambda _data: [b"a", b"b"], transcribe=transcribe
    )
    assert text == "<!-- page 1 -->\n\nmd1:a\n\n<!-- page 2 -->\n\nmd2:b"


# --- maybe_add_vision ---------------------------------------------------------------


async def _run(
    result: ExtractionResult,
    *,
    mode: str = "auto",
    model: str | None = "vision-model",
    budget: bool = True,
    vision: Any = None,
    size: int = 200 * 1024,
) -> tuple[ExtractionResult, str]:
    async def default_vision(_data: bytes, _model: str) -> str:
        return "# From vision"

    return await ev.maybe_add_vision(
        result,
        b"x" * size,
        mode=mode,  # type: ignore[arg-type]
        resolve_model=lambda: model,
        consume_budget=lambda: budget,
        run_vision=vision or default_vision,
    )


async def test_auto_mode_runs_vision_on_a_low_yield_pdf() -> None:
    out, outcome = await _run(_pdf("x"))
    assert (out.text, outcome) == ("# From vision", "applied")


async def test_no_model_off_mode_or_prose_is_skipped() -> None:
    assert (await _run(_pdf("x"), model=None))[1] == "skipped"
    assert (await _run(_pdf("x"), mode="off"))[1] == "skipped"
    prose = "This is a normal paragraph of prose. " * 200
    assert (await _run(_pdf(prose), size=8 * 1024))[1] == "skipped"
    # `on` forces it past the heuristic.
    assert (await _run(_pdf(prose), mode="on", size=8 * 1024))[1] == "applied"


async def test_an_exhausted_budget_keeps_the_text() -> None:
    out, outcome = await _run(_pdf("x"), budget=False)
    assert (out.text, outcome) == ("x", "budget_denied")


async def test_a_failure_keeps_the_text() -> None:
    async def boom(_d: bytes, _m: str) -> str:
        raise RuntimeError("model down")

    out, outcome = await _run(_pdf("x"), vision=boom)
    assert (out.text, outcome) == ("x", "failed")


async def test_blank_vision_output_keeps_the_text() -> None:
    async def blank(_d: bytes, _m: str) -> str:
        return "  \n"

    out, outcome = await _run(_pdf("x"), vision=blank)
    assert (out.text, outcome) == ("x", "applied")


async def test_non_pdf_is_never_touched() -> None:
    md = ExtractionResult(kind="markdown", text="x", truncated=False)
    out, outcome = await _run(md, mode="on")
    assert (out, outcome) == (md, None)
