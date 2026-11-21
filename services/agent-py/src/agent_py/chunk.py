"""Text chunking for the embedding pipeline — a line-for-line port of
`lib/server/embeddings/chunk.ts`.

Splits a document's full text into overlapping, paragraph-aware windows
small enough to embed: whole paragraphs (split on blank lines) are packed
into windows up to `max_chars`, each window seeded with an `overlap_chars`
tail of the previous one. A paragraph longer than `max_chars` is
hard-split into overlapping character windows — except a markdown table,
which is split at row boundaries with its header repeated on each piece.

**Identical boundaries to the TS chunker** (pinned by
`tests/test_chunk_parity.py` against fixtures the TS chunker generated),
which takes two deliberate emulations of JavaScript string semantics:

  - **Lengths and slices are in UTF-16 code units**, as JS `.length` /
    `.slice()` are. Text is converted to a "unit string" (one Python
    character per UTF-16 code unit, astral characters as two surrogate
    characters), chunked, and converted back. A hard split can therefore
    cut a surrogate pair exactly where the TS chunker does, leaving a lone
    surrogate at a chunk edge; `chunk_text` keeps it (parity),
    `to_storable_text` replaces it with U+FFFD before the text leaves the
    process (Postgres and JSON reject lone surrogates).
  - **Whitespace is JavaScript's** (`\\s` / `String.prototype.trim`:
    WhiteSpace + LineTerminator), not Python's `str.isspace` — they differ
    on U+FEFF (JS whitespace, not Python) and U+001C-U+001F / U+0085
    (Python whitespace, not JS).

Pure — no I/O. Keep in sync with the TS original; the parity fixtures are
regenerated with `bun run codegen:agent-py-parity`.
"""

from __future__ import annotations

import math
import re
import sys
from array import array

__all__ = [
    "DEFAULT_MAX_CHARS",
    "DEFAULT_OVERLAP",
    "chunk_text",
    "from_utf16_units",
    "to_storable_text",
    "to_utf16_units",
]

DEFAULT_MAX_CHARS = 1500
DEFAULT_OVERLAP = 200

# ECMAScript WhiteSpace + LineTerminator — the set `\s` and `trim()` use.
_JS_WS_CODEPOINTS = (
    0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680,
    *range(0x2000, 0x200B),
    0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
)  # fmt: skip
_JS_WS_CHARS = "".join(map(chr, _JS_WS_CODEPOINTS))
_JS_WS_CLASS = re.escape(_JS_WS_CHARS)
# `/\n\s*\n/` — paragraph separator.
_PARA_SPLIT_RE = re.compile(f"\n[{_JS_WS_CLASS}]*\n")
# `/^[|\s:-]+$/` — a GFM table separator row (after trim).
_SEPARATOR_RE = re.compile(f"[|{_JS_WS_CLASS}:-]+")
_SURROGATE_RE = re.compile("[\ud800-\udfff]")


def _js_trim(s: str) -> str:
    return s.strip(_JS_WS_CHARS)


# --- UTF-16 "unit string" conversion -------------------------------------


def to_utf16_units(text: str) -> str:
    """One character per UTF-16 code unit. Text with no astral characters
    is already its own unit string."""
    if not text or max(text) <= "\uffff":
        return text
    units = array("H")
    units.frombytes(text.encode("utf-16-le", "surrogatepass"))
    if sys.byteorder == "big":
        units.byteswap()
    return "".join(map(chr, units))


def from_utf16_units(units: str) -> str:
    """Inverse of `to_utf16_units`: re-pairs surrogates; a lone one (a pair the
    chunker cut) stays a lone surrogate, as in the JS string."""
    if not _SURROGATE_RE.search(units):
        return units
    return units.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")


def to_storable_text(text: str) -> str:
    """Replace lone surrogates with U+FFFD so the text can be UTF-8 encoded
    (JSON to the embedder, a Postgres `text` column)."""
    return _SURROGATE_RE.sub("\ufffd", text)


# --- The chunker (on unit strings) ---------------------------------------


def _split_long(text: str, max_chars: int, overlap: int) -> list[str]:
    """Hard-split one oversized paragraph into overlapping windows."""
    out: list[str] = []
    step = max(1, max_chars - overlap)
    i = 0
    while i < len(text):
        out.append(text[i : i + max_chars])
        if i + max_chars >= len(text):
            break
        i += step
    return out


def _is_markdown_table(block: str) -> bool:
    """A GFM pipe table: ≥2 lines, line 1 has a pipe, line 2 is a separator
    (only `|`, `-`, `:`, whitespace; ≥1 `-` and a `|`), and at least half
    the lines contain a pipe."""
    lines = block.split("\n")
    if len(lines) < 2:
        return False
    header = lines[0]
    separator = _js_trim(lines[1])
    if "|" not in header:
        return False
    if "|" not in separator or "-" not in separator:
        return False
    if not _SEPARATOR_RE.fullmatch(separator):
        return False
    rowish = sum(1 for line in lines if "|" in line)
    return rowish >= math.ceil(len(lines) / 2)


def _split_table_by_rows(table: str, max_chars: int, overlap: int) -> list[str]:
    """Pieces of header + separator + as many body rows as fit; falls back
    to `_split_long` when even header + separator + the first row don't."""
    lines = table.split("\n")
    prefix = f"{lines[0]}\n{lines[1]}"
    body = lines[2:]
    if not body or len(prefix) + 1 + len(body[0]) > max_chars:
        return _split_long(table, max_chars, overlap)
    pieces: list[str] = []
    rows: list[str] = []
    for row in body:
        piece_length = len(prefix) + sum(1 + len(r) for r in rows)
        if rows and piece_length + 1 + len(row) > max_chars:
            pieces.append(prefix + "\n" + "\n".join(rows))
            rows = []
        rows.append(row)
    if rows:
        pieces.append(prefix + "\n" + "\n".join(rows))
    return pieces


def _chunk_units(text: str, max_chars: int, overlap: int) -> list[str]:
    clean = _js_trim(text)
    if not clean:
        return []
    if len(clean) <= max_chars:
        return [clean]

    paras = [p for p in (_js_trim(p) for p in _PARA_SPLIT_RE.split(clean)) if p]

    chunks: list[str] = []
    buf = ""
    # True when `buf` holds only an overlap tail carried from the last
    # flush — such a buffer is never emitted on its own.
    seeded_only = False

    for para in paras:
        if len(para) > max_chars:
            if buf and not seeded_only:
                chunks.append(buf)
            buf = ""
            seeded_only = False
            pieces = (
                _split_table_by_rows(para, max_chars, overlap)
                if _is_markdown_table(para)
                else _split_long(para, max_chars, overlap)
            )
            chunks.extend(pieces)
            continue
        candidate = f"{buf}\n\n{para}" if buf else para
        if len(candidate) > max_chars:
            # flush()
            if buf:
                chunks.append(buf)
            buf = buf[-overlap:] if overlap > 0 and len(buf) > overlap else ""
            seeded_only = len(buf) > 0
            buf = f"{buf}\n\n{para}" if buf else para
            # The overlap tail + para already overflow → drop the tail.
            if len(buf) > max_chars:
                buf = para
            seeded_only = False
        else:
            buf = candidate
            seeded_only = False
    if buf and not seeded_only and _js_trim(buf):
        chunks.append(buf)
    return chunks


def chunk_text(
    text: str,
    *,
    max_chars: int | None = None,
    overlap_chars: int | None = None,
) -> list[str]:
    """Chunk `text` into overlapping windows (`chunkText` in the TS
    original). `[]` for blank input, one chunk when the text already fits.
    Sizes are in UTF-16 code units, like the TS original."""
    max_c = DEFAULT_MAX_CHARS if max_chars is None else max_chars
    overlap = min(DEFAULT_OVERLAP if overlap_chars is None else overlap_chars, max_c - 1)
    return [from_utf16_units(c) for c in _chunk_units(to_utf16_units(text), max_c, overlap)]
