"""Phase 3e route tests — POST /v1/extract.

Hermetic — uses FastAPI's TestClient. Auth flow mirrors
`test_auth.py` (HS256 JWT with the test secret). We cover:

  - Happy path → 200 with the wire shape (kind, text, truncated,
    full_text?, language?).
  - Auth rejection (missing token → 401).
  - Missing file field → 422 (FastAPI's UploadFile validation).
  - Per-format dispatch reaches the right extractor — checked
    indirectly by asserting the `kind` field on a sampled set so the
    full extraction matrix lives in `test_extraction.py` rather than
    duplicating it through the HTTP layer.
"""

from __future__ import annotations

import io
import time

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py.main import create_app

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    return TestClient(create_app(enable_poller=False))


def _token() -> str:
    return jwt.encode(
        {"sub": "u", "role": "authenticated", "exp": int(time.time()) + 3600},
        SECRET,
        algorithm="HS256",
    )


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {_token()}"}


def test_extract_rejects_missing_token() -> None:
    """No JWT → 401, same shape as `/v1/whoami`."""
    # Build a client without the auth setup so the JWT secret is set
    # but no Authorization header is sent.
    import os

    os.environ["SUPABASE_JWT_SECRET"] = SECRET
    c = TestClient(create_app(enable_poller=False))
    files = {"file": ("a.txt", b"x", "text/plain")}
    r = c.post("/v1/extract", files=files)
    assert r.status_code == 401


def test_extract_text_file_happy_path(client: TestClient) -> None:
    files = {"file": ("notes.txt", b"hello world", "text/plain")}
    r = client.post("/v1/extract", files=files, headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "text"
    assert body["text"] == "hello world"
    assert body["truncated"] is False
    assert body["full_text"] is None
    assert body["language"] is None


def test_extract_markdown_dispatches_to_markdown_kind(client: TestClient) -> None:
    files = {"file": ("readme.md", b"# Title", "text/markdown")}
    r = client.post("/v1/extract", files=files, headers=_auth())
    assert r.status_code == 200
    assert r.json()["kind"] == "markdown"


def test_extract_code_returns_language(client: TestClient) -> None:
    files = {"file": ("script.py", b"print(1)", "application/octet-stream")}
    r = client.post("/v1/extract", files=files, headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "code"
    assert body["language"] == "python"


def test_extract_image_returns_image_no_op(client: TestClient) -> None:
    files = {"file": ("p.png", b"\x89PNG\r\n", "image/png")}
    r = client.post("/v1/extract", files=files, headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "image"
    assert body["text"] == ""


def test_extract_unsupported_type(client: TestClient) -> None:
    files = {"file": ("a.bin", b"opaque", "application/x-weird")}
    r = client.post("/v1/extract", files=files, headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "unsupported"


def test_extract_missing_file_field_returns_422(client: TestClient) -> None:
    """FastAPI's UploadFile dependency rejects a request without the
    `file` part. Mirrors the TS route's 400 (different code but same
    user-visible "missing field" failure)."""
    r = client.post("/v1/extract", headers=_auth())
    assert r.status_code == 422


def test_extract_truncates_oversize_text(client: TestClient) -> None:
    """101 KB plain text → text capped at EXTRACTION_BUDGET (100 KB),
    truncated flag set, full_text carries the entire raw input."""
    from agent_py.extraction import EXTRACTION_BUDGET

    raw = b"x" * (EXTRACTION_BUDGET + 1000)
    files = {"file": ("big.txt", io.BytesIO(raw), "text/plain")}
    r = client.post("/v1/extract", files=files, headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["truncated"] is True
    assert len(body["text"]) == EXTRACTION_BUDGET
    assert len(body["full_text"]) == EXTRACTION_BUDGET + 1000


def test_extract_extension_only_dispatch(client: TestClient) -> None:
    """Browser-supplied `application/octet-stream` → extension wins.
    Especially important for code / docx / xlsx where browsers
    routinely don't know the MIME type."""
    files = {"file": ("a.json", b'{"a":1}', "application/octet-stream")}
    r = client.post("/v1/extract", files=files, headers=_auth())
    assert r.status_code == 200
    assert r.json()["kind"] == "json"
