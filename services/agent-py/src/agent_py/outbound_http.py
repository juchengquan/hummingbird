"""SSRF-safe outbound HTTP GET — shared by `url_fetch` (bookmarks) and
the `webFetch` agent tool.

Every user- or model-supplied URL the service fetches goes through
`safe_get`, which:

  1. runs `validate_outbound_url` on the URL and on EVERY redirect hop
     (redirects are followed manually; httpx's `follow_redirects` would
     skip the per-hop check),
  2. streams the body and stops at `max_body_bytes` (decoded bytes, so a
     gzip bomb is capped too) — either failing with `body_too_large` or
     truncating, caller's choice,
  3. bounds the whole exchange with an overall deadline on top of
     httpx's per-operation timeouts (a slow-drip body can't hold a
     worker forever).

`build_outbound_client` builds the production client. Its transport
uses `_SsrfGuardBackend`, an httpcore network backend that re-resolves
the hostname at socket-connect time, rejects the connection if any
address is private, and dials the validated IP literal. TLS SNI and
certificate verification still use the URL's hostname (httpcore passes
the origin host to `start_tls`), so pinning doesn't weaken HTTPS. This
closes the DNS-rebinding window between `validate_outbound_url`'s
lookup and the connect. The client also sets `trust_env=False` so an
`HTTP(S)_PROXY` env var can't route requests around the guard.

Every entry point takes an `OutboundUrlPolicy` (default: public only)
and applies it at both checks — the per-hop validation and the connect.
Only MCP traffic passes a relaxed one (`MCP_ALLOW_PRIVATE_HOSTS`);
bookmarks and `webFetch` stay public-only, as on Next.

Tests inject a client backed by `httpx.MockTransport`; that bypasses
the connect-time guard (no sockets), but the per-hop
`validate_outbound_url` checks still run.
"""

from __future__ import annotations

import asyncio
import codecs
import typing
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urljoin

import httpcore
import httpx

from .url_validate import (
    PUBLIC_ONLY,
    OutboundUrlPolicy,
    ValidationOk,
    resolve_public_addresses,
    validate_outbound_url,
)

OutboundErrorCode = Literal[
    "validation",
    "timeout",
    "too_many_redirects",
    "body_too_large",
    "network",
]

DEFAULT_MAX_REDIRECTS = 5


class OutboundFetchError(Exception):
    """Structured failure from `safe_get`. `code` is stable for callers
    to map onto HTTP statuses / tool errors."""

    def __init__(self, code: OutboundErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: OutboundErrorCode = code
        self.message = message


class BlockedAddressError(httpcore.ConnectError):
    """Raised by `_SsrfGuardBackend` when the connect-time resolution
    lands on a non-public address. Subclasses `ConnectError` so httpx
    maps it to `httpx.ConnectError` (with this as `__cause__`)."""


@dataclass(frozen=True)
class OutboundResponse:
    url: str
    """Final URL after redirects (validated)."""
    status_code: int
    reason_phrase: str
    headers: httpx.Headers
    body: bytes
    """Empty for status >= 400 — callers only need the status there."""
    truncated: bool
    encoding: str
    """Charset from Content-Type, or utf-8."""


# --- connect-time guard ------------------------------------------------------


class _SsrfGuardBackend(httpcore.AsyncNetworkBackend):
    """Network backend that validates the resolved address at connect
    time and dials the IP literal it validated — under `policy`, the
    same one the URL was validated with."""

    def __init__(self, policy: OutboundUrlPolicy = PUBLIC_ONLY) -> None:
        self._inner = httpcore.AnyIOBackend()
        self.policy = policy

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: typing.Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        resolved = await resolve_public_addresses(host, self.policy)
        if not isinstance(resolved, list):
            raise BlockedAddressError(resolved.message)
        last_exc: Exception | None = None
        for ip in resolved:
            try:
                return await self._inner.connect_tcp(
                    ip,
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last_exc = exc
        assert last_exc is not None  # resolved is non-empty
        raise last_exc

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: typing.Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise BlockedAddressError("Unix-socket connections are not allowed")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


class _GuardedTransport(httpx.AsyncHTTPTransport):
    """`AsyncHTTPTransport` whose connection pool dials through
    `_SsrfGuardBackend`. httpx doesn't expose `network_backend`, so we
    swap the (not-yet-used) pool it built for an equivalent one with
    the guard backend. `_pool` is the only attribute
    `handle_async_request` uses."""

    def __init__(self, policy: OutboundUrlPolicy = PUBLIC_ONLY) -> None:
        super().__init__(trust_env=False)
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=httpx.create_ssl_context(trust_env=False),
            network_backend=_SsrfGuardBackend(policy),
        )


def build_outbound_client(*, timeout_s: float, headers: dict[str, str]) -> httpx.AsyncClient:
    """Production client for `safe_get`: connect-time SSRF guard, no
    automatic redirects, no env proxies."""
    return build_guarded_client(timeout=timeout_s, headers=headers)


def build_guarded_client(
    *,
    headers: dict[str, str] | None = None,
    timeout: httpx.Timeout | float | None = None,
    auth: httpx.Auth | None = None,
    policy: OutboundUrlPolicy = PUBLIC_ONLY,
) -> httpx.AsyncClient:
    """An `httpx.AsyncClient` that can only reach public addresses (or,
    under a relaxed `policy`, any but link-local / metadata ones):
    every connection dials through `_SsrfGuardBackend` (resolve →
    reject private → dial the validated IP), redirects are never
    followed (a 3xx can't bounce the request to an internal host), and
    `trust_env=False` keeps `HTTP(S)_PROXY` / `.netrc` out of the path.

    Used directly by callers that don't go through `safe_get` — the MCP
    client hands it to the MCP SDK as its `httpx_client_factory`, so the
    SDK's POST / SSE GET / DELETE requests are all guarded."""
    return httpx.AsyncClient(
        transport=_GuardedTransport(policy),
        timeout=timeout if timeout is not None else 30.0,
        headers=headers,
        auth=auth,
        follow_redirects=False,
        trust_env=False,
    )


# --- fetch -------------------------------------------------------------------


async def safe_get(
    raw_url: str,
    *,
    client: httpx.AsyncClient,
    max_body_bytes: int,
    total_timeout_s: float,
    on_oversize: Literal["error", "truncate"] = "error",
    max_redirects: int = DEFAULT_MAX_REDIRECTS,
    check_headers: Callable[[httpx.Response], Exception | None] | None = None,
    policy: OutboundUrlPolicy = PUBLIC_ONLY,
) -> OutboundResponse:
    """GET `raw_url` with per-hop SSRF validation (under `policy`, which
    must match the client's — `build_guarded_client(policy=…)`) and a streamed body
    cap. Raises `OutboundFetchError` on any validation / network /
    size / redirect failure; returns the final response otherwise
    (including 4xx/5xx — the caller decides what an error status means).

    `check_headers` runs on the final 2xx/3xx-free response before the
    body is read; returning an exception aborts with it (lets a caller
    reject e.g. an unsupported Content-Type without downloading)."""
    try:
        async with asyncio.timeout(total_timeout_s):
            return await _safe_get_inner(
                raw_url,
                client=client,
                max_body_bytes=max_body_bytes,
                on_oversize=on_oversize,
                max_redirects=max_redirects,
                check_headers=check_headers,
                policy=policy,
            )
    except TimeoutError as exc:
        raise OutboundFetchError("timeout", f"Fetch timed out after {total_timeout_s}s") from exc


async def _safe_get_inner(
    raw_url: str,
    *,
    client: httpx.AsyncClient,
    max_body_bytes: int,
    on_oversize: Literal["error", "truncate"],
    max_redirects: int,
    check_headers: Callable[[httpx.Response], Exception | None] | None,
    policy: OutboundUrlPolicy,
) -> OutboundResponse:
    current_url = raw_url
    redirects_remaining = max_redirects
    while True:
        validation = await validate_outbound_url(current_url, policy)
        if not isinstance(validation, ValidationOk):
            raise OutboundFetchError("validation", validation.message)

        try:
            async with client.stream("GET", validation.url, follow_redirects=False) as response:
                if 300 <= response.status_code < 400:
                    location = response.headers.get("location")
                    if not location:
                        return _bodyless(validation.url, response)
                    if redirects_remaining <= 0:
                        raise OutboundFetchError(
                            "too_many_redirects", f"Exceeded {max_redirects} redirects"
                        )
                    redirects_remaining -= 1
                    current_url = urljoin(validation.url, location)
                    continue

                if response.status_code >= 400:
                    return _bodyless(validation.url, response)

                if check_headers is not None:
                    rejection = check_headers(response)
                    if rejection is not None:
                        raise rejection

                body, truncated = await _read_capped(response, max_body_bytes, on_oversize)
                return OutboundResponse(
                    url=validation.url,
                    status_code=response.status_code,
                    reason_phrase=response.reason_phrase,
                    headers=response.headers,
                    body=body,
                    truncated=truncated,
                    encoding=_charset(response),
                )
        except httpx.TimeoutException as exc:
            raise OutboundFetchError("timeout", "Fetch timed out") from exc
        except httpx.HTTPError as exc:
            if isinstance(exc.__cause__, BlockedAddressError):
                raise OutboundFetchError("validation", str(exc)) from exc
            raise OutboundFetchError("network", str(exc) or type(exc).__name__) from exc


def _charset(response: httpx.Response) -> str:
    """Declared charset if Python knows it, else utf-8 (callers decode
    with errors="replace")."""
    declared = response.charset_encoding
    if declared:
        try:
            codecs.lookup(declared)
        except LookupError:
            return "utf-8"
        return declared
    return "utf-8"


def _bodyless(url: str, response: httpx.Response) -> OutboundResponse:
    return OutboundResponse(
        url=url,
        status_code=response.status_code,
        reason_phrase=response.reason_phrase,
        headers=response.headers,
        body=b"",
        truncated=False,
        encoding=_charset(response),
    )


async def _read_capped(
    response: httpx.Response,
    max_body_bytes: int,
    on_oversize: Literal["error", "truncate"],
) -> tuple[bytes, bool]:
    too_large = OutboundFetchError(
        "body_too_large", f"Response body exceeded {max_body_bytes} bytes"
    )
    declared = response.headers.get("content-length")
    if (
        on_oversize == "error"
        and declared
        and declared.isdigit()
        and int(declared) > max_body_bytes
    ):
        raise too_large

    buf = bytearray()
    async for chunk in response.aiter_bytes():
        buf.extend(chunk)
        if len(buf) > max_body_bytes:
            if on_oversize == "error":
                raise too_large
            return bytes(buf[:max_body_bytes]), True
    return bytes(buf), False


__all__ = [
    "DEFAULT_MAX_REDIRECTS",
    "BlockedAddressError",
    "OutboundFetchError",
    "OutboundResponse",
    "build_guarded_client",
    "build_outbound_client",
    "safe_get",
]
