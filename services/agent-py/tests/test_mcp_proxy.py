"""Phase 4-4b tests — `/v1/mcp/{server_id}/{action}` route.

The MCP client (`mcp_client.discover` / `call_tool` / `read_resource`)
is patched at the module boundary in `main` so we test the proxy's
dispatch, credential resolution (header vs cloud lookup), and error
mapping without touching the SDK or a real MCP server.
"""

from __future__ import annotations

import base64
import json
import time
from typing import Any
from unittest.mock import AsyncMock, patch

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py import main as main_module
from agent_py.main import create_app
from agent_py.mcp_client import (
    McpCapabilities,
    McpResourceContent,
    McpToolDescriptor,
    McpToolResult,
)
from agent_py.routers import mcp as mcp_router

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
SERVER_ID = "11111111-1111-1111-1111-111111111111"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    return TestClient(create_app(enable_poller=False))


def _token(sub: str = "user-uuid-1") -> str:
    return jwt.encode(
        {"sub": sub, "role": "authenticated", "exp": int(time.time()) + 3600},
        SECRET,
        algorithm="HS256",
    )


def _auth(sub: str = "user-uuid-1") -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(sub)}"}


def _server_body(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    base: dict[str, Any] = {
        "server": {
            "id": SERVER_ID,
            "name": "Test MCP",
            "url": "https://mcp.test/sse",
            "transport": "http",
        }
    }
    if extra:
        base.update(extra)
    return base


def _cred_header(credential: dict[str, Any]) -> dict[str, str]:
    encoded = base64.b64encode(json.dumps(credential).encode()).decode()
    return {"X-MCP-Credentials": encoded}


# --- failure paths --------------------------------------------------


def test_mcp_proxy_rejects_missing_token(client: TestClient) -> None:
    r = client.post(f"/v1/mcp/{SERVER_ID}/discover", json=_server_body())
    assert r.status_code == 401


def test_mcp_proxy_404_on_unknown_action(client: TestClient) -> None:
    r = client.post(f"/v1/mcp/{SERVER_ID}/bogus", json=_server_body(), headers=_auth())
    assert r.status_code == 404


def test_mcp_proxy_400_on_path_body_mismatch(client: TestClient) -> None:
    """Body's `server.id` must match the path `serverId`. Catches a
    buggy client that accidentally hits the wrong server config."""
    body = _server_body()
    body["server"]["id"] = "different-id"
    r = client.post(f"/v1/mcp/{SERVER_ID}/discover", json=body, headers=_auth())
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "serverId_mismatch"


def test_mcp_proxy_400_on_call_missing_tool(client: TestClient) -> None:
    """`call` action requires `body.tool`."""
    body = _server_body()
    with patch.object(mcp_router, "mcp_call_tool", new=AsyncMock()):
        r = client.post(f"/v1/mcp/{SERVER_ID}/call", json=body, headers=_auth())
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_body"


def test_mcp_proxy_400_on_read_missing_uri(client: TestClient) -> None:
    """`read` action requires `body.uri`."""
    body = _server_body()
    with patch.object(mcp_router, "mcp_read_resource", new=AsyncMock()):
        r = client.post(f"/v1/mcp/{SERVER_ID}/read", json=body, headers=_auth())
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_body"


# --- discover -------------------------------------------------------


def test_mcp_proxy_discover_returns_capabilities(client: TestClient) -> None:
    caps = McpCapabilities(
        tools=[
            McpToolDescriptor(
                name="greet",
                description="say hi",
                input_schema={"type": "object"},
            )
        ],
        resources=None,
        prompts=None,
    )
    with patch.object(mcp_router, "mcp_discover", new=AsyncMock(return_value=caps)):
        r = client.post(
            f"/v1/mcp/{SERVER_ID}/discover",
            json=_server_body(),
            headers=_auth(),
        )
    assert r.status_code == 200
    body = r.json()
    assert body["capabilities"]["tools"][0]["name"] == "greet"
    assert body["capabilities"]["resources"] is None
    assert body["capabilities"]["prompts"] is None


def test_mcp_proxy_discover_forwards_header_credentials(
    client: TestClient,
) -> None:
    """A header cred bypasses the cloud lookup and gets forwarded
    verbatim to the MCP client."""
    captured: dict[str, Any] = {}

    async def fake_discover(endpoint: Any, credentials: Any) -> McpCapabilities:
        captured["credentials"] = credentials
        return McpCapabilities()

    with patch.object(mcp_router, "mcp_discover", new=fake_discover):
        r = client.post(
            f"/v1/mcp/{SERVER_ID}/discover",
            json=_server_body(),
            headers={
                **_auth(),
                **_cred_header({"headers": {"X-API-Key": "secret"}}),
            },
        )
    assert r.status_code == 200
    assert captured["credentials"] == {"headers": {"X-API-Key": "secret"}}


def test_mcp_proxy_discover_falls_back_to_cloud_lookup(
    client: TestClient,
) -> None:
    """No header cred → cloud lookup. We don't have a DB pool in this
    test (no `SUPABASE_DB_URL`), so `get_pool()` returns None and the
    proxy skips the lookup, calling discover with credentials=None.
    Confirms the route doesn't crash on missing pool — the upstream
    decides whether the call needs auth."""
    captured: dict[str, Any] = {}

    async def fake_discover(endpoint: Any, credentials: Any) -> McpCapabilities:
        captured["credentials"] = credentials
        return McpCapabilities()

    with patch.object(mcp_router, "mcp_discover", new=fake_discover):
        r = client.post(
            f"/v1/mcp/{SERVER_ID}/discover",
            json=_server_body(),
            headers=_auth(),
        )
    assert r.status_code == 200
    assert captured["credentials"] is None


def test_mcp_proxy_discover_invalid_header_falls_through_to_lookup(
    client: TestClient,
) -> None:
    """A malformed X-MCP-Credentials header decodes to None and the
    cloud-lookup branch runs. Defensive against a bad client that
    sends junk in the header."""
    captured: dict[str, Any] = {}

    async def fake_discover(endpoint: Any, credentials: Any) -> McpCapabilities:
        captured["credentials"] = credentials
        return McpCapabilities()

    with patch.object(mcp_router, "mcp_discover", new=fake_discover):
        r = client.post(
            f"/v1/mcp/{SERVER_ID}/discover",
            json=_server_body(),
            headers={**_auth(), "X-MCP-Credentials": "not-base64!"},
        )
    assert r.status_code == 200
    # `not-base64!` decodes to None; cloud lookup runs but pool is
    # also None in the test environment, so we still arrive with None.
    assert captured["credentials"] is None


def test_mcp_proxy_502_on_upstream_exception(client: TestClient) -> None:
    """Any exception from the MCP client bubbles up as 502 — and
    the error response never includes the credentials object."""
    with patch.object(
        mcp_router,
        "mcp_discover",
        new=AsyncMock(side_effect=RuntimeError("upstream down")),
    ):
        r = client.post(
            f"/v1/mcp/{SERVER_ID}/discover",
            json=_server_body(),
            headers={
                **_auth(),
                **_cred_header({"headers": {"X-API-Key": "shh"}}),
            },
        )
    assert r.status_code == 502
    detail = r.json()["detail"]
    assert detail["code"] == "mcp_call_failed"
    # Never leak the credential.
    assert "shh" not in json.dumps(r.json())


# --- call -----------------------------------------------------------


def test_mcp_proxy_call_returns_tool_result(client: TestClient) -> None:
    res = McpToolResult(text="hello from tool", is_error=False)
    with patch.object(mcp_router, "mcp_call_tool", new=AsyncMock(return_value=res)):
        r = client.post(
            f"/v1/mcp/{SERVER_ID}/call",
            json=_server_body({"tool": "greet", "input": {"name": "world"}}),
            headers=_auth(),
        )
    assert r.status_code == 200
    assert r.json() == {"result": {"text": "hello from tool", "isError": False}}


def test_mcp_proxy_call_forwards_input_args(client: TestClient) -> None:
    """The proxy forwards `input` verbatim to `mcp_call_tool`."""
    captured: dict[str, Any] = {}

    async def fake_call(endpoint: Any, credentials: Any, tool: str, args: Any) -> McpToolResult:
        captured.update({"tool": tool, "args": args})
        return McpToolResult(text="ok", is_error=False)

    with patch.object(mcp_router, "mcp_call_tool", new=fake_call):
        client.post(
            f"/v1/mcp/{SERVER_ID}/call",
            json=_server_body({"tool": "greet", "input": {"q": "hi"}}),
            headers=_auth(),
        )
    assert captured["tool"] == "greet"
    assert captured["args"] == {"q": "hi"}


def test_mcp_proxy_call_is_error_propagates(client: TestClient) -> None:
    """An MCP tool that signals `is_error` in its result still
    returns 200 — the error is in the result body, not a transport
    failure. The frontend renders it as a tool failure."""
    res = McpToolResult(text="upstream said no", is_error=True)
    with patch.object(mcp_router, "mcp_call_tool", new=AsyncMock(return_value=res)):
        r = client.post(
            f"/v1/mcp/{SERVER_ID}/call",
            json=_server_body({"tool": "x"}),
            headers=_auth(),
        )
    assert r.status_code == 200
    assert r.json()["result"]["isError"] is True


# --- read -----------------------------------------------------------


def test_mcp_proxy_read_returns_resource_content(client: TestClient) -> None:
    res = McpResourceContent(text="resource body", mime_type="text/plain")
    with patch.object(mcp_router, "mcp_read_resource", new=AsyncMock(return_value=res)):
        r = client.post(
            f"/v1/mcp/{SERVER_ID}/read",
            json=_server_body({"uri": "file:///some.txt"}),
            headers=_auth(),
        )
    assert r.status_code == 200
    assert r.json() == {"result": {"text": "resource body", "mimeType": "text/plain"}}


def test_mcp_proxy_read_handles_missing_mime(client: TestClient) -> None:
    """`mime_type=None` survives the wire — the JSON has null."""
    res = McpResourceContent(text=None, mime_type=None)
    with patch.object(mcp_router, "mcp_read_resource", new=AsyncMock(return_value=res)):
        r = client.post(
            f"/v1/mcp/{SERVER_ID}/read",
            json=_server_body({"uri": "file:///x"}),
            headers=_auth(),
        )
    assert r.status_code == 200
    assert r.json()["result"] == {"text": None, "mimeType": None}


# --- helper: decode header ------------------------------------------


def test_decode_credential_header_base64_json() -> None:
    encoded = base64.b64encode(b'{"headers":{"X":"y"}}').decode()
    out = main_module._decode_mcp_credential_header(encoded)
    assert out == {"headers": {"X": "y"}}


def test_decode_credential_header_none() -> None:
    assert main_module._decode_mcp_credential_header(None) is None
    assert main_module._decode_mcp_credential_header("") is None


def test_decode_credential_header_garbage() -> None:
    assert main_module._decode_mcp_credential_header("not-base64-at-all!!!") is None


def test_decode_credential_header_non_object() -> None:
    encoded = base64.b64encode(b"[1, 2, 3]").decode()
    assert main_module._decode_mcp_credential_header(encoded) is None
