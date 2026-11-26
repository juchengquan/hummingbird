"""Every Anthropic client agent-py builds targets an explicit host.

The SDK reads `ANTHROPIC_BASE_URL` from the process environment when no
`base_url` is passed, and an empty value there isn't "unset" to it: the
client's base URL becomes `""` and every call fails "Connection error.".
`docker compose` puts the `.env` (copied from `.env.example`, which ships
`ANTHROPIC_BASE_URL=`) into the container's environment, so an empty
setting must still mean Anthropic's own API. Real SDK clients here.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from agent_py import chat, executor, verify_client
from agent_py.runs import native_harness
from agent_py.settings import get_settings

DEFAULT = "https://api.anthropic.com"


def _factories() -> dict[str, Callable[[], Any]]:
    return {
        "chat": chat.resolve_anthropic_client,
        "verify": verify_client.settings_anthropic_client,
        "executor": executor._resolve_anthropic_client,
        "runs": lambda: native_harness._client_from_settings(get_settings())(),
    }


@pytest.fixture(autouse=True)
def _fresh(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(executor, "_anthropic_client", None)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    get_settings.cache_clear()


@pytest.mark.parametrize("name", list(_factories()))
@pytest.mark.parametrize("empty", ["", "   "])
def test_an_empty_base_url_in_the_environment_means_anthropic(
    monkeypatch: pytest.MonkeyPatch, name: str, empty: str
) -> None:
    monkeypatch.setenv("ANTHROPIC_BASE_URL", empty)
    client = _factories()[name]()
    assert str(client.base_url).rstrip("/") == DEFAULT


@pytest.mark.parametrize("name", list(_factories()))
def test_a_set_base_url_is_used(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    monkeypatch.setenv("ANTHROPIC_BASE_URL", " https://proxy.example/anthropic ")
    client = _factories()[name]()
    assert str(client.base_url).rstrip("/") == "https://proxy.example/anthropic"
