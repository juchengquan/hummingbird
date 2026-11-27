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
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py.main import create_app
from agent_py.routers import extract as extract_router
from agent_py.settings import get_settings

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"


@pytest.fixture(autouse=True)
def _fresh_limits() -> None:
    extract_router.reset_limits()


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    return TestClient(create_app(enable_poller=False))


def _token() -> str:
    return jwt.encode(
        {
            "sub": "00000000-0000-4000-8000-0000000000aa",
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
        },
        SECRET,
        algorithm="HS256",
    )


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {_token()}"}


def test_extract_text_file_happy_path(client: TestClient) -> None:
    files = {"file": ("notes.txt", b"hello world", "text/plain")}
    r = client.post("/v1/extract", files=files, headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "text"
    assert body["text"] == "hello world"
    assert body["truncated"] is False
    # Absent fields are omitted (the contract's optional fields).
    assert "fullText" not in body
    assert "language" not in body


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
    assert len(body["fullText"]) == EXTRACTION_BUDGET + 1000


def test_extract_extension_only_dispatch(client: TestClient) -> None:
    """Browser-supplied `application/octet-stream` → extension wins.
    Especially important for code / docx / xlsx where browsers
    routinely don't know the MIME type."""
    files = {"file": ("a.json", b'{"a":1}', "application/octet-stream")}
    r = client.post("/v1/extract", files=files, headers=_auth())
    assert r.status_code == 200
    assert r.json()["kind"] == "json"


def test_extract_default_cap_matches_next_route() -> None:
    """Default cap = Next.js `FILE_SIZE_LIMIT` (5 MB)."""
    from agent_py.settings import Settings

    assert Settings().EXTRACT_MAX_BYTES == 5 * 1024 * 1024


def test_extract_oversize_upload_returns_413(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("EXTRACT_MAX_BYTES", "1024")
    c = TestClient(create_app(enable_poller=False))
    called = {"n": 0}

    def boom(**_: object) -> None:
        called["n"] += 1
        raise AssertionError("extractor must not run on oversize input")

    monkeypatch.setattr(extract_router, "extract_file", boom)
    files = {"file": ("big.txt", io.BytesIO(b"x" * 1025), "text/plain")}
    r = c.post("/v1/extract", files=files, headers=_auth())
    assert r.status_code == 413
    assert called["n"] == 0


def test_extract_at_cap_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("EXTRACT_MAX_BYTES", "1024")
    c = TestClient(create_app(enable_poller=False))
    files = {"file": ("ok.txt", io.BytesIO(b"x" * 1024), "text/plain")}
    r = c.post("/v1/extract", files=files, headers=_auth())
    assert r.status_code == 200


def test_extract_runs_off_the_event_loop(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Extraction is CPU-bound; it must run in a worker thread, not on
    the event-loop thread."""
    import threading

    seen: dict[str, object] = {}
    real = extract_router.extract_file

    def spy(**kwargs: object):  # type: ignore[no-untyped-def]
        seen["thread"] = threading.current_thread()
        try:
            import asyncio

            asyncio.get_running_loop()
            seen["in_loop"] = True
        except RuntimeError:
            seen["in_loop"] = False
        return real(**kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(extract_router, "extract_file", spy)
    files = {"file": ("a.txt", b"hi", "text/plain")}
    r = client.post("/v1/extract", files=files, headers=_auth())
    assert r.status_code == 200
    assert seen["in_loop"] is False


# --- signed out, limits, vision, cache (wave 12, Q123/Q134) -----------------------


def _pdf(text: str = "") -> bytes:
    """A one-page PDF (blank — its text pass finds nothing: low yield)."""
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=100)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


@pytest.fixture
def vision_calls(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Stubs the vision pass: a model is configured, every run is recorded
    and answers fixed markdown."""
    calls: list[str] = []

    async def fake_run(data: bytes, model: str) -> str:
        calls.append(model)
        return "# Vision markdown"

    monkeypatch.setattr(extract_router, "_resolve_vision_model", lambda: "vision/model")
    monkeypatch.setattr(extract_router, "_run_vision", fake_run)
    return calls


def _upload_pdf(c: TestClient, headers: dict[str, str] | None = None, **form: str) -> Any:
    files = {"file": ("scan.pdf", _pdf(), "application/pdf")}
    return c.post("/v1/extract", files=files, data=form or None, headers=headers or {})


def test_extract_serves_anonymous_callers(client: TestClient) -> None:
    files = {"file": ("notes.txt", b"hello world", "text/plain")}
    r = client.post("/v1/extract", files=files)
    assert r.status_code == 200
    assert r.json() == {"kind": "text", "text": "hello world", "truncated": False}


def test_extract_rejects_a_bad_token(client: TestClient) -> None:
    files = {"file": ("a.txt", b"x", "text/plain")}
    r = client.post("/v1/extract", files=files, headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_extract_limits_anonymous_text_extraction_60_a_minute_per_ip(client: TestClient) -> None:
    ip = {"X-Forwarded-For": "203.0.113.40"}
    for i in range(60):
        files = {"file": (f"{i}.txt", b"x", "text/plain")}
        assert client.post("/v1/extract", files=files, headers=ip).status_code == 200
    files = {"file": ("late.txt", b"x", "text/plain")}
    r = client.post("/v1/extract", files=files, headers=ip)
    assert r.status_code == 429
    assert r.json()["code"] == "rate_limit"
    assert int(r.headers["Retry-After"]) >= 1
    other = {"X-Forwarded-For": "203.0.113.41"}
    assert client.post("/v1/extract", files=files, headers=other).status_code == 200
    # Signed in: agent-py's signed-in limits are unchanged (none here).
    for _ in range(3):
        assert client.post("/v1/extract", files=files, headers={**ip, **_auth()}).status_code == 200


def test_extract_runs_vision_on_a_scanned_pdf(client: TestClient, vision_calls: list[str]) -> None:
    r = _upload_pdf(client)
    assert r.status_code == 200
    assert r.json()["text"] == "# Vision markdown"
    assert r.json()["kind"] == "pdf"
    assert vision_calls == ["vision/model"]


def test_extract_vision_field_forces_it_off(client: TestClient, vision_calls: list[str]) -> None:
    r = _upload_pdf(client, vision="false")
    assert r.status_code == 200
    assert r.json()["text"] == ""
    assert vision_calls == []


def test_anonymous_extraction_skips_vision_under_require_auth(
    client: TestClient, vision_calls: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Text extraction spends no model budget, so it stays open; the vision
    pass is model-backed, so an anonymous caller is forced to text-only."""
    monkeypatch.setenv("REQUIRE_AUTH_FOR_AI", "true")
    get_settings.cache_clear()
    r = _upload_pdf(client, vision="true")
    assert r.status_code == 200
    assert r.json()["text"] == ""
    assert vision_calls == []
    r = _upload_pdf(client, headers=_auth(), vision="true")
    assert r.json()["text"] == "# Vision markdown"
    assert vision_calls == ["vision/model"]


def test_vision_is_limited_10_a_minute_per_ip_for_everyone(
    client: TestClient, vision_calls: list[str]
) -> None:
    """Next's `extractVisionLimit`: every caller, per IP. Past it the
    text-only result is returned (and not cached)."""
    ip = {"X-Forwarded-For": "203.0.113.50"}
    for i in range(10):
        files = {"file": (f"{i}.pdf", _pdf(), "application/pdf")}
        r = client.post("/v1/extract", files=files, headers={**ip, **_auth()})
        assert r.json()["text"] == "# Vision markdown"
    files = {"file": ("late.pdf", _pdf(), "application/pdf")}
    r = client.post("/v1/extract", files=files, headers={**ip, **_auth()})
    assert r.status_code == 200
    assert r.json()["text"] == ""
    assert len(vision_calls) == 10
    # Not cached: once the window has room, the same file gets vision.
    extract_router.reset_limits()
    r = client.post("/v1/extract", files=files, headers={**ip, **_auth()})
    assert r.json()["text"] == "# Vision markdown"


def test_extract_caches_by_content_and_vision_mode(
    client: TestClient, vision_calls: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    runs = {"n": 0}
    real = extract_router.extract_file

    def counting(**kwargs: Any) -> Any:
        runs["n"] += 1
        return real(**kwargs)

    monkeypatch.setattr(extract_router, "extract_file", counting)
    assert _upload_pdf(client).json()["text"] == "# Vision markdown"
    assert _upload_pdf(client, headers=_auth()).json()["text"] == "# Vision markdown"
    assert runs["n"] == 1 and len(vision_calls) == 1
    # Another mode is another entry: `off` never gets the vision text.
    assert _upload_pdf(client, vision="false").json()["text"] == ""
    assert runs["n"] == 2


def test_a_failed_vision_pass_is_not_cached(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    attempts = {"n": 0}

    async def flaky(data: bytes, model: str) -> str:
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise RuntimeError("model down")
        return "# Second try"

    monkeypatch.setattr(extract_router, "_resolve_vision_model", lambda: "vision/model")
    monkeypatch.setattr(extract_router, "_run_vision", flaky)
    assert _upload_pdf(client).json()["text"] == ""
    assert _upload_pdf(client).json()["text"] == "# Second try"


def test_full_text_is_camel_case(client: TestClient) -> None:
    from agent_py.extraction import EXTRACTION_BUDGET

    raw = b"x" * (EXTRACTION_BUDGET + 10)
    r = client.post("/v1/extract", files={"file": ("big.txt", io.BytesIO(raw), "text/plain")})
    body = r.json()
    assert "full_text" not in body
    assert len(body["fullText"]) == EXTRACTION_BUDGET + 10
