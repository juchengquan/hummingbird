"""Phase 3f tests — `mcp_client` wrapper.

Hermetic — we patch `_open_session` to yield a fake ClientSession so
no actual streamable-HTTP connection is opened. The fake session
returns whatever the test seeded, mirroring what the MCP SDK would
return on a real server. We cover:

  - `discover` — gates listTools/listResources/listPrompts on
    capability advertising; prompts errors are swallowed.
  - `call_tool` — flattens text + embedded-resource content;
    is_error pass-through.
  - `read_resource` — returns first content's text + mime_type.
  - `_headers_from` — only string→string entries forwarded.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import patch

import pytest

from agent_py import mcp_client
from agent_py.mcp_client import (
    McpEndpoint,
    _headers_from,
    call_tool,
    discover,
    read_resource,
)

# --- fakes --------------------------------------------------------------


class _FakeTool:
    def __init__(self, name: str, description: str | None = None, input_schema: Any = None):
        self.name = name
        self.description = description
        self.inputSchema = input_schema


class _FakeResource:
    def __init__(
        self,
        uri: str,
        name: str = "r",
        description: str | None = None,
        mime_type: str | None = None,
    ):
        self.uri = uri
        self.name = name
        self.description = description
        self.mimeType = mime_type


class _FakePrompt:
    def __init__(self, name: str, description: str | None = None):
        self.name = name
        self.description = description


class _FakeListResult:
    def __init__(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            setattr(self, k, v)


class _FakeContentPart:
    def __init__(self, type: str, text: str | None = None, resource: Any = None):
        self.type = type
        self.text = text
        self.resource = resource


class _FakeToolResult:
    def __init__(self, content: list[Any], is_error: bool = False) -> None:
        self.content = content
        self.isError = is_error


class _FakeResourceItem:
    def __init__(self, text: str | None = None, mime_type: str | None = None) -> None:
        self.text = text
        self.mimeType = mime_type


class _FakeReadResult:
    def __init__(self, contents: list[Any]) -> None:
        self.contents = contents


class _FakeSession:
    """A stand-in for `mcp.ClientSession`. Each list_* method returns
    a pre-seeded result; `get_server_capabilities` returns the
    capability dict the test seeded."""

    def __init__(
        self,
        *,
        capabilities: dict[str, Any] | None = None,
        tools: list[Any] | None = None,
        resources: list[Any] | None = None,
        prompts: list[Any] | None = None,
        prompts_raises: Exception | None = None,
        call_tool_result: Any = None,
        read_resource_result: Any = None,
    ) -> None:
        self._capabilities = capabilities or {}
        self._tools = tools or []
        self._resources = resources or []
        self._prompts = prompts or []
        self._prompts_raises = prompts_raises
        self._call_tool_result = call_tool_result
        self._read_resource_result = read_resource_result

    def get_server_capabilities(self) -> dict[str, Any]:
        return self._capabilities

    async def list_tools(self) -> Any:
        return _FakeListResult(tools=self._tools)

    async def list_resources(self) -> Any:
        return _FakeListResult(resources=self._resources)

    async def list_prompts(self) -> Any:
        if self._prompts_raises is not None:
            raise self._prompts_raises
        return _FakeListResult(prompts=self._prompts)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        return self._call_tool_result

    async def read_resource(self, uri: str) -> Any:
        return self._read_resource_result


def _patch_session(session: _FakeSession):
    """Patch `mcp_client._open_session` so it yields the fake."""

    @asynccontextmanager
    async def fake_open(*args: Any, **kwargs: Any) -> AsyncIterator[_FakeSession]:
        yield session

    return patch.object(mcp_client, "_open_session", new=fake_open)


_ENDPOINT = McpEndpoint(id="srv-1", name="test", url="https://mcp.test/sse")


# --- _headers_from ------------------------------------------------------


def test_headers_from_none_credentials() -> None:
    assert _headers_from(None) is None


def test_headers_from_no_headers_key() -> None:
    assert _headers_from({"other": "x"}) is None


def test_headers_from_filters_non_string_values() -> None:
    out = _headers_from({"headers": {"A": "x", "B": 123, "C": None, "D": "y"}})
    assert out == {"A": "x", "D": "y"}


def test_headers_from_empty_returns_none() -> None:
    """Empty header dict shouldn't become `headers={}` to the MCP
    SDK — pass None so the SDK's default applies."""
    assert _headers_from({"headers": {}}) is None


# --- discover -----------------------------------------------------------


@pytest.mark.asyncio
async def test_discover_returns_all_advertised_capabilities() -> None:
    session = _FakeSession(
        capabilities={"tools": {}, "resources": {}, "prompts": {}},
        tools=[_FakeTool("greet", "say hi", {"type": "object"})],
        resources=[_FakeResource("file:///a", "A", "the A", "text/plain")],
        prompts=[_FakePrompt("brainstorm", "kickstart ideas")],
    )
    with _patch_session(session):
        caps = await discover(_ENDPOINT, credentials=None)

    assert caps.tools is not None and len(caps.tools) == 1
    assert caps.tools[0].name == "greet"
    assert caps.tools[0].description == "say hi"
    assert caps.tools[0].input_schema == {"type": "object"}

    assert caps.resources is not None and caps.resources[0].uri == "file:///a"
    assert caps.resources[0].mime_type == "text/plain"

    assert caps.prompts is not None and caps.prompts[0].name == "brainstorm"


@pytest.mark.asyncio
async def test_discover_skips_unadvertised_capabilities() -> None:
    """Server only advertised tools — resources + prompts stay None
    in the result, not empty lists."""
    session = _FakeSession(
        capabilities={"tools": {}},
        tools=[_FakeTool("t")],
    )
    with _patch_session(session):
        caps = await discover(_ENDPOINT, credentials=None)
    assert caps.tools is not None
    assert caps.resources is None
    assert caps.prompts is None


@pytest.mark.asyncio
async def test_discover_swallows_list_prompts_errors() -> None:
    """Servers can advertise prompts capability but error on the
    actual list call. Mirrors the TS path's try/catch."""
    session = _FakeSession(
        capabilities={"prompts": {}},
        prompts_raises=RuntimeError("prompts not implemented"),
    )
    with _patch_session(session):
        caps = await discover(_ENDPOINT, credentials=None)
    assert caps.prompts is None


@pytest.mark.asyncio
async def test_discover_handles_pydantic_capabilities() -> None:
    """SDK capability objects often come back as pydantic models —
    the helper coerces via `model_dump`."""

    class _PydanticLike:
        def model_dump(self, **_: Any) -> dict[str, Any]:
            return {"tools": {}}

    session = _FakeSession(
        capabilities={},  # overridden by get_server_capabilities below
        tools=[_FakeTool("t")],
    )
    session.get_server_capabilities = lambda: _PydanticLike()  # type: ignore[method-assign]
    with _patch_session(session):
        caps = await discover(_ENDPOINT, credentials=None)
    assert caps.tools is not None and caps.tools[0].name == "t"


# --- call_tool ----------------------------------------------------------


@pytest.mark.asyncio
async def test_call_tool_flattens_text_content() -> None:
    session = _FakeSession(
        call_tool_result=_FakeToolResult(
            content=[
                _FakeContentPart(type="text", text="first"),
                _FakeContentPart(type="text", text="second"),
            ]
        ),
    )
    with _patch_session(session):
        out = await call_tool(_ENDPOINT, None, "any", {"x": 1})
    assert out.text == "first\n\nsecond"
    assert out.is_error is False


@pytest.mark.asyncio
async def test_call_tool_concatenates_resource_text() -> None:
    """Some MCP tools return embedded resources alongside text parts.
    We pull text out of both."""
    session = _FakeSession(
        call_tool_result=_FakeToolResult(
            content=[
                _FakeContentPart(type="text", text="hello"),
                _FakeContentPart(
                    type="resource",
                    resource=_FakeResourceItem(text="from-resource"),
                ),
            ]
        ),
    )
    with _patch_session(session):
        out = await call_tool(_ENDPOINT, None, "any", None)
    assert "hello" in out.text
    assert "from-resource" in out.text


@pytest.mark.asyncio
async def test_call_tool_is_error_propagates() -> None:
    session = _FakeSession(
        call_tool_result=_FakeToolResult(
            content=[_FakeContentPart(type="text", text="upstream failed")],
            is_error=True,
        ),
    )
    with _patch_session(session):
        out = await call_tool(_ENDPOINT, None, "any", None)
    assert out.is_error is True
    assert "upstream failed" in out.text


@pytest.mark.asyncio
async def test_call_tool_ignores_unknown_content_types() -> None:
    """An image or unknown part shouldn't crash the flattener — it
    just gets dropped from the text result."""
    session = _FakeSession(
        call_tool_result=_FakeToolResult(
            content=[
                _FakeContentPart(type="image", text=None),
                _FakeContentPart(type="text", text="kept"),
            ]
        ),
    )
    with _patch_session(session):
        out = await call_tool(_ENDPOINT, None, "any", None)
    assert out.text == "kept"


# --- read_resource ------------------------------------------------------


@pytest.mark.asyncio
async def test_read_resource_returns_first_content() -> None:
    session = _FakeSession(
        read_resource_result=_FakeReadResult(
            contents=[_FakeResourceItem(text="hello", mime_type="text/plain")]
        ),
    )
    with _patch_session(session):
        out = await read_resource(_ENDPOINT, None, "file:///a")
    assert out.text == "hello"
    assert out.mime_type == "text/plain"


@pytest.mark.asyncio
async def test_read_resource_empty_contents() -> None:
    session = _FakeSession(read_resource_result=_FakeReadResult(contents=[]))
    with _patch_session(session):
        out = await read_resource(_ENDPOINT, None, "file:///empty")
    assert out.text is None
    assert out.mime_type is None
