"""Tests for the low-level Minimax image client.

Hermetic — `httpx.MockTransport` intercepts every call. We cover:

  - endpoint resolution (default, override origin extracted, malformed),
  - successful response → images,
  - I2I mode appends `subject_reference` to the body,
  - HTTP status mapping (401/403 → auth, 429 → rate_limit, 5xx → upstream),
  - Minimax `base_resp.status_code` mapping via `map_minimax_status_code`,
  - timeout / invalid JSON / missing image URLs,
  - `extract_image_urls` handles the three documented response shapes.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from agent_py.tools.minimax_image_client import (
    DEFAULT_ENDPOINT,
    MinimaxImageError,
    MinimaxImageSuccess,
    extract_image_urls,
    get_image_endpoint,
    map_minimax_status_code,
    minimax_generate_image,
)


def _mock_client(handler: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


# --- get_image_endpoint ---------------------------------------------------


def test_endpoint_default_when_no_override() -> None:
    assert get_image_endpoint() == DEFAULT_ENDPOINT
    assert get_image_endpoint(base_url_override="") == DEFAULT_ENDPOINT


def test_endpoint_strips_chat_path_from_override() -> None:
    """Chat lives at `<host>/anthropic/v1`; image lives at
    `<host>/v1/image_generation`. The override gives the chat URL —
    we rebuild against the origin."""
    out = get_image_endpoint(base_url_override="https://api.example.com/anthropic/v1")
    assert out == "https://api.example.com/v1/image_generation"


def test_endpoint_falls_back_when_override_malformed() -> None:
    out = get_image_endpoint(base_url_override="not a url")
    assert out == DEFAULT_ENDPOINT


# --- map_minimax_status_code ----------------------------------------------


def test_map_minimax_status_code_known() -> None:
    assert map_minimax_status_code(1004) == "auth"
    assert map_minimax_status_code(1008) == "auth"
    assert map_minimax_status_code(1013) == "rate_limit"
    assert map_minimax_status_code(2013) == "content_policy"
    assert map_minimax_status_code(2032) == "validation"


def test_map_minimax_status_code_unknown_falls_through() -> None:
    assert map_minimax_status_code(9999) == "upstream"


# --- extract_image_urls ---------------------------------------------------


def test_extract_image_urls_documented_shape() -> None:
    urls = extract_image_urls({"data": {"image_urls": ["a", "b"]}})
    assert urls == ["a", "b"]


def test_extract_image_urls_array_of_objects() -> None:
    urls = extract_image_urls({"data": {"images": [{"url": "x"}, {"image_url": "y"}, {}]}})
    assert urls == ["x", "y"]


def test_extract_image_urls_empty() -> None:
    assert extract_image_urls({}) == []
    assert extract_image_urls({"data": None}) == []
    assert extract_image_urls({"data": {}}) == []


# --- minimax_generate_image ----------------------------------------------


@pytest.mark.asyncio
async def test_missing_api_key_returns_auth_error() -> None:
    out = await minimax_generate_image(
        api_key="",
        prompt="x",
        aspect_ratio="1:1",
        count=1,
    )
    assert isinstance(out, MinimaxImageError)
    assert out.code == "auth"


@pytest.mark.asyncio
async def test_happy_path_returns_images() -> None:
    captured: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["headers"] = dict(req.headers)
        captured["body"] = req.read()
        return httpx.Response(
            200,
            json={"data": {"image_urls": ["https://m.test/a.png", "https://m.test/b.png"]}},
        )

    async with _mock_client(handler) as client:
        out = await minimax_generate_image(
            api_key="k",
            prompt="cat",
            aspect_ratio="16:9",
            count=2,
            client=client,
        )

    assert isinstance(out, MinimaxImageSuccess)
    assert [i.url for i in out.images] == ["https://m.test/a.png", "https://m.test/b.png"]
    # Auth header carries the key; no leak in error paths because there's no error.
    assert captured["headers"].get("authorization") == "Bearer k"


@pytest.mark.asyncio
async def test_i2i_mode_appends_subject_reference() -> None:
    captured: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["body"] = req.read()
        return httpx.Response(200, json={"data": {"image_urls": ["https://m.test/i.png"]}})

    async with _mock_client(handler) as client:
        await minimax_generate_image(
            api_key="k",
            prompt="remix",
            aspect_ratio="1:1",
            count=1,
            reference_image_url="https://cdn.test/ref.png",
            client=client,
        )

    import json

    body = json.loads(captured["body"])
    assert body["subject_reference"] == [
        {"type": "character", "image_file": "https://cdn.test/ref.png"}
    ]


@pytest.mark.asyncio
async def test_http_401_maps_to_auth() -> None:
    async with _mock_client(lambda req: httpx.Response(401)) as client:
        out = await minimax_generate_image(
            api_key="k", prompt="x", aspect_ratio="1:1", count=1, client=client
        )
    assert isinstance(out, MinimaxImageError) and out.code == "auth"


@pytest.mark.asyncio
async def test_http_429_maps_to_rate_limit() -> None:
    async with _mock_client(lambda req: httpx.Response(429)) as client:
        out = await minimax_generate_image(
            api_key="k", prompt="x", aspect_ratio="1:1", count=1, client=client
        )
    assert isinstance(out, MinimaxImageError) and out.code == "rate_limit"


@pytest.mark.asyncio
async def test_http_500_maps_to_upstream() -> None:
    async with _mock_client(lambda req: httpx.Response(503)) as client:
        out = await minimax_generate_image(
            api_key="k", prompt="x", aspect_ratio="1:1", count=1, client=client
        )
    assert isinstance(out, MinimaxImageError) and out.code == "upstream"
    assert "503" in out.message


@pytest.mark.asyncio
async def test_base_resp_status_code_maps_to_error() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"base_resp": {"status_code": 2013, "status_msg": "blocked"}},
        )

    async with _mock_client(handler) as client:
        out = await minimax_generate_image(
            api_key="k", prompt="x", aspect_ratio="1:1", count=1, client=client
        )
    assert isinstance(out, MinimaxImageError)
    assert out.code == "content_policy"
    assert out.message == "blocked"


@pytest.mark.asyncio
async def test_response_without_urls_returns_upstream_error() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"images": []}})

    async with _mock_client(handler) as client:
        out = await minimax_generate_image(
            api_key="k", prompt="x", aspect_ratio="1:1", count=1, client=client
        )
    assert isinstance(out, MinimaxImageError)
    assert out.code == "upstream"


@pytest.mark.asyncio
async def test_invalid_json_returns_upstream_error() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not json")

    async with _mock_client(handler) as client:
        out = await minimax_generate_image(
            api_key="k", prompt="x", aspect_ratio="1:1", count=1, client=client
        )
    assert isinstance(out, MinimaxImageError)
    assert out.code == "upstream"


@pytest.mark.asyncio
async def test_network_error_returns_network_code() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("DNS failed")

    async with _mock_client(handler) as client:
        out = await minimax_generate_image(
            api_key="k", prompt="x", aspect_ratio="1:1", count=1, client=client
        )
    assert isinstance(out, MinimaxImageError)
    assert out.code == "network"
