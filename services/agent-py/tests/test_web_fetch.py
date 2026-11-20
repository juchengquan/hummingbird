"""Tests for the `webFetch` tool.

Hermetic — `httpx.MockTransport` intercepts the HTTP call so the test
never reaches the network. We cover:

  - input validation (missing / non-http URL),
  - HTTP error response surfaces a ToolError,
  - HTML body is stripped to plain text + title pulled from `<title>`,
  - non-HTML body falls through to plain text,
  - body cap at MAX_TEXT_CHARS appends a truncation marker,
  - SSRF: private targets, private redirect hops, DNS answers that
    point inside, and connect-time rebinding are all refused,
  - oversize bodies are rejected while streaming.

DNS is stubbed (autouse fixture) so hostnames resolve to a public
address without touching the network; tests that need a private
answer override it.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest

from agent_py import url_validate
from agent_py.outbound_http import build_outbound_client
from agent_py.tools.registry import ToolError
from agent_py.tools.web_fetch import (
    MAX_RESPONSE_BYTES,
    MAX_TEXT_CHARS,
    _execute_with_client,
    build_web_fetch_tool,
)


@pytest.fixture(autouse=True)
def _public_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_getaddrinfo(host: str) -> list[str]:
        return ["93.184.215.14"]

    monkeypatch.setattr(url_validate, "_async_getaddrinfo", fake_getaddrinfo)


def _mock_client(handler) -> httpx.AsyncClient:
    transport = httpx.MockTransport(handler)
    return httpx.AsyncClient(transport=transport)


@pytest.mark.asyncio
async def test_descriptor_shape() -> None:
    tool = build_web_fetch_tool()
    assert tool.name == "webFetch"
    assert "url" in tool.input_schema["properties"]
    assert tool.input_schema["required"] == ["url"]


@pytest.mark.asyncio
async def test_missing_url_raises_tool_error() -> None:
    async with _mock_client(lambda req: httpx.Response(200, text="x")) as client:
        with pytest.raises(ToolError):
            await _execute_with_client({}, client=client)
        with pytest.raises(ToolError):
            await _execute_with_client({"url": ""}, client=client)


@pytest.mark.asyncio
async def test_non_http_url_rejected() -> None:
    async with _mock_client(lambda req: httpx.Response(200)) as client:
        with pytest.raises(ToolError, match="must start with http"):
            await _execute_with_client({"url": "file:///etc/passwd"}, client=client)


@pytest.mark.asyncio
async def test_http_error_surfaces_as_tool_error() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="not found")

    async with _mock_client(handler) as client:
        with pytest.raises(ToolError, match="404"):
            await _execute_with_client({"url": "https://example.com/missing"}, client=client)


@pytest.mark.asyncio
async def test_html_body_stripped_with_title() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        body = """
        <html>
            <head><title>Example Page</title></head>
            <body>
                <script>var x = 1;</script>
                <style>body { color: red; }</style>
                <h1>Heading</h1>
                <p>Hello <b>world</b>.</p>
            </body>
        </html>
        """
        return httpx.Response(
            200,
            text=body,
            headers={"content-type": "text/html; charset=utf-8"},
        )

    async with _mock_client(handler) as client:
        out = await _execute_with_client({"url": "https://example.com"}, client=client)
    assert out.summary == 'Fetched "Example Page"'
    assert "Heading" in out.text
    assert "Hello world" in out.text
    # Script + style blocks dropped, not just their tags.
    assert "var x = 1" not in out.text
    assert "color: red" not in out.text


@pytest.mark.asyncio
async def test_non_html_passes_through() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text="raw\n  plain\n\n  text",
            headers={"content-type": "text/plain"},
        )

    async with _mock_client(handler) as client:
        out = await _execute_with_client({"url": "https://example.com/doc.txt"}, client=client)
    assert out.text == "raw plain text"
    assert out.summary.startswith("Fetched ")
    # Non-HTML → no title in summary.
    assert '"' not in out.summary


@pytest.mark.asyncio
async def test_large_body_truncated() -> None:
    huge = "x" * (MAX_TEXT_CHARS + 5_000)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=huge, headers={"content-type": "text/plain"})

    async with _mock_client(handler) as client:
        out = await _execute_with_client({"url": "https://example.com/huge"}, client=client)
    assert out.text.endswith("…[truncated]")
    assert len(out.text) <= MAX_TEXT_CHARS + len(" …[truncated]")


# --- SSRF + size hardening ------------------------------------------------


@pytest.mark.asyncio
async def test_private_ip_literal_rejected_without_request() -> None:
    hits: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        hits.append(str(req.url))
        return httpx.Response(200, text="secret")

    async with _mock_client(handler) as client:
        for url in (
            "http://127.0.0.1/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.5/",
            "http://[::1]/",
            "http://localhost:8000/",
        ):
            with pytest.raises(ToolError, match="not allowed"):
                await _execute_with_client({"url": url}, client=client)
    assert hits == []


@pytest.mark.asyncio
async def test_hostname_resolving_to_private_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    async def private_dns(host: str) -> list[str]:
        return ["192.168.1.10"]

    monkeypatch.setattr(url_validate, "_async_getaddrinfo", private_dns)
    async with _mock_client(lambda req: httpx.Response(200, text="secret")) as client:
        with pytest.raises(ToolError, match="not allowed"):
            await _execute_with_client({"url": "https://rebind.example"}, client=client)


@pytest.mark.asyncio
async def test_redirect_to_private_hop_rejected() -> None:
    hits: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        hits.append(str(req.url))
        if req.url.host == "example.com":
            return httpx.Response(302, headers={"location": "http://169.254.169.254/creds"})
        return httpx.Response(200, text="cloud credentials")

    async with _mock_client(handler) as client:
        with pytest.raises(ToolError, match="not allowed"):
            await _execute_with_client({"url": "https://example.com/r"}, client=client)
    # The metadata endpoint was never requested.
    assert hits == ["https://example.com/r"]


@pytest.mark.asyncio
async def test_public_redirect_followed_manually() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/old":
            return httpx.Response(301, headers={"location": "/new"})
        return httpx.Response(200, text="moved here", headers={"content-type": "text/plain"})

    async with _mock_client(handler) as client:
        out = await _execute_with_client({"url": "https://example.com/old"}, client=client)
    assert out.text == "moved here"


@pytest.mark.asyncio
async def test_redirect_loop_capped() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://example.com/again"})

    async with _mock_client(handler) as client:
        with pytest.raises(ToolError, match="redirects"):
            await _execute_with_client({"url": "https://example.com/"}, client=client)


@pytest.mark.asyncio
async def test_oversize_body_rejected_while_streaming() -> None:
    """A body over MAX_RESPONSE_BYTES is rejected without the whole
    thing being pulled into memory — the stream stops shortly past the
    cap even though the server would keep sending forever."""
    chunk = b"x" * 65_536
    sent = {"bytes": 0}

    async def endless() -> AsyncIterator[bytes]:
        while True:
            sent["bytes"] += len(chunk)
            yield chunk

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=endless(), headers={"content-type": "text/plain"})

    async with _mock_client(handler) as client:
        with pytest.raises(ToolError, match="exceeded"):
            await _execute_with_client({"url": "https://example.com/big"}, client=client)
    assert sent["bytes"] <= MAX_RESPONSE_BYTES + 2 * len(chunk)


@pytest.mark.asyncio
async def test_oversize_declared_content_length_rejected() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"tiny",
            headers={"content-length": str(MAX_RESPONSE_BYTES + 1)},
        )

    async with _mock_client(handler) as client:
        with pytest.raises(ToolError, match="exceeded"):
            await _execute_with_client({"url": "https://example.com/big"}, client=client)


# --- connect-time guard (DNS rebinding) ------------------------------------


@pytest.mark.asyncio
async def test_connect_time_guard_blocks_rebound_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The production client's network backend re-resolves at connect
    time and refuses a private address even though the pre-flight check
    passed (simulated by DNS answering public first, then loopback)."""
    answers = iter([["93.184.215.14"], ["127.0.0.1"]])

    async def rebinding_dns(host: str) -> list[str]:
        return next(answers)

    monkeypatch.setattr(url_validate, "_async_getaddrinfo", rebinding_dns)
    async with build_outbound_client(timeout_s=5.0, headers={}) as client:
        with pytest.raises(ToolError, match="not allowed"):
            await _execute_with_client({"url": "http://rebind.example/"}, client=client)


@pytest.mark.asyncio
async def test_guard_backend_dials_validated_ip() -> None:
    """The backend connects to the IP literal it validated, not the
    hostname, so a second DNS answer can't swap the target."""
    from agent_py import outbound_http

    dialled: list[str] = []

    class _FakeInner:
        async def connect_tcp(self, host: str, port: int, **_: object) -> object:
            dialled.append(host)
            return object()

    backend = outbound_http._SsrfGuardBackend()
    backend._inner = _FakeInner()  # type: ignore[assignment]
    await backend.connect_tcp("some.example", 443)
    assert dialled == ["93.184.215.14"]

    with pytest.raises(outbound_http.BlockedAddressError):
        await backend.connect_unix_socket("/var/run/docker.sock")
