"""Tests for the `webFetch` tool.

Hermetic — `httpx.MockTransport` intercepts the HTTP call so the test
never reaches the network. We cover:

  - input validation (missing / non-http URL),
  - HTTP error response surfaces a ToolError,
  - HTML body is stripped to plain text + title pulled from `<title>`,
  - non-HTML body falls through to plain text,
  - body cap at MAX_TEXT_CHARS appends a truncation marker.
"""

from __future__ import annotations

import httpx
import pytest

from agent_py.tools.registry import ToolError
from agent_py.tools.web_fetch import (
    MAX_TEXT_CHARS,
    _execute_with_client,
    build_web_fetch_tool,
)


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
