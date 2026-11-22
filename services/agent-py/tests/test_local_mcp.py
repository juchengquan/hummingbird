"""Local MCP servers on interactive runs (Q42, Q45), `MCP_ALLOW_PRIVATE_HOSTS`
and MCP Apps — wave 5b-D.

* the private-hosts policy, in validation and at connect time: off blocks
  loopback / RFC 1918; on admits them; link-local and cloud metadata are
  blocked either way; redirects are re-validated under the policy;
* `runs/local_mcp.local_mcp_tools` builds `mcp__<server>__<tool>` from the
  request's cached capabilities (no discovery), gates `requiresApproval`
  servers, honours `allowedMcpServerIds`, drops blocked URLs;
* the tools call a real MCP server (`fake_mcp_server`, on 127.0.0.1 — so
  only with `MCP_ALLOW_PRIVATE_HOSTS=true`) with the run's credentials,
  and nothing the server sends back carries them (redaction);
* MCP Apps: the `ui://` resource read after the tool ran, the 512 KB cap;
* end to end through `/v1/runs`: a gated local tool interrupts, the
  resume re-sends the credentials and the tool runs with them; nothing
  stores or logs them.
"""

from __future__ import annotations

import dataclasses
import logging
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import structlog
from fastapi.testclient import TestClient
from pydantic import ValidationError as PydanticValidationError

from agent_py import mcp_client, url_validate
from agent_py.emitter import RunEmitter
from agent_py.main import create_app
from agent_py.mcp_client import (
    McpEndpoint,
    McpResourceContent,
    McpToolDescriptor,
    McpToolResult,
    mcp_http_client_factory,
    mcp_outbound_policy,
)
from agent_py.mcp_tools import (
    MCP_APP_MAX_BYTES,
    MCP_APP_TRUNCATED_HTML,
    _tools_from_capabilities,
    build_mcp_tool,
    credential_redactor,
)
from agent_py.outbound_http import (
    BlockedAddressError,
    OutboundFetchError,
    build_guarded_client,
    safe_get,
)
from agent_py.runs import wiring
from agent_py.runs.credentials import LOCAL_MCP_STATE_KEY, LocalMcpCredential
from agent_py.runs.harness import RunInput
from agent_py.runs.hook_types import HookContext, ToolsetDraft
from agent_py.runs.local_mcp import local_mcp_tools
from agent_py.runs.native_harness import build_native_harness
from agent_py.runs.options import parse_run_options
from agent_py.runs.wiring import RunServices, build_run_services
from agent_py.settings import Settings, get_settings
from agent_py.tools.registry import RunToolContext, ToolError
from agent_py.url_validate import (
    PUBLIC_ONLY,
    OutboundUrlPolicy,
    ValidationError,
    ValidationOk,
    is_address_allowed,
    validate_outbound_url,
)

from .fake_mcp_server import HUGE_PANEL_HTML, PANEL_HTML, running_fake_mcp_server
from .test_native_harness import MODEL, _Call, _Model, call, text

PRIVATE = OutboundUrlPolicy(allow_private_hosts=True)
SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
TOKEN = "sk-local-mcp-NEVER-LEAK-4c1d9e"
BEARER = f"Bearer {TOKEN}"


@pytest.fixture
def allow_private(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MCP_ALLOW_PRIVATE_HOSTS", "true")
    get_settings.cache_clear()


@pytest.fixture
def fake_server() -> Iterator[Any]:
    with running_fake_mcp_server() as srv:
        yield srv


def _dns(answer: list[str]) -> Any:
    async def fake(host: str) -> list[str]:
        return answer

    return patch.object(url_validate, "_async_getaddrinfo", new=fake)


# --- the policy: validation ------------------------------------------------------------

PRIVATE_LITERALS = [
    "http://127.0.0.1:8080/mcp",
    "http://10.0.0.7/mcp",
    "http://172.16.4.2/mcp",
    "http://192.168.1.20/mcp",
    "http://[::1]/mcp",
    "http://[fd12::1]/mcp",
]

ALWAYS_BLOCKED = [
    "http://169.254.169.254/latest/meta-data",
    "http://169.254.1.1/",
    "http://[fe80::1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[fd00:ec2::254]/",
    "http://metadata.google.internal/",
    "http://metadata.google.internal./",
    "http://metadata.azure.com/",
    "http://metadata/",
]


@pytest.mark.asyncio
@pytest.mark.parametrize("url", [*PRIVATE_LITERALS, "http://localhost:3000/mcp"])
async def test_public_policy_blocks_private_hosts(url: str) -> None:
    with _dns(["127.0.0.1"]):
        out = await validate_outbound_url(url)
    assert isinstance(out, ValidationError)


@pytest.mark.asyncio
@pytest.mark.parametrize("url", PRIVATE_LITERALS)
async def test_private_policy_admits_loopback_and_rfc1918(url: str) -> None:
    out = await validate_outbound_url(url, PRIVATE)
    assert isinstance(out, ValidationOk)


@pytest.mark.asyncio
async def test_private_policy_admits_private_names() -> None:
    with _dns(["127.0.0.1"]):
        assert isinstance(
            await validate_outbound_url("http://localhost:3000/", PRIVATE), ValidationOk
        )
    with _dns(["192.168.1.5"]):
        assert isinstance(
            await validate_outbound_url("http://nas.local/mcp", PRIVATE), ValidationOk
        )
        # …and without the policy the textual blocklist refuses it.
        out = await validate_outbound_url("http://nas.local/mcp")
        assert isinstance(out, ValidationError) and out.code == "blocked_host"


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [PUBLIC_ONLY, PRIVATE])
@pytest.mark.parametrize("url", ALWAYS_BLOCKED)
async def test_link_local_and_metadata_are_blocked_under_every_policy(
    url: str, policy: OutboundUrlPolicy
) -> None:
    out = await validate_outbound_url(url, policy)
    assert isinstance(out, ValidationError)


@pytest.mark.asyncio
async def test_a_name_resolving_to_link_local_is_blocked_even_under_the_private_policy() -> None:
    with _dns(["10.0.0.2", "169.254.169.254"]):
        out = await validate_outbound_url("http://rebind.example/", PRIVATE)
    assert isinstance(out, ValidationError) and out.code == "private_address"


def test_is_address_allowed() -> None:
    assert is_address_allowed("93.184.215.14")
    assert not is_address_allowed("127.0.0.1")
    assert is_address_allowed("127.0.0.1", PRIVATE)
    assert is_address_allowed("::1", PRIVATE)
    for addr in ("169.254.169.254", "fe80::1", "::ffff:169.254.169.254", "fd00:ec2::254", "junk"):
        assert not is_address_allowed(addr, PRIVATE)


# --- the policy: the setting -----------------------------------------------------------


def test_setting_is_strict(monkeypatch: pytest.MonkeyPatch) -> None:
    assert Settings().MCP_ALLOW_PRIVATE_HOSTS is False
    assert Settings(MCP_ALLOW_PRIVATE_HOSTS="true").MCP_ALLOW_PRIVATE_HOSTS is True  # type: ignore[arg-type]
    assert Settings(MCP_ALLOW_PRIVATE_HOSTS="false").MCP_ALLOW_PRIVATE_HOSTS is False  # type: ignore[arg-type]
    assert Settings(MCP_ALLOW_PRIVATE_HOSTS="").MCP_ALLOW_PRIVATE_HOSTS is False  # type: ignore[arg-type]
    for bad in ("1", "yes", "TRUE", "on"):
        with pytest.raises(PydanticValidationError):
            Settings(MCP_ALLOW_PRIVATE_HOSTS=bad)  # type: ignore[arg-type]


def test_mcp_outbound_policy_follows_the_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    assert mcp_outbound_policy() == PUBLIC_ONLY
    monkeypatch.setenv("MCP_ALLOW_PRIVATE_HOSTS", "true")
    get_settings.cache_clear()
    assert mcp_outbound_policy() == PRIVATE


# --- the policy: at connect time -------------------------------------------------------


@pytest.mark.asyncio
async def test_connect_time_check_refuses_loopback_by_default(fake_server: Any) -> None:
    async with build_guarded_client() as client:
        with pytest.raises(httpx.ConnectError) as excinfo:
            await client.post(fake_server.url, json={})
    assert isinstance(excinfo.value.__cause__, BlockedAddressError)
    assert fake_server.headers == []


@pytest.mark.asyncio
async def test_connect_time_check_admits_loopback_under_the_private_policy(
    fake_server: Any,
) -> None:
    async with build_guarded_client(policy=PRIVATE) as client:
        response = await client.get(fake_server.url)
    assert response.status_code < 500
    assert len(fake_server.headers) == 1


@pytest.mark.asyncio
async def test_connect_time_check_refuses_metadata_under_the_private_policy() -> None:
    """The dial is refused before any socket opens: nothing listens there."""
    async with build_guarded_client(policy=PRIVATE) as client:
        with pytest.raises(httpx.ConnectError) as excinfo:
            await client.get("http://169.254.169.254/latest/meta-data")
    assert isinstance(excinfo.value.__cause__, BlockedAddressError)


@pytest.mark.asyncio
async def test_connect_time_rebinding_to_link_local_is_refused_under_the_private_policy() -> None:
    """The name passed validation (public); at connect it answers with the
    metadata address — refused even with private hosts allowed."""
    async with build_guarded_client(policy=PRIVATE) as client:
        with _dns(["169.254.169.254"]), pytest.raises(httpx.ConnectError) as excinfo:
            await client.get("http://rebind.example/")
    assert isinstance(excinfo.value.__cause__, BlockedAddressError)


@pytest.mark.asyncio
async def test_mcp_session_uses_the_private_factory_only_under_the_policy() -> None:
    captured: list[Any] = []

    @asynccontextmanager
    async def fake_transport(url: str, **kwargs: Any) -> AsyncIterator[Any]:
        captured.append(kwargs["httpx_client_factory"])
        raise RuntimeError("stop")
        yield  # pragma: no cover

    endpoint = McpEndpoint(id="s", name="S", url="http://127.0.0.1:9/mcp")
    with patch("mcp.client.streamable_http.streamablehttp_client", new=fake_transport):
        with pytest.raises(RuntimeError):
            async with mcp_client._open_session(endpoint, None, PRIVATE):
                pass
        with pytest.raises(mcp_client.McpUrlBlockedError):
            async with mcp_client._open_session(endpoint, None, PUBLIC_ONLY):
                pass
    assert len(captured) == 1 and captured[0] is not mcp_http_client_factory
    async with captured[0]() as client:
        assert client._transport._pool._network_backend.policy == PRIVATE


# --- the policy: redirects ---------------------------------------------------------------


def _redirecting(target: str) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "start.example":
            return httpx.Response(302, headers={"location": target})
        return httpx.Response(200, text="landed")

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [PUBLIC_ONLY, PRIVATE])
async def test_a_redirect_to_metadata_is_refused_under_every_policy(
    policy: OutboundUrlPolicy,
) -> None:
    with _dns(["93.184.215.14"]):
        async with _redirecting("http://169.254.169.254/latest") as client:
            with pytest.raises(OutboundFetchError) as excinfo:
                await safe_get(
                    "https://start.example/",
                    client=client,
                    max_body_bytes=1000,
                    total_timeout_s=5,
                    policy=policy,
                )
    assert excinfo.value.code == "validation"


@pytest.mark.asyncio
async def test_a_redirect_to_loopback_follows_the_policy() -> None:
    with _dns(["93.184.215.14"]):
        async with _redirecting("http://127.0.0.1:8080/x") as client:
            with pytest.raises(OutboundFetchError):
                await safe_get(
                    "https://start.example/", client=client, max_body_bytes=1000, total_timeout_s=5
                )
            ok = await safe_get(
                "https://start.example/",
                client=client,
                max_body_bytes=1000,
                total_timeout_s=5,
                policy=PRIVATE,
            )
    assert ok.body == b"landed"


# --- the proxy honours the setting -------------------------------------------------------


def _jwt() -> str:
    import time

    import jwt

    return jwt.encode(
        {
            "sub": "00000000-0000-4000-8000-000000000001",
            "role": "authenticated",
            "aud": "authenticated",
            "exp": time.time() + 600,
        },
        SECRET,
        algorithm="HS256",
    )


@pytest.mark.parametrize(("allowed", "status"), [(False, 400), (True, 200)])
def test_proxy_reaches_a_localhost_server_only_with_the_setting(
    monkeypatch: pytest.MonkeyPatch, allowed: bool, status: int
) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    if allowed:
        monkeypatch.setenv("MCP_ALLOW_PRIVATE_HOSTS", "true")
    get_settings.cache_clear()
    from agent_py.routers import mcp as mcp_router

    body = {"server": {"id": "s1", "name": "S", "url": "http://127.0.0.1:9/mcp"}, "tool": "t"}
    res = McpToolResult(text="ok")
    with (
        TestClient(create_app(enable_poller=False)) as client,
        patch.object(mcp_router, "mcp_call_tool", new=AsyncMock(return_value=res)),
    ):
        r = client.post("/v1/mcp/s1/call", json=body, headers={"Authorization": f"Bearer {_jwt()}"})
        assert r.status_code == status, r.text
        meta = {**body, "server": {**body["server"], "url": "http://169.254.169.254/"}}
        r2 = client.post(
            "/v1/mcp/s1/call", json=meta, headers={"Authorization": f"Bearer {_jwt()}"}
        )
        assert r2.status_code == 400


# --- the contributor ------------------------------------------------------------------------


def _server(
    sid: str, url: str, *tools: str, approval: bool = False, ui: str | None = None
) -> dict[str, Any]:
    return {
        "id": sid,
        "name": f"Server {sid}",
        "url": url,
        "transport": "http",
        **({"requiresApproval": True} if approval else {}),
        "capabilities": {
            "tools": [
                {
                    "name": t,
                    "description": f"{t} tool",
                    "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}},
                    **({"uiResourceUri": ui} if ui and t.endswith("panel") else {}),
                }
                for t in tools
            ]
        },
    }


def _run_input(
    servers: list[dict[str, Any]],
    creds: dict[str, LocalMcpCredential] | None = None,
    **fp: Any,
) -> RunInput:
    return RunInput(
        run_id="r1",
        thread_id="t1",
        mode="interactive",
        user_id=None,
        messages=[],
        options={"localMcpServers": servers, **fp},
        local_mcp_credentials=creds or {},
    )


def _ctx() -> HookContext:
    import asyncio

    from agent_py.chat_loop import UsageMeter

    async def sink(_e: object) -> None:
        return None

    return HookContext(
        emitter=RunEmitter(run_id="r1", sink=sink),
        cancel=asyncio.Event(),
        usage=UsageMeter(),
        pool=None,
        tool_context=None,
        run_tools=RunToolContext(),
    )


async def _contribute(ri: RunInput) -> ToolsetDraft:
    draft = ToolsetDraft()
    await local_mcp_tools(ri, parse_run_options(ri.options), _ctx(), draft)
    return draft


@pytest.mark.asyncio
async def test_contributor_builds_the_cached_tools_and_gates_approval_servers(
    allow_private: None,
) -> None:
    draft = await _contribute(
        _run_input(
            [
                _server("a", "http://127.0.0.1:9/mcp", "echo", "whoami", approval=True),
                _server("b", "http://127.0.0.1:9/mcp", "echo"),
                _server("c", "http://127.0.0.1:9/mcp"),  # no tools: skipped
            ]
        )
    )
    assert sorted(draft.tools) == ["mcp__a__echo", "mcp__a__whoami", "mcp__b__echo"]
    assert draft.gated == {"mcp__a__echo", "mcp__a__whoami"}
    echo = draft.tools["mcp__b__echo"]
    assert echo.description == "echo tool"
    assert echo.input_schema["properties"] == {"text": {"type": "string"}}
    assert echo.side_effecting is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("allowed", "expected"),
    [(None, ["mcp__a__echo", "mcp__b__echo"]), ([], []), (["b"], ["mcp__b__echo"])],
)
async def test_contributor_honours_allowed_mcp_server_ids(
    allow_private: None, allowed: list[str] | None, expected: list[str]
) -> None:
    fp = {} if allowed is None else {"allowedMcpServerIds": allowed}
    draft = await _contribute(
        _run_input(
            [
                _server("a", "http://127.0.0.1:9/mcp", "echo"),
                _server("b", "http://127.0.0.1:9/mcp", "echo"),
            ],
            **fp,
        )
    )
    assert sorted(draft.tools) == expected


@pytest.mark.asyncio
async def test_contributor_drops_a_server_whose_url_is_blocked() -> None:
    """Without `MCP_ALLOW_PRIVATE_HOSTS` a localhost server is dropped, as
    Next's `dropBlockedUrls`; a metadata URL is dropped regardless."""
    with structlog.testing.capture_logs() as logs:
        draft = await _contribute(
            _run_input(
                [
                    _server("a", "http://127.0.0.1:9/mcp", "echo"),
                    _server("m", "http://169.254.169.254/", "echo"),
                ]
            )
        )
    assert draft.tools == {}
    assert {
        entry["server_id"] for entry in logs if entry["event"] == "local_mcp.server_url_blocked"
    } == {"a", "m"}


# --- calls against a real MCP server ---------------------------------------------------------


@pytest.mark.asyncio
async def test_local_tools_call_the_server_with_the_credentials(
    allow_private: None, fake_server: Any
) -> None:
    draft = await _contribute(
        _run_input(
            [
                _server("a", fake_server.url, "echo", "whoami", "fail"),
                _server("b", fake_server.url, "echo"),
            ],
            {"a": LocalMcpCredential(type="bearer", headers={"Authorization": BEARER})},
        )
    )
    # No discovery: building the tools sent nothing to the server.
    assert fake_server.headers == []

    out = await draft.tools["mcp__a__echo"].execute({"text": "hello"})
    assert out.text == "hello" and out.summary == "Server a · echo"
    assert BEARER in fake_server.authorizations()

    # A server that echoes the credential back: redacted from the result…
    who = await draft.tools["mcp__a__whoami"].execute({})
    assert TOKEN not in who.text and "[redacted]" in who.text
    # …and from an error result.
    with pytest.raises(ToolError) as excinfo:
        await draft.tools["mcp__a__fail"].execute({})
    assert TOKEN not in str(excinfo.value) and "denied for [redacted]" in str(excinfo.value)

    # A server without a credential still works, without the header.
    before = len(fake_server.headers)
    out_b = await draft.tools["mcp__b__echo"].execute({"text": "anon"})
    assert out_b.text == "anon"
    assert all(a is None for a in fake_server.authorizations()[before:])


@pytest.mark.asyncio
async def test_a_failed_call_logs_no_credential(caplog: pytest.LogCaptureFixture) -> None:
    """An SDK / transport error that quotes the header is logged redacted,
    and the model gets the generic text."""
    tool = build_mcp_tool(
        endpoint=McpEndpoint(id="a", name="A", url="https://mcp.example/mcp"),
        credentials={"headers": {"Authorization": BEARER, "X-Api-Key": "k-short"}},
        descriptor=McpToolDescriptor(name="t"),
    )
    boom = RuntimeError(f"401 for request with Authorization: {BEARER}")
    caplog.set_level(logging.DEBUG)
    with (
        structlog.testing.capture_logs() as logs,
        patch("agent_py.mcp_tools.mcp_call_tool", new=AsyncMock(side_effect=boom)),
        pytest.raises(ToolError) as excinfo,
    ):
        await tool.execute({})
    assert excinfo.value.__cause__ is None
    assert TOKEN not in str(excinfo.value)
    assert TOKEN not in repr(logs) and "[redacted]" in repr(logs)
    assert TOKEN not in caplog.text


def test_credential_redactor() -> None:
    redact = credential_redactor({"headers": {"Authorization": BEARER, "X-Short": "abc"}})
    assert redact(f"a {BEARER} b {TOKEN} c abc") == "a [redacted] b [redacted] c abc"
    assert credential_redactor(None)("anything") == "anything"


# --- MCP Apps -----------------------------------------------------------------------------------


def test_cached_capabilities_carry_the_ui_resource_uri() -> None:
    tools = _tools_from_capabilities(
        {"tools": [{"name": "p", "uiResourceUri": "ui://x/p"}, {"name": "q", "uiResourceUri": 3}]}
    )
    assert [(t.name, t.ui_resource_uri) for t in tools] == [("p", "ui://x/p"), ("q", None)]


@pytest.mark.asyncio
async def test_mcp_app_is_read_after_the_tool_ran(allow_private: None, fake_server: Any) -> None:
    servers = [
        {
            **_server("a", fake_server.url, "echo"),
            "capabilities": {
                "tools": [
                    {"name": "panel", "uiResourceUri": "ui://fake/panel"},
                    {"name": "huge_panel", "uiResourceUri": "ui://fake/huge"},
                    {"name": "broken_panel", "uiResourceUri": "ui://fake/broken"},
                    {"name": "echo"},
                ]
            },
        }
    ]
    draft = await _contribute(
        _run_input(servers, {"a": LocalMcpCredential(headers={"Authorization": BEARER})})
    )

    shown = await draft.tools["mcp__a__panel"].execute({})
    assert shown.text == "panel shown"
    assert shown.mcp_app is not None
    assert shown.mcp_app.server_id == "a"
    assert shown.mcp_app.html == PANEL_HTML
    assert shown.mcp_app.resource_uri == "ui://fake/panel"
    assert shown.mcp_app.truncated is False
    # The resource read carried the credential too.
    assert fake_server.authorizations().count(BEARER) >= 2

    assert len(HUGE_PANEL_HTML) > MCP_APP_MAX_BYTES
    huge = await draft.tools["mcp__a__huge_panel"].execute({})
    assert huge.mcp_app is not None
    assert huge.mcp_app.truncated is True
    assert huge.mcp_app.html == MCP_APP_TRUNCATED_HTML
    assert huge.mcp_app.resource_uri == "ui://fake/huge"

    with structlog.testing.capture_logs() as logs:
        broken = await draft.tools["mcp__a__broken_panel"].execute({})
    assert broken.text == "broken panel shown" and broken.mcp_app is None
    assert any(e["event"] == "mcp_tools.app_read_failed" for e in logs)

    plain = await draft.tools["mcp__a__echo"].execute({"text": "x"})
    assert plain.mcp_app is None


@pytest.mark.asyncio
async def test_mcp_app_on_a_cloud_tool_too() -> None:
    """`build_mcp_tool` is shared: a cloud server's cached `uiResourceUri`
    yields an App the same way (the read is mocked here)."""
    tool = build_mcp_tool(
        endpoint=McpEndpoint(id="cloud-1", name="C", url="https://mcp.example/mcp"),
        credentials={"headers": {"Authorization": BEARER}},
        descriptor=_tools_from_capabilities(
            {"tools": [{"name": "p", "uiResourceUri": "ui://c/p"}]}
        )[0],
    )
    with (
        patch(
            "agent_py.mcp_tools.mcp_call_tool", new=AsyncMock(return_value=McpToolResult(text="ok"))
        ),
        patch(
            "agent_py.mcp_tools.mcp_read_resource",
            new=AsyncMock(return_value=McpResourceContent(text=f"<p>{TOKEN}</p>")),
        ) as read,
    ):
        out = await tool.execute({})
    assert out.mcp_app is not None and out.mcp_app.server_id == "cloud-1"
    assert out.mcp_app.html == "<p>[redacted]</p>"
    assert read.await_args is not None and read.await_args.args[2] == "ui://c/p"


# --- end to end through /v1/runs -----------------------------------------------------------------


def _services(model: _Model) -> RunServices:
    settings = Settings(
        SUPABASE_JWT_SECRET=SECRET,
        RUNS_RATE_PER_MINUTE=1000,
        RUNS_ANONYMOUS_RATE_PER_MINUTE=1000,
        RUNS_ANONYMOUS_MAX_CONCURRENT=100,
    )
    harness = build_native_harness(settings, client=model, suggestions=False)  # type: ignore[arg-type]
    return build_run_services(settings, None, harness=harness)


def _leaks(obj: object) -> list[str]:
    from .test_run_credentials import _strings

    return [s for s in _strings(obj) if TOKEN in s]


def test_gated_local_tool_interrupts_then_runs_with_the_resumed_credentials(
    monkeypatch: pytest.MonkeyPatch, fake_server: Any, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("MCP_ALLOW_PRIVATE_HOSTS", "true")
    get_settings.cache_clear()
    model = _Model(
        _Call(tools=[call("c1", "mcp__srv-1__whoami")]),
        _Call(tools=[call("c2", "mcp__srv-2__panel")]),
        _Call([text("done")]),
    )
    services = _services(model)
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    servers = [
        _server("srv-1", fake_server.url, "whoami", approval=True),
        _server("srv-2", fake_server.url, "panel", ui="ui://fake/panel"),
    ]
    state = {
        LOCAL_MCP_STATE_KEY: {"srv-1": {"type": "bearer", "headers": {"Authorization": BEARER}}}
    }
    thread = str(uuid.uuid4())

    def body(**kw: Any) -> dict[str, Any]:
        return {
            "threadId": thread,
            "runId": str(uuid.uuid4()),
            "messages": [{"id": "m1", "role": "user", "content": "who am I?"}],
            "state": state,
            "forwardedProps": {"model": MODEL, "localMcpServers": servers, **kw.pop("fp", {})},
            **kw,
        }

    caplog.set_level(logging.DEBUG)
    with TestClient(app) as client, structlog.testing.capture_logs() as logs:
        first = body()
        r1 = client.post("/v1/runs", json=first)
        assert r1.status_code == 200, r1.text
        token = r1.headers["x-run-token"]
        run1 = client.get(f"/v1/runs/{first['runId']}", headers={"X-Run-Token": token})
        assert run1.json()["status"] == "interrupted"
        # Gated: nothing reached the server yet (no discovery either).
        assert fake_server.headers == []
        offered = {t["name"] for t in model.requests[0]["tools"]}
        assert {"mcp__srv-1__whoami", "mcp__srv-2__panel"} <= offered

        second = body(
            fp={"previousRunId": first["runId"]},
            resume=[{"interruptId": "c1", "status": "resolved", "payload": {"approved": True}}],
        )
        r2 = client.post("/v1/runs", json=second, headers={"X-Run-Token": token})
        assert r2.status_code == 200, r2.text
        run2 = client.get(f"/v1/runs/{second['runId']}", headers={"X-Run-Token": token})
        assert run2.json()["status"] == "succeeded", run2.text

    # The approved call ran on the resume with the re-sent credential; the
    # srv-2 calls (tool + its App) went without one.
    auths = fake_server.authorizations()
    assert BEARER in auths and None in auths
    # The tool output the model got back is redacted…
    assert "you sent: [redacted]" in repr(model.requests[1]["messages"])
    # …and the App reached the stream.
    assert "hummingbird.mcp_app" in r2.text and "Fake panel" in r2.text

    for r in (r1, r2, run1, run2):
        assert TOKEN not in r.text
    assert _leaks(model.requests) == []
    assert _leaks(services.memory_repo) == []
    assert _leaks(services.memory_log) == []
    assert _leaks(logs) == []
    # The fake server runs in this process: its own logs are not ours.
    ours = [rec for rec in caplog.records if not rec.name.startswith(("mcp.server", "uvicorn"))]
    assert all(TOKEN not in rec.getMessage() for rec in ours)


def test_background_start_with_local_mcp_servers_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Q42: `localMcpServers` on a background start → 400 before any row,
    with the Next task route's message."""
    import time

    import jwt

    from .test_run_credentials import _SignedInStore

    user = "00000000-0000-4000-8000-000000000777"
    thread = str(uuid.uuid4())
    store = _SignedInStore(conversations={user: {thread}})
    services = dataclasses.replace(
        _services(_Model()),
        pg_repo=store,  # type: ignore[arg-type]
    )
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    auth = jwt.encode(
        {"sub": user, "role": "authenticated", "aud": "authenticated", "exp": time.time() + 600},
        SECRET,
        algorithm="HS256",
    )
    body = {
        "threadId": thread,
        "runId": str(uuid.uuid4()),
        "messages": [{"id": "m1", "role": "user", "content": "go"}],
        "forwardedProps": {
            "mode": "background",
            "goal": "g",
            "localMcpServers": [_server("a", "https://mcp.example/mcp", "echo")],
        },
    }
    with TestClient(app) as client:
        r = client.post("/v1/runs", json=body, headers={"Authorization": f"Bearer {auth}"})
        assert r.status_code == 400
        assert r.json()["code"] == "invalid_request"
        assert "Local-mode MCP servers aren't supported in async task mode" in r.json()["message"]
        # An empty list (or no credentials) is no local MCP: accepted.
        ok = {
            **body,
            "runId": str(uuid.uuid4()),
            "forwardedProps": {"mode": "background", "goal": "g", "localMcpServers": []},
        }
        assert (
            client.post(
                "/v1/runs", json=ok, headers={"Authorization": f"Bearer {auth}"}
            ).status_code
            == 202
        )
    assert body["runId"] not in store._rows
