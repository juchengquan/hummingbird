"""File extraction — text out of PDF / DOCX / XLSX / HTML / etc.

Phase 3e of PLAN-agent-api. Narrow port of `app/api/extract/route.ts`.
Takes a file's name + MIME type + raw bytes and returns a structured
`ExtractionResult` mirroring the TS `ExtractionResponse` shape so the
frontend (and any consumer of the wire schema) can swap producers.

Format dispatch order — same as TS:
  1. Plain-text family (text/plain, text/markdown, text/csv,
     application/json + extension-matched .txt / .md / .csv / .json).
  2. PDF (`application/pdf` or .pdf) via `pypdf`.
  3. DOCX (`application/vnd.openxmlformats-…wordprocessingml.document`
     or .docx) via `python-docx`.
  4. HTML (`text/html` or .html / .htm) via `lxml.html`.
  5. Source code (extension match against `CODE_EXTENSIONS`) — plain
     text with a wider budget + a language hint.
  6. XLSX (`application/vnd.openxmlformats-…spreadsheetml.sheet`
     or .xlsx / .xls) via `openpyxl`. One labelled CSV block per
     sheet, joined with blank lines.
  7. Images (`image/*` or .png / .jpg / .jpeg / .gif / .webp) →
     no-op `kind="image"` (the frontend handles them locally).
  8. Anything else → `kind="unsupported"`.

Each extractor is lazy-imported on first use so the FastAPI app /
agent loop doesn't pay the cost when no upload arrives.

Budgets:
  - `EXTRACTION_BUDGET` — 100 KB. The inline view the model sees
    in the per-turn prompt block.
  - `CODE_BUDGET` — 128 KB. Source files routinely run past the
    prose budget without being long-form content.
  - `FULL_EXTRACTION_BUDGET` — 1 MB. The full text that gets indexed
    by `files.full_text_tsv` for `searchFiles` to query.

`extract_file()` is the only public entry; downstream code never
imports the per-format helpers directly.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from typing import Literal

# Budgets — match the TS constants in `app/api/extract/route.ts`.
EXTRACTION_BUDGET = 100 * 1024
CODE_BUDGET = 128 * 1024
FULL_EXTRACTION_BUDGET = 1024 * 1024


ExtractionKind = Literal[
    "pdf",
    "docx",
    "markdown",
    "csv",
    "json",
    "text",
    "image",
    "html",
    "code",
    "spreadsheet",
    "unsupported",
]


@dataclass(frozen=True)
class ExtractionResult:
    """Wire shape — keys match `ExtractionResponseSchema` in
    `lib/shared/api-schemas.ts`. The route serialises via
    `ExtractionResultModel` (pydantic) to get camelCase + JSON
    field-name mapping; the dataclass keeps the helper functions
    free of pydantic at parse time."""

    kind: ExtractionKind
    text: str
    truncated: bool
    full_text: str | None = None
    language: str | None = None


# Code-file extension → language label. Same map as the TS path.
CODE_EXTENSIONS: dict[str, str] = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".py": "python",
    ".rb": "ruby",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cs": "csharp",
    ".swift": "swift",
    ".kt": "kotlin",
    ".sh": "shell",
    ".bash": "shell",
    ".sql": "sql",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
}


def code_language_for(name: str) -> str | None:
    lower = name.lower()
    for ext, lang in CODE_EXTENSIONS.items():
        if lower.endswith(ext):
            return lang
    return None


def _has_name(name: str, *suffixes: str) -> bool:
    lower = name.lower()
    return any(lower.endswith(s) for s in suffixes)


def _truncate_to(raw: str, budget: int) -> tuple[str, bool, str | None]:
    """Mirror TS `truncateTo`. Returns ``(text, truncated, full_text?)``.

    Small file → `(raw, False, None)`. Large → inline text is the head
    cap, and `full_text` is the FULL_EXTRACTION_BUDGET-capped tail
    (None when the file fits even that, in which case the FTS index
    would just store `text`)."""
    if len(raw) <= budget:
        return raw, False, None
    text = raw[:budget]
    full_text = raw if len(raw) <= FULL_EXTRACTION_BUDGET else raw[:FULL_EXTRACTION_BUDGET]
    return text, True, full_text


def _truncate(raw: str) -> tuple[str, bool, str | None]:
    return _truncate_to(raw, EXTRACTION_BUDGET)


def extract_file(
    *,
    name: str,
    mime_type: str,
    data: bytes,
) -> ExtractionResult:
    """Dispatch to the right extractor based on MIME type + extension.

    Either MIME type OR a recognised extension suffix is enough; the
    TS path is permissive in the same way (browser uploads sometimes
    arrive with `application/octet-stream` as `type` and the extension
    is the only signal we get).

    Raises nothing on a parse failure — formats that can't be read
    fall through to `kind="unsupported"`. Callers that need to know
    *why* extraction failed should wrap and inspect logs. The TS
    route returns HTTP 500 on the same failure; we want the Python
    service to mirror that, but the route layer (`main.py`) handles
    the conversion.
    """
    # --- Plain text family ------------------------------------------
    if mime_type in ("text/plain", "text/markdown", "text/csv", "application/json") or _has_name(
        name, ".txt", ".md", ".csv", ".json"
    ):
        raw = _decode_text(data)
        text, truncated, full_text = _truncate(raw)
        if mime_type == "application/json" or _has_name(name, ".json"):
            kind: ExtractionKind = "json"
        elif mime_type == "text/csv" or _has_name(name, ".csv"):
            kind = "csv"
        elif mime_type == "text/markdown" or _has_name(name, ".md"):
            kind = "markdown"
        else:
            kind = "text"
        return ExtractionResult(kind=kind, text=text, truncated=truncated, full_text=full_text)

    # --- PDF -------------------------------------------------------
    if mime_type == "application/pdf" or _has_name(name, ".pdf"):
        raw = _extract_pdf(data)
        text, truncated, full_text = _truncate(raw)
        return ExtractionResult(kind="pdf", text=text, truncated=truncated, full_text=full_text)

    # --- DOCX ------------------------------------------------------
    if (
        mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        or _has_name(name, ".docx")
    ):
        raw = _extract_docx(data)
        text, truncated, full_text = _truncate(raw)
        return ExtractionResult(kind="docx", text=text, truncated=truncated, full_text=full_text)

    # --- HTML ------------------------------------------------------
    if mime_type == "text/html" or _has_name(name, ".html", ".htm"):
        raw = _extract_html(data)
        text, truncated, full_text = _truncate(raw)
        return ExtractionResult(kind="html", text=text, truncated=truncated, full_text=full_text)

    # --- Code (extension match) ------------------------------------
    language = code_language_for(name)
    if language is not None:
        raw = _decode_text(data)
        text, truncated, full_text = _truncate_to(raw, CODE_BUDGET)
        return ExtractionResult(
            kind="code",
            text=text,
            truncated=truncated,
            full_text=full_text,
            language=language,
        )

    # --- XLSX ------------------------------------------------------
    if mime_type in (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
    ) or _has_name(name, ".xlsx", ".xls"):
        raw = _extract_xlsx(data)
        text, truncated, full_text = _truncate(raw)
        return ExtractionResult(
            kind="spreadsheet", text=text, truncated=truncated, full_text=full_text
        )

    # --- Images (no-op) --------------------------------------------
    if mime_type.startswith("image/") or _has_name(name, ".png", ".jpg", ".jpeg", ".gif", ".webp"):
        return ExtractionResult(kind="image", text="", truncated=False)

    return ExtractionResult(kind="unsupported", text="", truncated=False)


# --- format-specific extractors -------------------------------------------


def _decode_text(data: bytes) -> str:
    """Decode arbitrary file bytes as text, defaulting to UTF-8 and
    falling back to a replacement-marked decode so we never throw —
    a slightly garbled view beats a 500."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace")


def _extract_pdf(data: bytes) -> str:
    """Pure-Python PDF text extraction via pypdf. Slower than a native
    parser but no compiled deps required. Returns the concatenated
    text of every page joined by newlines."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    chunks: list[str] = []
    for page in reader.pages:
        try:
            chunks.append(page.extract_text() or "")
        except Exception:
            # A single bad page shouldn't tank the whole document —
            # mirrors how the TS path's `pdf-parse` swallows
            # individual page failures.
            chunks.append("")
    return "\n".join(chunks)


def _extract_docx(data: bytes) -> str:
    """DOCX paragraph extraction via python-docx. Mirrors mammoth's
    raw-text extraction on the TS side — paragraph text joined with
    newlines, table cells flattened to space-separated rows."""
    from docx import Document

    doc = Document(io.BytesIO(data))
    parts: list[str] = []
    for paragraph in doc.paragraphs:
        text = paragraph.text
        if text:
            parts.append(text)
    for table in doc.tables:
        for row in table.rows:
            row_text = " ".join(cell.text for cell in row.cells if cell.text)
            if row_text:
                parts.append(row_text)
    return "\n".join(parts)


def _extract_html(data: bytes) -> str:
    """HTML→text via lxml. Drops <script> / <style> content entirely,
    then collapses whitespace. Mirrors the TS path's
    `node-html-parser` config that excludes script + style + noscript."""
    from lxml import html as lxml_html

    try:
        doc = lxml_html.fromstring(data)
    except Exception:
        # Empty / malformed input — return decoded bytes minus tags.
        return _decode_text(data)

    # Strip nodes whose content shouldn't appear in the visible view.
    for tag in ("script", "style", "noscript"):
        for node in doc.findall(f".//{tag}"):
            parent = node.getparent()
            if parent is not None:
                parent.remove(node)

    text = doc.text_content() or ""
    # Collapse runs of whitespace to a single space, matching the TS
    # path's `.replace(/\s+/g, ' ').trim()`.
    return " ".join(text.split())


def _extract_xlsx(data: bytes) -> str:
    """XLSX→CSV-per-sheet via openpyxl. Each sheet emits a labelled
    `# Sheet: <name>\\n<csv>` block, joined with blank lines. Mirrors
    the TS path's `XLSX.utils.sheet_to_csv` per `workbook.SheetNames`.
    `data_only=True` so a formula cell returns its computed value
    rather than the formula string (TS side gets cached values
    through xlsx's default)."""
    from openpyxl import load_workbook

    workbook = load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    chunks: list[str] = []
    for sheet_name in workbook.sheetnames:
        sheet = workbook[sheet_name]
        # `read_only=True` returns a generator of rows; serialise each
        # row through csv.writer to get RFC-style quoting on values
        # containing commas / newlines.
        out = io.StringIO()
        writer = csv.writer(out)
        wrote_any = False
        for row in sheet.iter_rows(values_only=True):
            wrote_any = True
            writer.writerow(["" if cell is None else str(cell) for cell in row])
        csv_text = out.getvalue().strip()
        if wrote_any and csv_text:
            chunks.append(f"# Sheet: {sheet_name}\n{csv_text}")
    workbook.close()
    return "\n\n".join(chunks)


__all__ = [
    "CODE_BUDGET",
    "CODE_EXTENSIONS",
    "EXTRACTION_BUDGET",
    "FULL_EXTRACTION_BUDGET",
    "ExtractionKind",
    "ExtractionResult",
    "code_language_for",
    "extract_file",
]
