"""Tests for the cross-family verifier policy and the
_maybe_verify path that uses it."""

from __future__ import annotations

from dataclasses import dataclass
from unittest.mock import MagicMock

import pytest
from structlog.testing import capture_logs

from agent_py import executor


# Sentinel "client" returned by the patched factory. Distinct id
# so we can tell the policy picked the right one.
@dataclass
class _SentinelClient:
    family: str
    calls: list[tuple[str, int, list[dict[str, object]]]]


@pytest.fixture(autouse=True)
def _reset_warn_once() -> None:
    """`_warn_once` is module-level state; clear it between tests."""
    if hasattr(executor, "_warned_keys"):
        executor._warned_keys.clear()


def test_resolve_verifier_client_picks_cross_family(monkeypatch) -> None:
    """VERIFY_PROVIDER=google + an Anthropic answerer -> the
    Google wrapper is picked, no warning is logged."""
    settings = MagicMock()
    settings.VERIFY_PROVIDER = "google"
    settings.VERIFY_MODEL = "gemini-2.0-flash"

    google = _SentinelClient(family="google", calls=[])
    anthropic = _SentinelClient(family="anthropic", calls=[])

    monkeypatch.setattr(executor, "get_settings", lambda: settings)
    monkeypatch.setattr(executor, "_make_google_verifier_client", lambda: google)
    monkeypatch.setattr(executor, "_make_anthropic_verifier_client", lambda: anthropic)

    out = executor._resolve_verifier_client(answerer_provider="anthropic")
    assert out is google
    assert not executor._warned_keys  # no warning fired


def test_resolve_verifier_client_falls_back_with_warning(monkeypatch) -> None:
    """VERIFY_PROVIDER=google but the Google client is unavailable
    + the Anthropic fallback is enabled -> Anthropic client is
    used AND the `verifier_google_unavailable` warning is logged
    exactly once."""
    settings = MagicMock()
    settings.VERIFY_PROVIDER = "google"
    settings.VERIFY_MODEL = "gemini-2.0-flash"

    anthropic = _SentinelClient(family="anthropic", calls=[])

    monkeypatch.setattr(executor, "get_settings", lambda: settings)
    monkeypatch.setattr(executor, "_make_google_verifier_client", lambda: None)
    monkeypatch.setattr(executor, "_make_anthropic_verifier_client", lambda: anthropic)

    with capture_logs() as logs:
        out1 = executor._resolve_verifier_client(answerer_provider="anthropic")
        out2 = executor._resolve_verifier_client(answerer_provider="anthropic")

    assert out1 is anthropic
    assert out2 is anthropic
    matches = [log for log in logs if log.get("event") == "executor.verifier_google_unavailable"]
    assert len(matches) == 1, f"expected 1 warning, got {len(matches)}"


def test_resolve_verifier_client_warns_once_on_same_family(monkeypatch) -> None:
    """VERIFY_PROVIDER=anthropic + an Anthropic answerer ->
    Anthropic client is used AND a `verifier_same_family` warning
    is logged exactly once."""
    settings = MagicMock()
    settings.VERIFY_PROVIDER = "anthropic"
    settings.VERIFY_MODEL = "claude-haiku-3-5"

    anthropic = _SentinelClient(family="anthropic", calls=[])

    monkeypatch.setattr(executor, "get_settings", lambda: settings)
    monkeypatch.setattr(executor, "_make_anthropic_verifier_client", lambda: anthropic)

    with capture_logs() as logs:
        executor._resolve_verifier_client(answerer_provider="anthropic")
        executor._resolve_verifier_client(answerer_provider="anthropic")
        executor._resolve_verifier_client(answerer_provider="anthropic")

    matches = [log for log in logs if log.get("event") == "executor.verifier_same_family"]
    assert len(matches) == 1


async def test_maybe_verify_uses_cross_family(monkeypatch) -> None:
    """_maybe_verify with a stubbed client + an anthropic
    answerer -> the stub is called with the configured model."""
    settings = MagicMock()
    settings.VERIFY_MODEL = "gemini-2.0-flash"

    client = _SentinelClient(family="google", calls=[])

    async def fake_create(*, model: str, max_tokens: int, messages: list[dict[str, object]]) -> str:
        client.calls.append((model, max_tokens, messages))
        return '{"checks":[]}'

    # Bind the protocol to our sentinel
    object.__setattr__(client, "messages_create", fake_create)

    monkeypatch.setattr(executor, "get_settings", lambda: settings)
    monkeypatch.setattr(executor, "_resolve_verifier_client", lambda **_: client)

    out = await executor._maybe_verify(
        mode="research",
        text="X is true [1].",
        sources=[("A", "https://a", "snip")],
        answerer_provider="anthropic",
    )
    # The verifier returned a `{"checks":[]}` JSON, which has 0
    # checks -> verify_answer returns None. So the test only asserts
    # the client was called.
    assert out is None
    assert len(client.calls) == 1
    assert client.calls[0][0] == "gemini-2.0-flash"
    assert client.calls[0][1] == executor._VERIFY_MAX_TOKENS
