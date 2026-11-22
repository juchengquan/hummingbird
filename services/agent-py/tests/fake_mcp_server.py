"""A real MCP server on 127.0.0.1 for the local-MCP tests (`FastMCP`,
streamable HTTP, served by uvicorn in a thread).

It records the headers of every request, and its tools are built to
probe the client:

* `echo(text)` — returns `text`;
* `whoami()` — returns the request's `Authorization` header (a server
  that echoes the credential back — the client must redact it);
* `fail()` — an `isError` result that echoes the `Authorization` header;
* `panel()` — an MCP App tool (`_meta.ui.resourceUri` = `ui://fake/panel`);
* `huge_panel()` — an MCP App whose bundle is over the 512 KB cap.

`ui://fake/broken` (the resource of `broken_panel()`) raises when read.
"""

from __future__ import annotations

import socket
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

import uvicorn
from mcp.server.fastmcp import Context, FastMCP
from starlette.types import ASGIApp, Receive, Scope, Send

PANEL_HTML = "<!doctype html><html><body><h1>Fake panel</h1></body></html>"
HUGE_PANEL_HTML = "<html>" + "x" * 600_000 + "</html>"


@dataclass
class FakeMcpServer:
    url: str
    headers: list[dict[str, str]] = field(default_factory=list)

    def authorizations(self) -> list[str | None]:
        return [h.get("authorization") for h in self.headers]


def _auth_header(ctx: Context[Any, Any, Any]) -> str:
    request = ctx.request_context.request
    headers = getattr(request, "headers", None)
    return headers.get("authorization", "<none>") if headers is not None else "<none>"


def _build_app() -> FastMCP:
    mcp = FastMCP("fake", stateless_http=True, json_response=True, log_level="WARNING")

    @mcp.tool(description="Echo the text back.")
    def echo(text: str) -> str:
        return text

    @mcp.tool(description="Tell who is calling.")
    def whoami(ctx: Context[Any, Any, Any]) -> str:
        return f"you sent: {_auth_header(ctx)}"

    @mcp.tool(description="Always fails.")
    def fail(ctx: Context[Any, Any, Any]) -> str:
        raise ValueError(f"denied for {_auth_header(ctx)}")

    @mcp.tool(description="Show a panel.", meta={"ui": {"resourceUri": "ui://fake/panel"}})
    def panel() -> str:
        return "panel shown"

    @mcp.tool(description="Show a huge panel.", meta={"ui": {"resourceUri": "ui://fake/huge"}})
    def huge_panel() -> str:
        return "huge panel shown"

    @mcp.tool(
        description="A panel that can't be read.", meta={"ui": {"resourceUri": "ui://fake/broken"}}
    )
    def broken_panel() -> str:
        return "broken panel shown"

    @mcp.resource("ui://fake/panel", mime_type="text/html;profile=mcp-app")
    def panel_html() -> str:
        return PANEL_HTML

    @mcp.resource("ui://fake/huge", mime_type="text/html;profile=mcp-app")
    def huge_html() -> str:
        return HUGE_PANEL_HTML

    @mcp.resource("ui://fake/broken", mime_type="text/html;profile=mcp-app")
    def broken_html() -> str:
        raise RuntimeError("cannot read the panel")

    return mcp


class _RecordHeaders:
    def __init__(self, app: ASGIApp, sink: list[dict[str, str]]) -> None:
        self.app = app
        self.sink = sink

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            self.sink.append(
                {k.decode("latin-1"): v.decode("latin-1") for k, v in scope["headers"]}
            )
        await self.app(scope, receive, send)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@contextmanager
def running_fake_mcp_server() -> Iterator[FakeMcpServer]:
    port = _free_port()
    server_info = FakeMcpServer(url=f"http://127.0.0.1:{port}/mcp")
    app = _RecordHeaders(_build_app().streamable_http_app(), server_info.headers)
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        if time.monotonic() > deadline or not thread.is_alive():
            raise RuntimeError("fake MCP server did not start")
        time.sleep(0.02)
    try:
        yield server_info
    finally:
        server.should_exit = True
        thread.join(timeout=10)
