"""The PDF vision pass of `/v1/extract` (wave 12) — the Python port of
`lib/server/extraction/heuristics.ts`, `vision.ts`, `vision-model.ts`,
`render-pdf.ts` and `maybeAddVision` (`lib/server/extraction.ts`).

A layout-rich or scanned PDF (low text yield, or table-dense text) gets
its pages rendered to PNG (pypdfium2; at most 30 pages, ~144 DPI) and
transcribed to markdown one page at a time by a vision-capable catalog
model (`VISION_MODEL` if it sees, else the first `supportsVision` model a
provider serves here), merged into `text` / `fullText` under the same
budgets as the text pass. Best effort: no model, a denied budget or any
failure leaves the text-only result. The outcome tells the route whether
the result may be cached (`budget_denied` / `failed` may not).
"""

from __future__ import annotations

import base64
import dataclasses
import re
import struct
import zlib
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, Literal

import structlog

from .extraction import EXTRACTION_BUDGET, FULL_EXTRACTION_BUDGET, ExtractionResult
from .model_allowlist import ModelAllowlist

logger = structlog.get_logger(__name__)

__all__ = [
    "PAGE_PROMPT",
    "VisionMode",
    "VisionOutcome",
    "encode_png",
    "extract_with_vision",
    "maybe_add_vision",
    "merge_vision_text",
    "render_pdf_pages",
    "resolve_vision_model",
    "should_use_vision",
    "transcribe_page",
]

VisionMode = Literal["auto", "on", "off"]
#: `skipped` (no model, or the mode / heuristic said no), `budget_denied`,
#: `applied` (vision ran), `failed` (it raised; text-only returned).
VisionOutcome = Literal["skipped", "budget_denied", "applied", "failed"]

#: Below this ratio of text length to file bytes a PDF is likely scanned.
LOW_YIELD_RATIO = 0.01
MIN_TABLE_LINES = 20
TABLE_LINE_RATIO = 0.5
MAX_PAGES = 30
RENDER_SCALE = 2.0
#: Output cap for one page's markdown.
PAGE_MAX_TOKENS = 4096

PAGE_PROMPT = (
    "Transcribe this document page to GitHub-flavoured Markdown. Render "
    "tables as Markdown tables. Describe figures, charts, and images as "
    "`*Figure: <caption>*`. Preserve reading order. Omit page furniture "
    "(running headers/footers, page numbers). Output only the page content."
)

# ≥ 2 runs of 2+ spaces between non-space content; lookarounds so adjacent
# gaps don't share (consume) a boundary character.
_GAP_RE = re.compile(r"(?<=\S) {2,}(?=\S)")


def _is_columnar(line: str) -> bool:
    trimmed = line.strip()
    return bool(trimmed) and len(_GAP_RE.findall(trimmed)) >= 2


def should_use_vision(result: ExtractionResult, file_size: int) -> bool:
    """`shouldUseVision`: PDFs only — a low text yield, or table-dense text."""
    if result.kind != "pdf":
        return False
    text = result.full_text if result.full_text is not None else result.text
    if file_size > 0 and len(text) / file_size < LOW_YIELD_RATIO:
        return True
    lines = text.split("\n")
    if len(lines) >= MIN_TABLE_LINES:
        columnar = sum(1 for line in lines if _is_columnar(line))
        if columnar / len(lines) >= TABLE_LINE_RATIO:
            return True
    return False


def merge_vision_text(base: ExtractionResult, markdown: str) -> ExtractionResult:
    """`mergeVisionText`: the vision markdown replaces `text` / `full_text`
    (same budgets as the text pass); `kind` is kept."""
    if len(markdown) <= EXTRACTION_BUDGET:
        return dataclasses.replace(base, text=markdown, truncated=False, full_text=None)
    return dataclasses.replace(
        base,
        text=markdown[:EXTRACTION_BUDGET],
        truncated=True,
        full_text=markdown[:FULL_EXTRACTION_BUDGET],
    )


def resolve_vision_model(allowlist: ModelAllowlist, override: str) -> str | None:
    """`resolveVisionModel`: `override` (`VISION_MODEL`) when it is a
    `supportsVision` model, else the first such model in catalog order — of
    those a provider serves here (the Next route has every catalog model);
    None → no vision pass."""
    if override and override in allowlist.vision and allowlist.available(override):
        return override
    for model_id in allowlist.targets:
        if model_id in allowlist.vision and allowlist.available(model_id):
            return model_id
    return None


# --- rendering -------------------------------------------------------------------


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))


def encode_png(rgb: bytes, *, width: int, height: int, stride: int) -> bytes:
    """A truecolour (8-bit RGB) PNG of a packed RGB buffer, rows `stride`
    bytes apart; filter 0 on every row."""
    row = width * 3
    raw = b"".join(b"\x00" + rgb[y * stride : y * stride + row] for y in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(raw, 6))
        + _png_chunk(b"IEND", b"")
    )


def render_pdf_pages(
    data: bytes, *, max_pages: int = MAX_PAGES, scale: float = RENDER_SCALE
) -> list[bytes]:
    """`renderPdfPages`: the first `max_pages` pages as PNGs. Raises when
    the document can't be opened or rendered. CPU-bound: call it off the
    event loop."""
    import pypdfium2 as pdfium

    if max_pages <= 0:
        return []
    doc = pdfium.PdfDocument(data)
    try:
        pages: list[bytes] = []
        for index in range(min(len(doc), max_pages)):
            page = doc[index]
            try:
                bitmap = page.render(scale=scale, rev_byteorder=True)
                pages.append(
                    encode_png(
                        bytes(bitmap.buffer),
                        width=bitmap.width,
                        height=bitmap.height,
                        stride=bitmap.stride,
                    )
                )
            finally:
                page.close()
        return pages
    finally:
        doc.close()


# --- transcription ------------------------------------------------------------------


def _final_text(final: Any) -> str:
    content = final.get("content") if isinstance(final, dict) else getattr(final, "content", None)
    parts: list[str] = []
    for block in content or []:
        kind = block.get("type") if isinstance(block, dict) else getattr(block, "type", None)
        if kind == "text":
            text = block.get("text") if isinstance(block, dict) else getattr(block, "text", "")
            parts.append(text or "")
    return "".join(parts)


async def transcribe_page(client: Any, model: str, png: bytes) -> str:
    """One page's markdown from the vision model (`model`: the provider's id)."""
    image = {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": base64.b64encode(png).decode("ascii"),
        },
    }
    async with client.messages.stream(
        model=model,
        max_tokens=PAGE_MAX_TOKENS,
        messages=[{"role": "user", "content": [{"type": "text", "text": PAGE_PROMPT}, image]}],
    ) as stream:
        async for _ in stream.text_stream:
            pass
        final = await stream.get_final_message()
    return _final_text(final).strip()


async def extract_with_vision(
    data: bytes,
    *,
    render: Callable[[bytes], Sequence[bytes]],
    transcribe: Callable[[bytes, int], Awaitable[str]],
) -> str:
    """`extractWithVision`: every rendered page transcribed, in reading
    order, each under a `<!-- page N -->` marker. Raises on any failure."""
    pages = render(data)
    parts: list[str] = []
    for number, png in enumerate(pages, start=1):
        markdown = await transcribe(png, number)
        parts.append(f"<!-- page {number} -->\n\n{markdown}")
    return "\n\n".join(parts)


async def maybe_add_vision(
    result: ExtractionResult,
    data: bytes,
    *,
    mode: VisionMode,
    resolve_model: Callable[[], str | None],
    consume_budget: Callable[[], bool],
    run_vision: Callable[[bytes, str], Awaitable[str]],
) -> tuple[ExtractionResult, VisionOutcome | None]:
    """`maybeAddVision`: the result, vision-enhanced when it should be, and
    what happened (None: not a PDF, nothing to decide). Never raises."""
    if result.kind != "pdf":
        return result, None
    model = resolve_model()
    if model is None:
        return result, "skipped"
    wanted = (
        True if mode == "on" else False if mode == "off" else should_use_vision(result, len(data))
    )
    if not wanted:
        return result, "skipped"
    if not consume_budget():
        return result, "budget_denied"
    try:
        markdown = await run_vision(data, model)
    except Exception as exc:
        logger.warning("extract.vision_failed", error=type(exc).__name__, detail=str(exc)[:200])
        return result, "failed"
    if not markdown.strip():
        return result, "applied"
    return merge_vision_text(result, markdown), "applied"
