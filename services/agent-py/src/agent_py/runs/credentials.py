"""Local MCP credentials — the one secret a run's input carries (Q42, Q45).

The browser holds the credentials of its local-mode MCP servers and sends
them with each interactive run in AG-UI `RunAgentInput.state`, under
`LOCAL_MCP_STATE_KEY` (`LocalMcpCredentials` in the contract: server id →
`{type?, headers?}`); the server list itself, without credentials, is
`forwardedProps.localMcpServers`. Not a header: reverse-proxy access logs
record headers.

`split_state` takes them out of `state` before anything else sees the
input, so they exist only in `RunInput.local_mcp_credentials` — a
`repr=False` field — and in memory for the run's lifetime. They never
reach `tasks` (row, `checkpoint`), the event log, a log line, an error
message or a stream; a resume (a new run) carries them again.
`tests/test_run_credentials.py` pins this.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

__all__ = [
    "LOCAL_MCP_STATE_KEY",
    "LocalMcpCredential",
    "split_state",
]

LOCAL_MCP_STATE_KEY = "hummingbird.localMcp"

_MAX_SERVERS = 8
_MAX_HEADERS = 32


@dataclass(frozen=True)
class LocalMcpCredential:
    """One local MCP server's credential (`LocalMcpCredential` in the
    contract). Its repr names the header keys, never their values."""

    type: str | None = None
    headers: Mapping[str, str] = field(default_factory=dict, repr=False)

    def __repr__(self) -> str:
        return f"LocalMcpCredential(type={self.type!r}, headers=<{len(self.headers)} hidden>)"

    __str__ = __repr__


def _credential(raw: object) -> LocalMcpCredential | None:
    if not isinstance(raw, Mapping):
        return None
    kind = raw.get("type")
    raw_headers = raw.get("headers")
    headers: dict[str, str] = {}
    if isinstance(raw_headers, Mapping):
        for key, value in list(raw_headers.items())[:_MAX_HEADERS]:
            if isinstance(key, str) and key and isinstance(value, str):
                headers[key] = value
    return LocalMcpCredential(type=kind if isinstance(kind, str) else None, headers=headers)


def split_state(state: object) -> tuple[object, dict[str, LocalMcpCredential]]:
    """`(state without LOCAL_MCP_STATE_KEY, the credentials by server id)`.
    Lenient: a malformed value yields no credentials (the servers then run
    without one, as on the Next route). `state` itself is not modified."""
    if not isinstance(state, Mapping) or LOCAL_MCP_STATE_KEY not in state:
        return state, {}
    raw = state[LOCAL_MCP_STATE_KEY]
    rest = {k: v for k, v in state.items() if k != LOCAL_MCP_STATE_KEY}
    creds: dict[str, LocalMcpCredential] = {}
    if isinstance(raw, Mapping):
        for server_id, value in list(raw.items())[:_MAX_SERVERS]:
            cred = _credential(value)
            if isinstance(server_id, str) and server_id and cred is not None:
                creds[server_id] = cred
    return (rest or None), creds
