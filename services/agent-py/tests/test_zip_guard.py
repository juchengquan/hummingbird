"""Zip-bomb guard (`zip_guard.py`) + the extraction / route wiring.

Pins (mirrors `lib/server/extraction/zip-guard.test.ts`):
  - a normal docx / xlsx passes;
  - too many entries, a declared total over budget, or a REAL inflated
    size over budget (declared sizes lie) are rejected;
  - docx / xlsx extraction runs the guard before the parser opens the
    file, and the route maps the rejection to 413;
  - the xlsx walk is bounded by XLSX_MAX_ROWS / XLSX_MAX_COLS.
"""

from __future__ import annotations

import functools
import io
import struct
import time
import zipfile
import zlib

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py import extraction
from agent_py.extraction import extract_file
from agent_py.main import create_app
from agent_py.zip_guard import ZipLimitError, assert_zip_within_limits, looks_like_zip

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return buf.getvalue()


@functools.cache
def _lying_bomb(real_size: int) -> bytes:
    """A one-entry deflate zip whose headers DECLARE 10 bytes but whose
    data inflates to `real_size` zero bytes."""
    payload = zlib.compressobj(9, zlib.DEFLATED, -zlib.MAX_WBITS)
    comp = payload.compress(b"\0" * real_size) + payload.flush()
    name = b"word/document.xml"
    crc = 0
    declared = 10
    lfh = struct.pack(
        "<IHHHHHIIIHH", 0x04034B50, 20, 0, 8, 0, 0, crc, len(comp), declared, len(name), 0
    )
    cd = struct.pack(
        "<IHHHHHHIIIHHHHHII",
        0x02014B50,
        20,
        20,
        0,
        8,
        0,
        0,
        crc,
        len(comp),
        declared,
        len(name),
        0,
        0,
        0,
        0,
        0,
        0,
    )
    local = lfh + name + comp
    central = cd + name
    eocd = struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, 1, 1, len(central), len(local), 0)
    return local + central + eocd


def _docx(paragraphs: list[str]) -> bytes:
    from docx import Document

    doc = Document()
    for p in paragraphs:
        doc.add_paragraph(p)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _xlsx(rows: list[list[object]]) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "Data"
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# --- guard -----------------------------------------------------------------


def test_real_office_files_pass() -> None:
    assert_zip_within_limits(_docx(["hello"]))
    assert_zip_within_limits(_xlsx([["a", 1]]))


def test_too_many_entries_rejected() -> None:
    data = _zip({f"f{i}.xml": b"x" for i in range(20)})
    with pytest.raises(ZipLimitError, match="too many entries"):
        assert_zip_within_limits(data, max_entries=10)


def test_declared_total_over_budget_rejected() -> None:
    data = _zip({"a.xml": b"x" * 5_000})
    with pytest.raises(ZipLimitError, match="expands beyond"):
        assert_zip_within_limits(data, max_total_uncompressed=1_000)


def test_lying_headers_caught_by_real_inflated_size() -> None:
    bomb = _lying_bomb(2_000_000)
    # Declared size (10 bytes) is well inside the budget...
    with pytest.raises(ZipLimitError, match="expands beyond"):
        assert_zip_within_limits(bomb, max_total_uncompressed=1_000_000)


def test_highly_compressed_bomb_rejected_at_default_budget() -> None:
    """~100 KB of deflate that declares (and inflates to) 110 MB."""
    bomb = _zip({"word/document.xml": b"\0" * (110 * 1024 * 1024)})
    assert len(bomb) < 1024 * 1024
    with pytest.raises(ZipLimitError):
        assert_zip_within_limits(bomb)


def test_not_a_zip_rejected() -> None:
    with pytest.raises(ZipLimitError, match="Not a readable zip"):
        assert_zip_within_limits(b"definitely not a zip")


def test_looks_like_zip() -> None:
    assert looks_like_zip(_zip({"a": b"b"}))
    assert not looks_like_zip(b"\xd0\xcf\x11\xe0legacy-ole-xls")


# --- extraction wiring -----------------------------------------------------


def test_docx_bomb_rejected_before_parser() -> None:
    with pytest.raises(ZipLimitError):
        extract_file(name="bomb.docx", mime_type=DOCX_MIME, data=_lying_bomb(150 * 1024 * 1024))


def test_xlsx_bomb_rejected_before_parser() -> None:
    with pytest.raises(ZipLimitError):
        extract_file(name="bomb.xlsx", mime_type=XLSX_MIME, data=_lying_bomb(150 * 1024 * 1024))


def test_xlsx_row_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(extraction, "XLSX_MAX_ROWS", 5)
    data = _xlsx([[f"r{i}", i] for i in range(50)])
    out = extract_file(name="big.xlsx", mime_type=XLSX_MIME, data=data)
    lines = out.text.splitlines()
    assert lines[0] == "# Sheet: Data"
    assert lines[1:] == [f"r{i},{i}" for i in range(5)]


def test_xlsx_col_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(extraction, "XLSX_MAX_COLS", 3)
    data = _xlsx([list(range(10))])
    out = extract_file(name="wide.xlsx", mime_type=XLSX_MIME, data=data)
    assert out.text.splitlines()[1] == "0,1,2"


def test_xlsx_narrow_sheet_not_padded() -> None:
    out = extract_file(name="n.xlsx", mime_type=XLSX_MIME, data=_xlsx([["a", "b"], ["c", "d"]]))
    assert out.text.splitlines() == ["# Sheet: Data", "a,b", "c,d"]


# --- route -----------------------------------------------------------------

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"


def test_route_maps_zip_limit_to_413(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    client = TestClient(create_app(enable_poller=False))
    token = jwt.encode(
        {
            "sub": "00000000-0000-4000-8000-0000000000aa",
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
        },
        SECRET,
        algorithm="HS256",
    )
    r = client.post(
        "/v1/extract",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("bomb.docx", _lying_bomb(150 * 1024 * 1024), DOCX_MIME)},
    )
    assert r.status_code == 413
    assert "expands beyond" in r.json()["message"]
