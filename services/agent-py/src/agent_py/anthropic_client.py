"""The one constructor of Anthropic SDK clients in agent-py.

Always passes an explicit `base_url` and an explicit credential. Left out,
the SDK reads `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` from the process
environment: an empty base URL there isn't "unset" to it (the client's base
URL becomes `""` and every call fails "Connection error."; `docker compose`
puts the `.env` into the container, and `.env.example` ships
`ANTHROPIC_BASE_URL=`), and a client for another provider (the Gateway,
OpenRouter, `model_routes.py`) would send the Anthropic key there.
"""

from __future__ import annotations

from typing import Any

ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"


def make_anthropic_client(
    *, api_key: str | None = None, base_url: str = "", auth_token: str | None = None
) -> Any:
    """An `AsyncAnthropic` at `base_url` (blank → Anthropic's API) with
    `api_key` (`X-Api-Key`) and / or `auth_token` (`Authorization: Bearer`).
    At least one credential is required."""
    from anthropic import AsyncAnthropic

    if not api_key and not auth_token:
        raise ValueError("make_anthropic_client needs an api_key or an auth_token")
    kwargs: dict[str, Any] = {"base_url": base_url.strip() or ANTHROPIC_DEFAULT_BASE_URL}
    if api_key:
        kwargs["api_key"] = api_key
    if auth_token:
        kwargs["auth_token"] = auth_token
    return AsyncAnthropic(**kwargs)


__all__ = ["ANTHROPIC_DEFAULT_BASE_URL", "make_anthropic_client"]
