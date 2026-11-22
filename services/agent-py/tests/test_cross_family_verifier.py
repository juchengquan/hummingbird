"""Tests for the cross-family verifier policy (`verify_client`) and the
executor's `_maybe_verify` path that uses it."""

from __future__ import annotations

from dataclasses import dataclass
from unittest.mock import MagicMock

import pytest
from structlog.testing import capture_logs

from agent_py import executor, verify_client


# Sentinel "client" returned by the patched factory. Distinct id
# so we can tell the policy picked the right one.
@dataclass
class _SentinelClient:
    family: str
    calls: list[tuple[str, int, list[dict[str, object]]]]


def _none() -> None:
    return None


@pytest.fixture(autouse=True)
def _reset_warn_once() -> None:
    """`warn_once` is module-level state; clear it between tests."""
    verify_client.warned_keys.clear()


def test_resolve_verifier_client_picks_cross_family(monkeypatch) -> None:
    """VERIFY_PROVIDER=google + an Anthropic answerer -> the
    Google wrapper is picked, no warning is logged."""
    settings = MagicMock()
    settings.VERIFY_PROVIDER = "google"
    settings.VERIFY_MODEL = "gemini-2.0-flash"

    google = _SentinelClient(family="google", calls=[])
    anthropic = _SentinelClient(family="anthropic", calls=[])

    monkeypatch.setattr(verify_client, "get_settings", lambda: settings)
    monkeypatch.setattr(verify_client, "make_google_verifier_client", lambda: google)
    monkeypatch.setattr(verify_client, "make_anthropic_verifier_client", lambda _src: anthropic)

    out = verify_client.resolve_verifier_client(
        answerer_provider="anthropic", anthropic_client=_none
    )
    assert out is google
    assert not verify_client.warned_keys  # no warning fired


def test_resolve_verifier_client_falls_back_with_warning(monkeypatch) -> None:
    """VERIFY_PROVIDER=google but the Google client is unavailable
    + the Anthropic fallback is enabled -> Anthropic client is
    used AND the `verifier_google_unavailable` warning is logged
    exactly once."""
    settings = MagicMock()
    settings.VERIFY_PROVIDER = "google"
    settings.VERIFY_MODEL = "gemini-2.0-flash"

    anthropic = _SentinelClient(family="anthropic", calls=[])

    monkeypatch.setattr(verify_client, "get_settings", lambda: settings)
    monkeypatch.setattr(verify_client, "make_google_verifier_client", lambda: None)
    monkeypatch.setattr(verify_client, "make_anthropic_verifier_client", lambda _src: anthropic)

    with capture_logs() as logs:
        out1 = verify_client.resolve_verifier_client(
            answerer_provider="anthropic", anthropic_client=_none
        )
        out2 = verify_client.resolve_verifier_client(
            answerer_provider="anthropic", anthropic_client=_none
        )

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

    monkeypatch.setattr(verify_client, "get_settings", lambda: settings)
    monkeypatch.setattr(verify_client, "make_anthropic_verifier_client", lambda _src: anthropic)

    with capture_logs() as logs:
        verify_client.resolve_verifier_client(answerer_provider="anthropic", anthropic_client=_none)
        verify_client.resolve_verifier_client(answerer_provider="anthropic", anthropic_client=_none)
        verify_client.resolve_verifier_client(answerer_provider="anthropic", anthropic_client=_none)

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

    monkeypatch.setattr(verify_client, "get_settings", lambda: settings)
    monkeypatch.setattr(verify_client, "resolve_verifier_client", lambda **_: client)

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
    assert client.calls[0][1] == verify_client.VERIFY_MAX_TOKENS


async def test_maybe_verify_is_research_only(monkeypatch) -> None:
    """Outside research mode the executor never reaches the verifier."""

    async def boom(**_: object) -> None:
        raise AssertionError("verifier called")

    monkeypatch.setattr(verify_client, "verify_citations", boom)
    out = await executor._maybe_verify(mode=None, text="X [1].", sources=[("A", "https://a", "s")])
    assert out is None
