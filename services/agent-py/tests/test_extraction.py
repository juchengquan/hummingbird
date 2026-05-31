"""Phase 3e tests — file extraction library.

Synthesises small per-format fixtures in-memory (no checked-in test
files) and asserts the dispatcher routes each to the right extractor
and produces the expected `ExtractionResult` shape.

Covers:
  - MIME-type vs extension-only dispatch (both paths should land in
    the same branch).
  - Plain-text family (text / markdown / csv / json) returns the
    right `kind`.
  - PDF, DOCX, HTML, XLSX extractors produce non-empty text.
  - Code-extension dispatch sets `language` and uses CODE_BUDGET.
  - Image / unsupported branches return empty text + the right kind.
  - Truncation: oversize input → text is capped at EXTRACTION_BUDGET,
    `truncated=True`, `full_text` is the FULL_EXTRACTION_BUDGET-capped
    raw input.
"""

from __future__ import annotations

import csv
import io

import pytest

from agent_py.extraction import (
    CODE_BUDGET,
    EXTRACTION_BUDGET,
    FULL_EXTRACTION_BUDGET,
    code_language_for,
    extract_file,
)

# --- helpers ------------------------------------------------------------


def _pdf_bytes(pages: list[str]) -> bytes:
    """Build a real (tiny) PDF on the fly with reportlab — but we don't
    have reportlab. Instead, use pypdf's writer to add blank pages and
    then synthesise raw text. Easier: skip the real PDF path and write
    a minimal valid PDF manually with one text object per page.

    For the test we use a known-good minimal PDF byte string with
    embedded text — borrowed pattern from pypdf's own examples."""
    # Use pypdf to build a synthetic PDF — it can write empty pages,
    # but text rendering requires PageObject manipulation that's
    # fiddly. We embed via the `add_blank_page` API and write a
    # `/Tj` text op into the content stream. pypdf can read it back.
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject, RectangleObject

    writer = PdfWriter()
    for page_text in pages:
        page = writer.add_blank_page(width=612, height=792)
        # Write a tiny content stream with the text. Escape literal
        # parentheses just in case.
        escaped = page_text.replace("(", r"\(").replace(")", r"\)")
        stream = f"BT /F1 12 Tf 50 750 Td ({escaped}) Tj ET".encode("latin-1")
        from pypdf.generic import DecodedStreamObject

        content = DecodedStreamObject()
        content.set_data(stream)
        page[NameObject("/Contents")] = writer._add_object(content)  # type: ignore[attr-defined]
        page[NameObject("/MediaBox")] = RectangleObject([0, 0, 612, 792])
        # Add a font resource so the text op is valid PDF.
        from pypdf.generic import DictionaryObject

        font_dict = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        font_ref = writer._add_object(font_dict)  # type: ignore[attr-defined]
        resources = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref})}
        )
        page[NameObject("/Resources")] = resources

    buf = io.BytesIO()
    writer.write(buf)
    # Sanity round-trip — make sure the bytes are readable.
    PdfReader(io.BytesIO(buf.getvalue()))
    return buf.getvalue()


def _docx_bytes(paragraphs: list[str]) -> bytes:
    from docx import Document

    doc = Document()
    for p in paragraphs:
        doc.add_paragraph(p)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _xlsx_bytes(sheets: dict[str, list[list[object]]]) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    # The new workbook starts with one default "Sheet"; drop it.
    if "Sheet" in wb.sheetnames:
        del wb["Sheet"]
    for name, rows in sheets.items():
        sheet = wb.create_sheet(title=name)
        for row in rows:
            sheet.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# --- plain-text family --------------------------------------------------


@pytest.mark.parametrize(
    "name, mime, expected_kind",
    [
        ("a.txt", "text/plain", "text"),
        ("a.md", "text/markdown", "markdown"),
        ("a.csv", "text/csv", "csv"),
        ("a.json", "application/json", "json"),
        # Extension-only (browser sent application/octet-stream)
        ("a.md", "application/octet-stream", "markdown"),
        ("a.json", "", "json"),
    ],
)
def test_plain_text_dispatch(name: str, mime: str, expected_kind: str) -> None:
    out = extract_file(name=name, mime_type=mime, data=b"hello world")
    assert out.kind == expected_kind
    assert out.text == "hello world"
    assert out.truncated is False
    assert out.full_text is None


def test_plain_text_invalid_utf8_decodes_with_replacement() -> None:
    """A file with non-UTF-8 bytes shouldn't 500 the extractor."""
    out = extract_file(name="a.txt", mime_type="text/plain", data=b"\xff\xfehi")
    assert out.kind == "text"
    # `errors="replace"` substitutes U+FFFD on the bad bytes; the
    # important thing is the call returned a string at all.
    assert "hi" in out.text


# --- PDF ----------------------------------------------------------------


def test_pdf_extracts_text() -> None:
    pdf = _pdf_bytes(["Hello from page one", "Page two content"])
    out = extract_file(name="doc.pdf", mime_type="application/pdf", data=pdf)
    assert out.kind == "pdf"
    # pypdf's text extraction concatenates pages with newlines; the
    # exact whitespace is fiddly so we use substring assertions.
    assert "Hello from page one" in out.text
    assert "Page two content" in out.text


# --- DOCX ---------------------------------------------------------------


def test_docx_extracts_paragraphs() -> None:
    docx = _docx_bytes(["First paragraph.", "Second paragraph."])
    out = extract_file(
        name="doc.docx",
        mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        data=docx,
    )
    assert out.kind == "docx"
    assert "First paragraph." in out.text
    assert "Second paragraph." in out.text


def test_docx_extension_only_dispatch() -> None:
    docx = _docx_bytes(["hello"])
    out = extract_file(name="doc.docx", mime_type="application/octet-stream", data=docx)
    assert out.kind == "docx"
    assert "hello" in out.text


# --- HTML ---------------------------------------------------------------


def test_html_strips_script_style_and_collapses_whitespace() -> None:
    html = b"""
    <html>
      <head>
        <title>T</title>
        <style>body { color: red }</style>
      </head>
      <body>
        <script>var leak = 42;</script>
        <h1>Hello</h1>
        <p>World    text</p>
      </body>
    </html>
    """
    out = extract_file(name="page.html", mime_type="text/html", data=html)
    assert out.kind == "html"
    assert "Hello" in out.text
    assert "World text" in out.text
    assert "var leak" not in out.text
    assert "color: red" not in out.text


# --- code files ---------------------------------------------------------


@pytest.mark.parametrize(
    "name, lang",
    [
        ("a.py", "python"),
        ("a.ts", "typescript"),
        ("a.tsx", "tsx"),
        ("a.go", "go"),
        ("a.yaml", "yaml"),
    ],
)
def test_code_dispatch_sets_language(name: str, lang: str) -> None:
    out = extract_file(name=name, mime_type="application/octet-stream", data=b"print(1)")
    assert out.kind == "code"
    assert out.language == lang
    assert out.text == "print(1)"


def test_code_uses_wider_budget() -> None:
    """Code files get CODE_BUDGET (128 KB), not EXTRACTION_BUDGET (100 KB)."""
    raw = ("x" * (EXTRACTION_BUDGET + 1000)).encode()
    out = extract_file(name="big.py", mime_type="", data=raw)
    assert out.kind == "code"
    # Not truncated because we're still under CODE_BUDGET.
    assert out.truncated is False


# --- XLSX ---------------------------------------------------------------


def test_xlsx_dumps_one_csv_block_per_sheet() -> None:
    xlsx = _xlsx_bytes(
        {
            "Alpha": [["a", "b"], [1, 2]],
            "Beta": [["x"], ["y"]],
        }
    )
    out = extract_file(
        name="data.xlsx",
        mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        data=xlsx,
    )
    assert out.kind == "spreadsheet"
    assert "# Sheet: Alpha" in out.text
    assert "# Sheet: Beta" in out.text
    # CSV quoting — values should appear; we don't assert exact layout
    # because csv.writer's behaviour on numerics + line endings is
    # platform-sensitive.
    assert "a,b" in out.text
    assert "1,2" in out.text or "1.0,2.0" in out.text  # openpyxl returns numeric
    assert "x\r\ny" in out.text or "x\ny" in out.text


def test_xlsx_skips_empty_sheets() -> None:
    xlsx = _xlsx_bytes({"Alpha": [["v"]], "Beta": []})
    out = extract_file(
        name="data.xlsx",
        mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        data=xlsx,
    )
    assert "# Sheet: Alpha" in out.text
    assert "# Sheet: Beta" not in out.text


def test_xlsx_csv_quoting_for_values_with_commas() -> None:
    """csv module should quote a value containing a comma. Catches
    the common pitfall of hand-joining cells with `,`."""
    xlsx = _xlsx_bytes({"S": [["plain", "has,comma"]]})
    out = extract_file(name="d.xlsx", mime_type="", data=xlsx)
    assert '"has,comma"' in out.text
    # Sanity — the comma inside the quoted value isn't a column separator.
    rows = list(csv.reader(io.StringIO(out.text.split("\n", 1)[1])))
    assert rows[0] == ["plain", "has,comma"]


# --- image + unsupported ------------------------------------------------


@pytest.mark.parametrize(
    "name, mime",
    [
        ("p.png", "image/png"),
        ("p.jpg", "image/jpeg"),
        ("p.webp", "image/webp"),
        ("p.png", "application/octet-stream"),  # ext-only dispatch
    ],
)
def test_image_returns_no_op_kind(name: str, mime: str) -> None:
    out = extract_file(name=name, mime_type=mime, data=b"\x89PNG\r\n")
    assert out.kind == "image"
    assert out.text == ""
    assert out.truncated is False


def test_unsupported_kind_for_unknown_type() -> None:
    out = extract_file(name="weird.xyz", mime_type="application/x-weird", data=b"opaque")
    assert out.kind == "unsupported"
    assert out.text == ""
    assert out.truncated is False


# --- truncation --------------------------------------------------------


def test_oversize_text_is_truncated_with_full_text_attached() -> None:
    raw = ("a" * (EXTRACTION_BUDGET + 1000)).encode()
    out = extract_file(name="big.txt", mime_type="text/plain", data=raw)
    assert out.truncated is True
    assert len(out.text) == EXTRACTION_BUDGET
    assert out.full_text is not None
    # File fits FULL_EXTRACTION_BUDGET, so full_text is the entire raw.
    assert len(out.full_text) == EXTRACTION_BUDGET + 1000


def test_text_past_full_extraction_budget_is_double_truncated() -> None:
    raw = ("a" * (FULL_EXTRACTION_BUDGET + 1000)).encode()
    out = extract_file(name="huge.txt", mime_type="text/plain", data=raw)
    assert out.truncated is True
    assert out.full_text is not None
    # full_text capped at FULL_EXTRACTION_BUDGET — we lose the tail.
    assert len(out.full_text) == FULL_EXTRACTION_BUDGET


def test_code_truncation_uses_code_budget() -> None:
    raw = ("z" * (CODE_BUDGET + 10)).encode()
    out = extract_file(name="big.py", mime_type="", data=raw)
    assert out.kind == "code"
    assert out.truncated is True
    assert len(out.text) == CODE_BUDGET


# --- code_language_for --------------------------------------------------


def test_code_language_for_returns_none_for_non_code() -> None:
    assert code_language_for("readme.md") is None
    assert code_language_for("photo.jpg") is None
    assert code_language_for("doc.docx") is None


def test_code_language_for_case_insensitive() -> None:
    assert code_language_for("MyScript.PY") == "python"
