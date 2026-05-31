"""Phase 3d-1 tests — `generateImage` tool.

The Minimax HTTP client is patched at the module boundary so we test
input validation, SSRF gates, per-turn cap, error-mapping, and result
formatting without hitting the network. The client itself is covered
in `test_minimax_image_client.py`.

Registry visibility:
  - `MINIMAX_CN_API_KEY` unset → `generateImage` is omitted.
  - `MINIMAX_CN_API_KEY` set → `generateImage` is included.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from agent_py import settings as settings_module
from agent_py.image_storage import PersistedImage, PersistError
from agent_py.tools import image_gen as image_gen_module
from agent_py.tools.image_gen import (
    DEFAULT_MAX_CALLS_PER_TURN,
    MAX_IMAGES_PER_CALL,
    build_image_gen_tool,
    is_image_gen_configured,
)
from agent_py.tools.minimax_image_client import (
    MinimaxImage,
    MinimaxImageError,
    MinimaxImageSuccess,
)
from agent_py.tools.registry import ToolContext, ToolError, default_tool_registry


def _set_key(monkeypatch: pytest.MonkeyPatch, key: str = "test-key") -> None:
    monkeypatch.setenv("MINIMAX_CN_API_KEY", key)
    settings_module.get_settings.cache_clear()


def _ok(urls: list[str]) -> MinimaxImageSuccess:
    return MinimaxImageSuccess(images=[MinimaxImage(url=u) for u in urls])


# --- descriptor + input validation ---------------------------------------


def test_descriptor_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch)
    tool = build_image_gen_tool()
    assert tool.name == "generateImage"
    assert tool.input_schema["required"] == ["prompt"]
    assert "aspectRatio" in tool.input_schema["properties"]
    assert "count" in tool.input_schema["properties"]
    assert "referenceImageUrl" in tool.input_schema["properties"]


def test_is_image_gen_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MINIMAX_CN_API_KEY", raising=False)
    settings_module.get_settings.cache_clear()
    assert is_image_gen_configured() is False
    _set_key(monkeypatch)
    assert is_image_gen_configured() is True


@pytest.mark.asyncio
async def test_missing_prompt_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch)
    tool = build_image_gen_tool()
    with pytest.raises(ToolError, match="prompt"):
        await tool.execute({})
    with pytest.raises(ToolError, match="prompt"):
        await tool.execute({"prompt": "  "})


@pytest.mark.asyncio
async def test_too_long_prompt_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch)
    tool = build_image_gen_tool()
    with pytest.raises(ToolError, match="exceeds"):
        await tool.execute({"prompt": "x" * 2001})


# --- happy path / mode detection -----------------------------------------


@pytest.mark.asyncio
async def test_happy_path_t2i(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch)
    tool = build_image_gen_tool()
    with patch.object(
        image_gen_module,
        "minimax_generate_image",
        new=AsyncMock(return_value=_ok(["https://m.test/a.png", "https://m.test/b.png"])),
    ) as call:
        out = await tool.execute({"prompt": "a cat", "count": 2, "aspectRatio": "16:9"})

    assert out.summary == "2 images (t2i)"
    assert "[1] https://m.test/a.png" in out.text
    assert "[2] https://m.test/b.png" in out.text
    # The mode/I2I plumbing — no `reference_image_url` since the model didn't pass one.
    kwargs = call.call_args.kwargs
    assert kwargs["aspect_ratio"] == "16:9"
    assert kwargs["count"] == 2
    assert kwargs["reference_image_url"] is None


@pytest.mark.asyncio
async def test_happy_path_i2i(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch)
    tool = build_image_gen_tool()
    with patch.object(
        image_gen_module,
        "minimax_generate_image",
        new=AsyncMock(return_value=_ok(["https://m.test/i.png"])),
    ) as call:
        out = await tool.execute(
            {"prompt": "remix", "referenceImageUrl": "https://cdn.test/ref.png"}
        )

    assert out.summary == "1 image (i2i)"
    assert "[1] https://m.test/i.png" in out.text
    assert call.call_args.kwargs["reference_image_url"] == "https://cdn.test/ref.png"


@pytest.mark.asyncio
async def test_aspect_ratio_falls_back_to_default(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch)
    tool = build_image_gen_tool()
    with patch.object(
        image_gen_module,
        "minimax_generate_image",
        new=AsyncMock(return_value=_ok(["https://m.test/x.png"])),
    ) as call:
        await tool.execute({"prompt": "x", "aspectRatio": "not-a-ratio"})
    assert call.call_args.kwargs["aspect_ratio"] == "1:1"


@pytest.mark.asyncio
async def test_count_clamped_to_max_per_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """Out-of-range count → fall back to 1 (model still gets one image
    rather than an error)."""
    _set_key(monkeypatch)
    tool = build_image_gen_tool()
    with patch.object(
        image_gen_module,
        "minimax_generate_image",
        new=AsyncMock(return_value=_ok(["u"])),
    ) as call:
        await tool.execute({"prompt": "x", "count": MAX_IMAGES_PER_CALL + 5})
    assert call.call_args.kwargs["count"] == 1


# --- SSRF gate ----------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/img.png",  # http://, not https://
        "https://localhost/img.png",  # exact-blocked host
        "https://api.internal/img.png",  # suffix-blocked
        "https://foo.local/img.png",
        "https://metadata.google.internal/img",
        "ftp://example.com/img.png",
    ],
)
async def test_reference_url_ssrf_rejected(monkeypatch: pytest.MonkeyPatch, url: str) -> None:
    _set_key(monkeypatch)
    tool = build_image_gen_tool()
    with pytest.raises(ToolError, match="referenceImageUrl"):
        await tool.execute({"prompt": "x", "referenceImageUrl": url})


@pytest.mark.asyncio
async def test_reference_url_too_long_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_key(monkeypatch)
    tool = build_image_gen_tool()
    huge = "https://example.com/" + ("a" * 3000)
    with pytest.raises(ToolError, match="too long"):
        await tool.execute({"prompt": "x", "referenceImageUrl": huge})


# --- per-turn cap -------------------------------------------------------


@pytest.mark.asyncio
async def test_per_turn_cap_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    """Closure-held counter — each tool instance enforces a cap across
    its lifetime. After `cap` successful calls the next raises."""
    _set_key(monkeypatch)
    tool = build_image_gen_tool(max_calls_per_turn=2)
    with patch.object(
        image_gen_module,
        "minimax_generate_image",
        new=AsyncMock(return_value=_ok(["u"])),
    ):
        await tool.execute({"prompt": "a"})
        await tool.execute({"prompt": "b"})
        with pytest.raises(ToolError, match="budget exhausted"):
            await tool.execute({"prompt": "c"})


@pytest.mark.asyncio
async def test_separate_builds_have_independent_counters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_key(monkeypatch)
    with patch.object(
        image_gen_module,
        "minimax_generate_image",
        new=AsyncMock(return_value=_ok(["u"])),
    ):
        a = build_image_gen_tool(max_calls_per_turn=1)
        b = build_image_gen_tool(max_calls_per_turn=1)
        await a.execute({"prompt": "x"})
        # `b` is a fresh build — its counter is empty.
        await b.execute({"prompt": "y"})


# --- upstream errors mapped to ToolError --------------------------------


@pytest.mark.asyncio
async def test_upstream_error_surfaces_code_in_tool_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_key(monkeypatch)
    tool = build_image_gen_tool()
    with (
        patch.object(
            image_gen_module,
            "minimax_generate_image",
            new=AsyncMock(return_value=MinimaxImageError(code="content_policy", message="blocked")),
        ),
        pytest.raises(ToolError, match=r"\[content_policy\].*blocked"),
    ):
        await tool.execute({"prompt": "x"})


# --- defaults ----------------------------------------------------------


def test_default_max_calls_per_turn_is_reasonable() -> None:
    assert 1 <= DEFAULT_MAX_CALLS_PER_TURN <= 5


# --- registry visibility ------------------------------------------------


def test_registry_omits_image_gen_without_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MINIMAX_CN_API_KEY", raising=False)
    settings_module.get_settings.cache_clear()
    reg = default_tool_registry()
    assert "webFetch" in reg
    assert "generateImage" not in reg


def test_registry_includes_image_gen_with_key(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key(monkeypatch)
    reg = default_tool_registry()
    assert "generateImage" in reg
    assert reg["generateImage"].name == "generateImage"


def test_settings_passes_through_minimax_envs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MINIMAX_CN_API_KEY", "k")
    monkeypatch.setenv("MINIMAX_CN_BASE_URL", "https://api.example.com/anthropic/v1")
    settings_module.get_settings.cache_clear()
    s = settings_module.get_settings()
    assert s.MINIMAX_CN_API_KEY == "k"
    assert s.MINIMAX_CN_BASE_URL == "https://api.example.com/anthropic/v1"


# --- minimax client receives the right key + base_url -------------------


@pytest.mark.asyncio
async def test_tool_passes_settings_to_minimax_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sanity check that the env-var wiring through `get_settings()`
    reaches the underlying client (so a deploy that sets
    `MINIMAX_CN_BASE_URL` actually hits the override host)."""
    monkeypatch.setenv("MINIMAX_CN_API_KEY", "k-from-env")
    monkeypatch.setenv("MINIMAX_CN_BASE_URL", "https://api.example.com/anthropic/v1")
    settings_module.get_settings.cache_clear()
    tool = build_image_gen_tool()
    captured: dict[str, Any] = {}

    async def fake(**kwargs: Any) -> MinimaxImageSuccess:
        captured.update(kwargs)
        return _ok(["u"])

    with patch.object(image_gen_module, "minimax_generate_image", new=fake):
        await tool.execute({"prompt": "x"})

    assert captured["api_key"] == "k-from-env"
    assert captured["base_url_override"] == "https://api.example.com/anthropic/v1"


# --- Phase 3d-2: Storage persistence wiring ----------------------------


def _ctx() -> ToolContext:
    # `pool` is unused on this tool path — the persistence layer talks
    # to Supabase Storage's REST API, not asyncpg.
    from unittest.mock import MagicMock

    return ToolContext(pool=MagicMock(), user_id="user-1")


@pytest.mark.asyncio
async def test_persists_when_context_and_storage_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With ToolContext + storage env, each Minimax URL is replaced
    by a signed Storage URL in the model-facing text."""
    _set_key(monkeypatch)
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.test")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "k")
    settings_module.get_settings.cache_clear()

    tool = build_image_gen_tool(context=_ctx())

    async def fake_persist(url: str, **kwargs: Any) -> PersistedImage:
        # Echo a deterministic signed URL so the assertion is stable.
        return PersistedImage(
            url=f"https://signed.test/{kwargs['image_id']}",
            storage_path=f"{kwargs['user_id']}/generated/{kwargs['image_id']}.png",
            format="png",
        )

    with (
        patch.object(
            image_gen_module,
            "minimax_generate_image",
            new=AsyncMock(return_value=_ok(["https://m.test/a.png", "https://m.test/b.png"])),
        ),
        patch.object(image_gen_module, "persist_generated_image", new=fake_persist),
    ):
        out = await tool.execute({"prompt": "x", "count": 2})

    assert "https://signed.test/" in out.text
    assert "https://m.test/a.png" not in out.text


@pytest.mark.asyncio
async def test_passthrough_when_no_context(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without ToolContext, Minimax URLs surface inline (Phase 3d-1
    behaviour)."""
    _set_key(monkeypatch)
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.test")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "k")
    settings_module.get_settings.cache_clear()
    tool = build_image_gen_tool()  # no context

    persist_called = AsyncMock()
    with (
        patch.object(
            image_gen_module,
            "minimax_generate_image",
            new=AsyncMock(return_value=_ok(["https://m.test/x.png"])),
        ),
        patch.object(image_gen_module, "persist_generated_image", new=persist_called),
    ):
        out = await tool.execute({"prompt": "x"})

    assert "https://m.test/x.png" in out.text
    persist_called.assert_not_awaited()


@pytest.mark.asyncio
async def test_passthrough_when_storage_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Context present but Storage env vars missing → still
    passthrough (no failure for a deploy without service-role key)."""
    _set_key(monkeypatch)
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    settings_module.get_settings.cache_clear()
    tool = build_image_gen_tool(context=_ctx())

    persist_called = AsyncMock()
    with (
        patch.object(
            image_gen_module,
            "minimax_generate_image",
            new=AsyncMock(return_value=_ok(["https://m.test/x.png"])),
        ),
        patch.object(image_gen_module, "persist_generated_image", new=persist_called),
    ):
        out = await tool.execute({"prompt": "x"})

    assert "https://m.test/x.png" in out.text
    persist_called.assert_not_awaited()


@pytest.mark.asyncio
async def test_persist_failure_falls_back_to_minimax_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Per-image persistence failure → that image keeps the raw
    Minimax URL; tool still succeeds. Mirrors the TS path's drop-bad-
    keep-rest policy but at per-image granularity."""
    _set_key(monkeypatch)
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.test")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "k")
    settings_module.get_settings.cache_clear()
    tool = build_image_gen_tool(context=_ctx())

    call = {"n": 0}

    async def flaky_persist(url: str, **kwargs: Any) -> PersistedImage | PersistError:
        call["n"] += 1
        if call["n"] == 1:
            return PersistError(code="upload", message="500")
        return PersistedImage(
            url="https://signed.test/ok", storage_path="u/g/img.png", format="png"
        )

    with (
        patch.object(
            image_gen_module,
            "minimax_generate_image",
            new=AsyncMock(return_value=_ok(["https://m.test/a.png", "https://m.test/b.png"])),
        ),
        patch.object(image_gen_module, "persist_generated_image", new=flaky_persist),
    ):
        out = await tool.execute({"prompt": "x", "count": 2})

    # First image: raw Minimax URL (persist failed). Second: signed URL.
    assert "https://m.test/a.png" in out.text
    assert "https://signed.test/ok" in out.text
