"""Tests for the lazy Anthropic-client resolver.

Covers the env-driven branching in `executor._resolve_anthropic_client`:
when no key is set the resolver returns None (executor falls back to
the stub); when a key is set the resolver instantiates `AsyncAnthropic`
with the api_key alone or, when `ANTHROPIC_BASE_URL` is also set, with
both `api_key` and `base_url` so the SDK targets the override host.

Doesn't import the real `anthropic` SDK in any of these — we patch
`agent_py.executor.AsyncAnthropic` so the test stays hermetic and
fast. (The Phase 2b-1 protocol means the executor only needs an
object exposing `messages.stream`, so a stand-in is enough.)
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_py import executor
from agent_py.settings import get_settings


def _reset_resolver_cache() -> None:
    """Clear both the resolver's module-level cache and the settings
    singleton so each test gets a fresh resolution. Tests run in one
    process; without these resets a later test would observe an
    earlier test's client."""
    executor._anthropic_client = None
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def reset_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """Reset before AND after each test so an unrelated test elsewhere
    can't leak settings into our resolver checks."""
    _reset_resolver_cache()
    yield
    _reset_resolver_cache()


def test_returns_none_when_api_key_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "")
    assert executor._resolve_anthropic_client() is None


def test_returns_none_even_when_base_url_set_but_key_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The base-URL override is only meaningful WITH a key — without a key
    # the executor uses the stub which never reaches a network. Verify
    # the resolver still bails so we don't half-construct a client.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://custom.example/anthropic/v1")
    assert executor._resolve_anthropic_client() is None


def test_constructs_client_with_api_key_only_when_base_url_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-123")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "")

    captured: dict[str, Any] = {}

    class _FakeAnthropic:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

    # The real import inside the resolver pulls the SDK; redirect it
    # to our stand-in. `monkeypatch.setattr` on a module attribute that
    # doesn't exist yet would fail, so we set the attribute first.
    import anthropic as anthropic_module  # type: ignore[import-not-found]

    monkeypatch.setattr(anthropic_module, "AsyncAnthropic", _FakeAnthropic)
    client = executor._resolve_anthropic_client()
    assert client is not None
    assert captured == {"api_key": "sk-test-123"}


def test_passes_base_url_when_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-456")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://custom.example/anthropic/v1")

    captured: dict[str, Any] = {}

    class _FakeAnthropic:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

    import anthropic as anthropic_module  # type: ignore[import-not-found]

    monkeypatch.setattr(anthropic_module, "AsyncAnthropic", _FakeAnthropic)
    client = executor._resolve_anthropic_client()
    assert client is not None
    assert captured == {
        "api_key": "sk-test-456",
        "base_url": "https://custom.example/anthropic/v1",
    }


def test_strips_whitespace_in_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    # Pasting from docs / shell often leaves trailing whitespace. The
    # resolver trims; an all-whitespace value is treated as unset.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-789")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "   ")

    captured: dict[str, Any] = {}

    class _FakeAnthropic:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

    import anthropic as anthropic_module  # type: ignore[import-not-found]

    monkeypatch.setattr(anthropic_module, "AsyncAnthropic", _FakeAnthropic)
    client = executor._resolve_anthropic_client()
    assert client is not None
    assert "base_url" not in captured
    assert captured == {"api_key": "sk-test-789"}


def test_resolver_caches_across_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-cached")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "")

    call_count = 0

    class _FakeAnthropic:
        def __init__(self, **kwargs: Any) -> None:
            nonlocal call_count
            call_count += 1

    import anthropic as anthropic_module  # type: ignore[import-not-found]

    monkeypatch.setattr(anthropic_module, "AsyncAnthropic", _FakeAnthropic)
    first = executor._resolve_anthropic_client()
    second = executor._resolve_anthropic_client()
    assert first is second
    assert call_count == 1
