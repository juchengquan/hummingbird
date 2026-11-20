"""SSRF guard on every MCP egress path.

MCP server URLs are untrusted wherever they come from — a proxy request
body, a `mcp_servers` row (user-editable under RLS) or an upsert. Pins:

  - the MCP SDK's HTTP client is the guarded one (`mcp_http_client_factory`):
    connect-time IP pinning through `_SsrfGuardBackend`, no redirects,
    `trust_env=False`;
  - `_open_session` re-validates the URL before any network I/O, whichever
    caller (proxy, `/v1/chat`, executor) opened it, and hands the SDK the
    guarded factory + sanitised credential headers;
  - `POST /v1/mcp/server` refuses a private / loopback / metadata URL
    before the upsert RPC, with a detail-free message.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py import mcp_client, url_validate
from agent_py.main import create_app
from agent_py.mcp_client import (
    McpEndpoint,
    McpUrlBlockedError,
    _headers_from,
    mcp_http_client_factory,
)
from agent_py.outbound_http import BlockedAddressError, _GuardedTransport, _SsrfGuardBackend
from agent_py.routers import mcp as mcp_router

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
SERVER_ID = "11111111-1111-1111-1111-111111111111"

PRIVATE_URLS = [
    "http://127.0.0.1:8000/mcp",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.7/mcp",
    "http://[::1]/mcp",
    "http://localhost/mcp",
    "http://metadata.google.internal/",
]


@pytest.fixture(autouse=True)
def _public_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_getaddrinfo(host: str) -> list[str]:
        return ["93.184.215.14"]

    monkeypatch.setattr(url_validate, "_async_getaddrinfo", fake_getaddrinfo)


# --- the SDK client factory ------------------------------------------------


@pytest.mark.asyncio
async def test_factory_builds_a_guarded_client() -> None:
    timeout = httpx.Timeout(30, read=300)
    client = mcp_http_client_factory(headers={"Authorization": "Bearer t"}, timeout=timeout)
    async with client:
        assert client.follow_redirects is False
        assert client.trust_env is False
        assert client.timeout == timeout
        assert client.headers["Authorization"] == "Bearer t"
        transport = client._transport
        assert isinstance(transport, _GuardedTransport)
        assert isinstance(transport._pool._network_backend, _SsrfGuardBackend)


@pytest.mark.asyncio
async def test_factory_client_refuses_to_dial_a_private_address() -> None:
    """The guard runs at connect time — no validation call needed first.
    (Nothing listens on the port; the refusal happens before the dial.)"""
    async with mcp_http_client_factory() as client:
        with pytest.raises(httpx.ConnectError) as excinfo:
            await client.post("http://127.0.0.1:9/mcp", json={})
    assert isinstance(excinfo.value.__cause__, BlockedAddressError)


@pytest.mark.asyncio
async def test_factory_client_does_not_follow_redirects() -> None:
    """A 3xx from the (validated) MCP server must not bounce the request
    to an internal host: the response comes back unfollowed."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(307, headers={"location": "http://169.254.169.254/"})

    client = mcp_http_client_factory()
    client._transport = httpx.MockTransport(handler)
    async with client:
        response = await client.post("https://mcp.test/sse", json={})
    assert response.status_code == 307
    assert calls == ["https://mcp.test/sse"]


# --- _open_session ----------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_url", PRIVATE_URLS)
async def test_open_session_rejects_private_url_before_any_io(bad_url: str) -> None:
    transport = AsyncMock()
    with (
        patch("mcp.client.streamable_http.streamablehttp_client", new=transport),
        pytest.raises(McpUrlBlockedError),
    ):
        async with mcp_client._open_session(McpEndpoint(id="s", name="S", url=bad_url), None):
            pass
    transport.assert_not_called()


@pytest.mark.asyncio
async def test_open_session_rejects_hostname_resolving_private(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def private_dns(host: str) -> list[str]:
        return ["192.168.1.10"]

    monkeypatch.setattr(url_validate, "_async_getaddrinfo", private_dns)
    with pytest.raises(McpUrlBlockedError) as excinfo:
        async with mcp_client._open_session(
            McpEndpoint(id="s", name="S", url="https://rebind.example/mcp"), None
        ):
            pass
    assert excinfo.value.validation.code == "private_address"
    # The exception text carries only the code, not the resolved address.
    assert "192.168" not in str(excinfo.value)


class _Sentinel(Exception):
    pass


@pytest.mark.asyncio
async def test_open_session_hands_the_sdk_the_guarded_factory() -> None:
    captured: dict[str, Any] = {}

    @asynccontextmanager
    async def fake_transport(url: str, **kwargs: Any) -> AsyncIterator[Any]:
        captured["url"] = url
        captured.update(kwargs)
        raise _Sentinel
        yield  # pragma: no cover

    credentials = {
        "headers": {
            "Authorization": "Bearer t",
            "Host": "internal.svc",
            "X-Forwarded-For": "10.0.0.1",
            "X-Bad": "a\r\nInjected: 1",
        }
    }
    with (
        patch("mcp.client.streamable_http.streamablehttp_client", new=fake_transport),
        pytest.raises(_Sentinel),
    ):
        async with mcp_client._open_session(
            McpEndpoint(id="s", name="S", url="https://mcp.test/sse"), credentials
        ):
            pass
    assert captured["url"] == "https://mcp.test/sse"
    assert captured["httpx_client_factory"] is mcp_http_client_factory
    assert captured["headers"] == {"Authorization": "Bearer t"}


def test_headers_from_drops_unsafe_credential_headers() -> None:
    out = _headers_from(
        {
            "headers": {
                "X-API-Key": "k",
                "host": "evil",
                "Transfer-Encoding": "chunked",
                "Proxy-Authorization": "x",
                "Sec-Fetch-Site": "x",
                "Mcp-Session-Id": "x",
                "Bad Name": "x",
                "X-Crlf": "a\nb",
            }
        }
    )
    assert out == {"X-API-Key": "k"}


# --- POST /v1/mcp/server ----------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    return TestClient(create_app(enable_poller=False))


def _auth() -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": "00000000-0000-4000-8000-000000000001",
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
        },
        SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def _upsert_body(url: str) -> dict[str, Any]:
    return {
        "id": SERVER_ID,
        "workspaceId": "11111111-1111-1111-1111-111111111122",
        "name": "Cloud MCP",
        "url": url,
        "credentials": {"headers": {"X-API-Key": "secret"}},
        "enabled": True,
    }


@pytest.mark.parametrize("bad_url", PRIVATE_URLS)
def test_upsert_rejects_private_url_before_the_rpc(client: TestClient, bad_url: str) -> None:
    rpc = AsyncMock()
    with (
        patch.object(mcp_router, "has_pool", return_value=True),
        patch.object(mcp_router, "get_pool", return_value=AsyncMock()),
        patch.object(mcp_router, "upsert_server_with_credentials", new=rpc),
    ):
        r = client.post("/v1/mcp/server", json=_upsert_body(bad_url), headers=_auth())
    assert r.status_code == 400, bad_url
    detail = r.json()["detail"]
    assert detail["code"] == "mcp_url_blocked"
    assert detail["message"] == "MCP server URL is not allowed."
    rpc.assert_not_awaited()


def test_upsert_rejects_hostname_resolving_private(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def private_dns(host: str) -> list[str]:
        return ["10.9.8.7"]

    monkeypatch.setattr(url_validate, "_async_getaddrinfo", private_dns)
    rpc = AsyncMock()
    with (
        patch.object(mcp_router, "has_pool", return_value=True),
        patch.object(mcp_router, "get_pool", return_value=AsyncMock()),
        patch.object(mcp_router, "upsert_server_with_credentials", new=rpc),
    ):
        r = client.post(
            "/v1/mcp/server", json=_upsert_body("https://rebind.example/sse"), headers=_auth()
        )
    assert r.status_code == 400
    assert "10.9.8.7" not in r.text  # no internal-DNS oracle
    rpc.assert_not_awaited()


def test_proxy_blocked_url_message_is_generic(client: TestClient) -> None:
    body = {
        "server": {
            "id": SERVER_ID,
            "name": "x",
            "url": "http://10.0.0.7/mcp",
            "transport": "http",
        }
    }
    with patch.object(mcp_router, "mcp_discover", new=AsyncMock()) as discover:
        r = client.post(f"/v1/mcp/{SERVER_ID}/discover", json=body, headers=_auth())
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_server_url"
    assert "10.0.0.7" not in r.text
    discover.assert_not_awaited()
