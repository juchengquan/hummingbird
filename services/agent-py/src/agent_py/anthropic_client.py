"""The one constructor of Anthropic SDK clients in agent-py.

Always passes an explicit `base_url`. Left out, the SDK reads
`ANTHROPIC_BASE_URL` from the process environment, and an empty value
there isn't "unset" to it: the client's base URL becomes `""` and every
call fails "Connection error.". `docker compose` puts the `.env` into the
container's environment, and `.env.example` ships `ANTHROPIC_BASE_URL=`.
"""

from __future__ import annotations

from typing import Any

ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"


def make_anthropic_client(*, api_key: str, base_url: str = "") -> Any:
    """An `AsyncAnthropic` for `api_key` at `base_url` (blank → Anthropic's API)."""
    from anthropic import AsyncAnthropic

    return AsyncAnthropic(api_key=api_key, base_url=base_url.strip() or ANTHROPIC_DEFAULT_BASE_URL)


__all__ = ["ANTHROPIC_DEFAULT_BASE_URL", "make_anthropic_client"]
