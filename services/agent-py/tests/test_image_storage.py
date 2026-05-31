"""Phase 3d-2 tests — Supabase Storage persistence for generated images.

Hermetic — `httpx.MockTransport` intercepts both the Minimax-download
GET and the Supabase Storage upload/sign POSTs. We cover:

  - `is_storage_configured()` reads both SUPABASE_URL + service key.
  - End-to-end happy path → signed URL composed from sign response.
  - Per-stage failures (download / upload / sign) → PersistError with
    the right code, falling back at the tool-integration layer.
  - Size cap rejects oversized images.
  - MIME → extension normalisation (`image/jpeg` → `.jpg`).
"""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest

from agent_py import settings as settings_module
from agent_py.image_storage import (
    MAX_BYTES_PER_IMAGE,
    PersistedImage,
    PersistError,
    is_storage_configured,
    persist_generated_image,
)


def _configure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.test")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    settings_module.get_settings.cache_clear()


def _mock(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


# --- is_storage_configured ----------------------------------------------


def test_is_storage_configured_requires_both(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    settings_module.get_settings.cache_clear()
    assert is_storage_configured() is False

    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.test")
    settings_module.get_settings.cache_clear()
    assert is_storage_configured() is False

    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "k")
    settings_module.get_settings.cache_clear()
    assert is_storage_configured() is True


# --- happy path ---------------------------------------------------------


@pytest.mark.asyncio
async def test_happy_path_returns_persisted_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        calls.append(f"{req.method} {url}")
        if req.method == "GET" and "minimax" in url:
            return httpx.Response(
                200,
                content=b"\x89PNG" + b"x" * 100,
                headers={"content-type": "image/png"},
            )
        if req.method == "POST" and "/storage/v1/object/user-files/" in url:
            # Upload — the SDK responds with `{Key: "user-files/..."}`.
            return httpx.Response(200, json={"Key": "user-files/uid/generated/img.png"})
        if req.method == "POST" and "/storage/v1/object/sign/user-files/" in url:
            return httpx.Response(
                200,
                json={"signedURL": "/object/sign/user-files/uid/generated/img.png?token=abc"},
            )
        return httpx.Response(404, json={"error": "unexpected"})

    async with _mock(handler) as client:
        out = await persist_generated_image(
            "https://minimax.test/raw.png",
            user_id="uid",
            image_id="img",
            client=client,
        )

    assert isinstance(out, PersistedImage)
    assert (
        out.url
        == "https://proj.supabase.test/storage/v1/object/sign/user-files/uid/generated/img.png?token=abc"
    )
    assert out.storage_path == "uid/generated/img.png"
    assert out.format == "png"
    assert any("/storage/v1/object/user-files/uid/generated/img.png" in c for c in calls)


@pytest.mark.asyncio
async def test_jpeg_mime_normalises_to_jpg(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    upload_url_seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if req.method == "GET":
            return httpx.Response(
                200,
                content=b"\xff\xd8" + b"y" * 50,
                headers={"content-type": "image/jpeg"},
            )
        if "/storage/v1/object/user-files/" in url and req.method == "POST":
            upload_url_seen.append(url)
            return httpx.Response(200, json={})
        if "/storage/v1/object/sign/" in url:
            return httpx.Response(200, json={"signedURL": "/object/sign/foo?token=t"})
        return httpx.Response(404)

    async with _mock(handler) as client:
        out = await persist_generated_image(
            "https://minimax.test/raw.jpg",
            user_id="u",
            image_id="img",
            client=client,
        )
    assert isinstance(out, PersistedImage)
    assert out.format == "jpg"
    assert any("/img.jpg" in u for u in upload_url_seen)


# --- failure paths ------------------------------------------------------


@pytest.mark.asyncio
async def test_no_config_returns_config_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    settings_module.get_settings.cache_clear()
    out = await persist_generated_image("https://minimax.test/x.png", user_id="u", image_id="i")
    assert isinstance(out, PersistError)
    assert out.code == "config"


@pytest.mark.asyncio
async def test_download_failure_returns_download_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "GET":
            return httpx.Response(503)
        return httpx.Response(200, json={})

    async with _mock(handler) as client:
        out = await persist_generated_image(
            "https://minimax.test/x.png", user_id="u", image_id="i", client=client
        )
    assert isinstance(out, PersistError) and out.code == "download"


@pytest.mark.asyncio
async def test_upload_failure_returns_upload_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if req.method == "GET":
            return httpx.Response(200, content=b"img", headers={"content-type": "image/png"})
        if "/storage/v1/object/user-files/" in url and req.method == "POST":
            return httpx.Response(500, text="storage broke")
        return httpx.Response(200, json={"signedURL": "/x"})

    async with _mock(handler) as client:
        out = await persist_generated_image(
            "https://minimax.test/x.png", user_id="u", image_id="i", client=client
        )
    assert isinstance(out, PersistError) and out.code == "upload"


@pytest.mark.asyncio
async def test_sign_failure_returns_sign_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if req.method == "GET":
            return httpx.Response(200, content=b"img", headers={"content-type": "image/png"})
        if "/storage/v1/object/user-files/" in url and req.method == "POST":
            return httpx.Response(200, json={})
        if "/storage/v1/object/sign/" in url:
            return httpx.Response(500, text="sign broke")
        return httpx.Response(404)

    async with _mock(handler) as client:
        out = await persist_generated_image(
            "https://minimax.test/x.png", user_id="u", image_id="i", client=client
        )
    assert isinstance(out, PersistError) and out.code == "sign"


@pytest.mark.asyncio
async def test_sign_response_missing_url_returns_sign_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if req.method == "GET":
            return httpx.Response(200, content=b"img", headers={"content-type": "image/png"})
        if "/storage/v1/object/user-files/" in url and req.method == "POST":
            return httpx.Response(200, json={})
        if "/storage/v1/object/sign/" in url:
            # Sign succeeded HTTP but body missing the URL — defensive.
            return httpx.Response(200, json={"key": "no-url-here"})
        return httpx.Response(404)

    async with _mock(handler) as client:
        out = await persist_generated_image(
            "https://minimax.test/x.png", user_id="u", image_id="i", client=client
        )
    assert isinstance(out, PersistError) and out.code == "sign"


@pytest.mark.asyncio
async def test_oversize_image_returns_too_large_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure(monkeypatch)
    huge = b"x" * (MAX_BYTES_PER_IMAGE + 1)

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "GET":
            return httpx.Response(200, content=huge, headers={"content-type": "image/png"})
        return httpx.Response(200, json={})

    async with _mock(handler) as client:
        out = await persist_generated_image(
            "https://minimax.test/x.png", user_id="u", image_id="i", client=client
        )
    assert isinstance(out, PersistError) and out.code == "too_large"


# --- auth header --------------------------------------------------------


@pytest.mark.asyncio
async def test_upload_uses_service_role_bearer(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    seen: dict[str, str] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if "/storage/v1/object/user-files/" in url and req.method == "POST":
            seen["auth"] = req.headers.get("authorization", "")
            seen["apikey"] = req.headers.get("apikey", "")
            seen["upsert"] = req.headers.get("x-upsert", "")
            return httpx.Response(200, json={})
        if req.method == "GET":
            return httpx.Response(200, content=b"img", headers={"content-type": "image/png"})
        if "/storage/v1/object/sign/" in url:
            return httpx.Response(200, json={"signedURL": "/x?token=t"})
        return httpx.Response(404)

    async with _mock(handler) as client:
        await persist_generated_image(
            "https://minimax.test/x.png", user_id="u", image_id="i", client=client
        )
    assert seen["auth"] == "Bearer service-key"
    assert seen["apikey"] == "service-key"
    assert seen["upsert"] == "true"
