"""Tests for the `webSearch` tool (Tavily backend).

Hermetic — `httpx.MockTransport` intercepts the POST. We cover:
  - input validation (missing / empty query),
  - happy-path Tavily response → normalised text + source_results,
  - empty results → "no results" message + empty source_results,
  - HTTP error → ToolError surfaces (no key leak),
  - registry visibility gated on TAVILY_API_KEY,
  - is_web_search_configured probe.
"""

from __future__ import annotations

import httpx
import pytest

from agent_py.settings import get_settings
from agent_py.tools.registry import ToolError, default_tool_registry
from agent_py.tools.web_search import (
    _execute_with_client,
    build_web_search_tool,
    is_web_search_configured,
)


def _mock_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_descriptor_shape() -> None:
    tool = build_web_search_tool()
    assert tool.name == "webSearch"
    assert "query" in tool.input_schema["properties"]
    assert tool.input_schema["required"] == ["query"]


@pytest.mark.asyncio
async def test_missing_query_raises() -> None:
    async with _mock_client(lambda req: httpx.Response(200, json={})) as client:
        with pytest.raises(ToolError):
            await _execute_with_client({}, client=client, api_key="k")
        with pytest.raises(ToolError):
            await _execute_with_client({"query": "  "}, client=client, api_key="k")


@pytest.mark.asyncio
async def test_happy_path_returns_normalised_results() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "Anthropic Claude",
                        "url": "https://docs.anthropic.com/x",
                        "content": "Claude is a chat assistant…",
                    },
                    {
                        "title": "Wikipedia: Claude",
                        "url": "https://en.wikipedia.org/wiki/Claude",
                        "content": "Common given name in French …",
                    },
                ]
            },
        )

    async with _mock_client(handler) as client:
        out = await _execute_with_client({"query": "What is Claude?"}, client=client, api_key="k")

    assert out.summary == "2 results"
    assert out.source_results is not None
    assert len(out.source_results) == 2
    assert out.source_results[0].url == "https://docs.anthropic.com/x"
    assert out.source_results[0].title == "Anthropic Claude"
    # The model-facing text carries [N] citation hooks.
    assert "[1] Anthropic Claude" in out.text
    assert "[2] Wikipedia: Claude" in out.text


@pytest.mark.asyncio
async def test_no_results_returns_zero_message() -> None:
    async with _mock_client(lambda req: httpx.Response(200, json={"results": []})) as client:
        out = await _execute_with_client({"query": "asdjkfhajskdfh"}, client=client, api_key="k")
    assert out.summary == "0 results"
    assert out.source_results == []


@pytest.mark.asyncio
async def test_drops_results_without_url() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "results": [
                    {"title": "no url", "content": "x"},
                    {"title": "good", "url": "https://ok.test", "content": "y"},
                ]
            },
        )

    async with _mock_client(handler) as client:
        out = await _execute_with_client({"query": "q"}, client=client, api_key="k")
    assert len(out.source_results or []) == 1
    assert out.source_results[0].url == "https://ok.test"


@pytest.mark.asyncio
async def test_http_error_surfaces_as_tool_error_no_key_leak() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        # Tavily 401: don't leak the body (could echo the key on some
        # upstream formats). The error message MUST NOT contain the key.
        return httpx.Response(401, json={"detail": "Bad key: SECRET-KEY-VAL"})

    async with _mock_client(handler) as client:
        with pytest.raises(ToolError) as info:
            await _execute_with_client({"query": "q"}, client=client, api_key="SECRET-KEY-VAL")
    assert "SECRET-KEY-VAL" not in str(info.value)
    assert "401" in str(info.value)


@pytest.mark.asyncio
async def test_long_snippet_truncated() -> None:
    long = "x" * 2_000

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"results": [{"title": "t", "url": "https://x.test", "content": long}]},
        )

    async with _mock_client(handler) as client:
        out = await _execute_with_client({"query": "q"}, client=client, api_key="k")
    assert out.source_results is not None
    # MAX_SNIPPET_CHARS + ellipsis.
    assert out.source_results[0].snippet.endswith("…")
    assert len(out.source_results[0].snippet) <= 801


def test_registry_omits_websearch_when_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TAVILY_API_KEY", "")
    get_settings.cache_clear()
    reg = default_tool_registry()
    assert "webFetch" in reg  # webFetch is unconditional.
    assert "webSearch" not in reg
    assert is_web_search_configured() is False


def test_registry_includes_websearch_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TAVILY_API_KEY", "sk-tavily-test")
    get_settings.cache_clear()
    reg = default_tool_registry()
    assert "webSearch" in reg
    assert reg["webSearch"].name == "webSearch"
    assert is_web_search_configured() is True


@pytest.fixture(autouse=True)
def _reset_settings_cache() -> None:
    """Each test in this file flips the env; reset before AND after so
    sibling tests start clean."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
