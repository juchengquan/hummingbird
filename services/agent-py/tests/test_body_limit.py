"""Request-body cap (`body_limit.py`).

Pins:
  - a declared Content-Length over the per-path limit → 413 before the
    app reads anything (and before auth: an unauthenticated multipart
    upload never reaches the form parser);
  - a chunked body is counted as it streams; crossing the limit → 413
    and the app never sees the chunk that crossed it;
  - bodies within the limit pass through untouched;
  - per-path limits (extract > chat/summarize > default).
"""

from __future__ import annotations

import json
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from starlette.types import Message, Receive, Scope, Send

from agent_py.body_limit import BodySizeLimitMiddleware, body_limit_for
from agent_py.main import create_app
from agent_py.settings import Settings


def _recording_app() -> tuple[BodySizeLimitMiddleware, list[bytes]]:
    """Inner app that reads the whole body, then answers 200 with its
    length. Records every chunk it was handed."""
    seen: list[bytes] = []

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        total = 0
        try:
            while True:
                message = await receive()
                chunk = message.get("body", b"")
                seen.append(chunk)
                total += len(chunk)
                if not message.get("more_body"):
                    break
        except Exception:
            # Mimic FastAPI: a failed body read becomes a 400.
            await send({"type": "http.response.start", "status": 400, "headers": []})
            await send({"type": "http.response.body", "body": b"bad body"})
            return
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": str(total).encode()})

    return BodySizeLimitMiddleware(app, limit_for=lambda _path: 100), seen


async def _run(
    mw: BodySizeLimitMiddleware, chunks: list[bytes], headers: list[tuple[bytes, bytes]]
) -> tuple[int, bytes]:
    queue: list[Message] = [
        {"type": "http.request", "body": c, "more_body": i < len(chunks) - 1}
        for i, c in enumerate(chunks)
    ]
    sent: list[Message] = []

    async def receive() -> Message:
        return queue.pop(0) if queue else {"type": "http.disconnect"}

    async def send(message: Message) -> None:
        sent.append(message)

    scope: Scope = {"type": "http", "method": "POST", "path": "/x", "headers": headers}
    await mw(scope, receive, send)
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, body


async def test_declared_content_length_over_limit_is_413_without_reading() -> None:
    mw, seen = _recording_app()
    status, body = await _run(mw, [b"x" * 10], [(b"content-length", b"101")])
    assert status == 413
    assert json.loads(body) == {"code": "payload_too_large", "message": "Request body too large."}
    assert seen == []


async def test_streamed_body_over_limit_is_413_and_crossing_chunk_withheld() -> None:
    mw, seen = _recording_app()
    status, body = await _run(mw, [b"a" * 60, b"b" * 60, b"c" * 60], [])
    assert status == 413
    assert json.loads(body)["code"] == "payload_too_large"
    # The app saw the first chunk only — never the one that crossed 100.
    assert seen == [b"a" * 60]


async def test_body_within_limit_passes() -> None:
    mw, seen = _recording_app()
    status, body = await _run(mw, [b"a" * 50, b"b" * 50], [(b"content-length", b"100")])
    assert status == 200
    assert body == b"100"
    assert b"".join(seen) == b"a" * 50 + b"b" * 50


async def test_malformed_content_length_is_400() -> None:
    mw, seen = _recording_app()
    status, body = await _run(mw, [b""], [(b"content-length", b"abc")])
    assert status == 400
    assert json.loads(body) == {
        "code": "invalid_request",
        "message": "Invalid Content-Length header.",
    }
    assert seen == []


def test_per_path_limits() -> None:
    settings = Settings(
        EXTRACT_MAX_BYTES=5_000_000, CHAT_BODY_MAX_BYTES=2_000_000, REQUEST_BODY_MAX_BYTES=1_000
    )
    limit_for = body_limit_for(settings)
    assert limit_for("/v1/extract") == 5_000_000 + 64 * 1024
    assert limit_for("/v1/extract/") == 5_000_000 + 64 * 1024
    assert limit_for("/v1/chat") == 2_000_000
    assert limit_for("/v1/summarize") == 2_000_000
    assert limit_for("/v1/extract-table") == 2 * 1024 * 1024
    assert limit_for("/v1/files/refresh-url") == 1_000
    assert limit_for("/v1/url/fetch") == 1_000
    assert limit_for("/v1/mcp/server") == 1_000


# --- through the real app ---------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "test-secret-do-not-use-in-prod-32-bytes!")
    monkeypatch.setenv("EXTRACT_MAX_BYTES", "1024")
    monkeypatch.setenv("REQUEST_BODY_MAX_BYTES", "512")
    return TestClient(create_app(enable_poller=False))


def test_unauthenticated_oversize_multipart_rejected_before_parsing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No token, 1 MB file part: 413 from the middleware — the form
    parser (which would spool the part to disk before auth runs) is
    never reached."""
    import starlette.formparsers as formparsers

    def _boom(*_a: object, **_k: object) -> None:
        raise AssertionError("multipart parser must not run")

    monkeypatch.setattr(formparsers.MultiPartParser, "parse", _boom)
    r = client.post(
        "/v1/extract",
        files={"file": ("big.txt", b"x" * (1024 * 1024), "text/plain")},
    )
    assert r.status_code == 413


def test_unauthenticated_chunked_json_over_default_limit_is_413(client: TestClient) -> None:
    def gen() -> Iterator[bytes]:
        for _ in range(64):
            yield b"x" * 64  # 4 KB total, no Content-Length

    r = client.post(
        "/v1/url/fetch",
        content=gen(),
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 413
    assert r.json()["code"] == "payload_too_large"


def test_small_unauthenticated_request_still_reaches_auth(client: TestClient) -> None:
    # A signed-in-only route (`/v1/url/fetch` serves anonymous callers
    # since wave 12).
    r = client.post("/v1/share", json={"kind": "conversation", "conversationId": "x"})
    assert r.status_code == 401


def test_get_routes_unaffected(client: TestClient) -> None:
    assert client.get("/healthz").status_code == 200
