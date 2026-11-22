"""SSRF guard for outbound URL fetches — Python port of
`lib/server/url/validate.ts`.

Two-pass validation:
  1. Syntactic — URL parse, scheme allowlist, textual hostname
     blocklist (`.local`, `.internal`, `localhost`, …).
  2. Network — resolve the hostname, deny if any returned address
     is in a private / loopback / link-local / multicast / CGNAT
     range (DNS rebinding defence).

`normalize_url` is a separate convenience: it prepends `https://`
to bare-domain input (`example.com` → `https://example.com`) and
canonicalises the hostname + path so dedup checks compare the same
shape. Mirrors the TS `normalizeUrl` exported alongside.

`OutboundUrlPolicy` relaxes pass 2 (and the textual blocklist) for
private hosts — MCP only, when the operator sets
`MCP_ALLOW_PRIVATE_HOSTS=true` (`mcp_client.mcp_outbound_policy`), as
`OutboundUrlPolicy` in the TS file. Link-local addresses
(169.254.0.0/16, fe80::/10 — the cloud metadata endpoint) and the named
metadata hosts stay blocked under every policy.

Treat every reject as a security boundary — when in doubt, deny.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse, urlunparse

ValidationCode = Literal[
    "invalid_url",
    "bad_scheme",
    "blocked_host",
    "dns_lookup_failed",
    "private_address",
]

ALLOWED_SCHEMES = frozenset({"http", "https"})

#: Hostnames that resolve to non-public destinations regardless of DNS.
#: `.local` covers mDNS / Bonjour, `.internal` is common for corp DNS,
#: `*.svc.cluster.local` is Kubernetes service discovery.
BLOCKED_HOST_SUFFIXES: tuple[str, ...] = (
    ".local",
    ".internal",
    ".localhost",
    ".lan",
    ".intranet",
    ".corp",
    ".home",
    ".svc.cluster.local",
)

BLOCKED_EXACT_HOSTS: frozenset[str] = frozenset(
    {
        "localhost",
        "metadata.google.internal",
        "metadata.azure.com",
    }
)


#: Blocked under every policy — `ALWAYS_BLOCKED_HOSTS` in the TS file.
ALWAYS_BLOCKED_HOSTS: frozenset[str] = frozenset(
    {
        "metadata.google.internal",
        "metadata.azure.com",
        "metadata",
    }
)


@dataclass(frozen=True)
class OutboundUrlPolicy:
    """Per-call relaxation of the private-host rules (`OutboundUrlPolicy`
    in `lib/server/url/validate.ts`). The default is the strict
    public-internet-only posture every fetcher uses.

    `allow_private_hosts` lets loopback / RFC 1918 / ULA / `.local`-style
    hosts through — MCP traffic only, when the operator opts in with
    `MCP_ALLOW_PRIVATE_HOSTS=true` (a dev MCP server on `localhost`).
    Even then link-local (169.254.0.0/16, fe80::/10, which covers the
    169.254.169.254 metadata endpoint), AWS's IPv6 IMDS address and the
    named metadata hosts stay blocked: no legitimate MCP server lives
    there, and they are the most valuable SSRF target."""

    allow_private_hosts: bool = False


PUBLIC_ONLY = OutboundUrlPolicy()
"""The default policy: public addresses only."""


@dataclass(frozen=True)
class ValidationError:
    code: ValidationCode
    message: str


@dataclass(frozen=True)
class ValidationOk:
    url: str
    """The validated, canonical URL (scheme://host[:port]/path?query)."""


ValidationResult = ValidationOk | ValidationError


def normalize_url(raw: str) -> str | None:
    """Canonical form for dedup. Prepends `https://` to bare-domain
    input (`example.com` → `https://example.com`), lowercases the
    hostname, drops the fragment, and strips a single trailing
    slash from the path (`/` itself is kept). Returns None on a
    URL the parser can't make sense of."""
    trimmed = raw.strip()
    if not trimmed:
        return None

    # Bare-domain handling: if the input doesn't start with a URL
    # scheme (`<scheme>://`), prepend `https://`. The check is two
    # parts so `example.com:8080` (host+port, not a scheme) doesn't
    # get mistaken for the scheme `example.com:`. We accept any
    # alphanumeric scheme followed by `://` OR by `:` + a non-digit
    # non-slash; otherwise it's a bare domain and we add https://.
    if not _has_scheme(trimmed):
        trimmed = f"https://{trimmed}"

    try:
        parsed = urlparse(trimmed)
        if not parsed.netloc:
            return None
    except Exception:
        return None

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        return None

    # Rebuild from parts so the hostname is lowercased and the
    # fragment is dropped. Strip a single trailing slash from
    # non-root paths (`/foo/` → `/foo`).
    path = parsed.path
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")

    # Preserve port + userinfo via netloc reconstruction.
    netloc = hostname
    if parsed.port is not None:
        netloc = f"{hostname}:{parsed.port}"

    return urlunparse((parsed.scheme.lower(), netloc, path, parsed.params, parsed.query, ""))


_URL_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.\-]*://", re.IGNORECASE)
_NON_URL_SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.\-]*:[^/\d]", re.IGNORECASE)


def _has_scheme(raw: str) -> bool:
    """Detect whether `raw` already starts with a URL scheme. Mirrors
    the TS `normalizeUrl`'s `hasScheme` split.

    Returns True for `https://example.com` (URL scheme) and
    `mailto:user@host` (non-URL scheme). Returns False for
    `example.com:8080` (host+port, not a scheme — a scheme followed
    by a digit is a port indicator)."""
    if _URL_SCHEME_RE.match(raw):
        return True
    return bool(_NON_URL_SCHEME_RE.match(raw))


async def validate_outbound_url(
    raw_url: str, policy: OutboundUrlPolicy = PUBLIC_ONLY
) -> ValidationResult:
    """Two-pass URL validation. Returns `ValidationOk(url)` with the
    canonical form on success, or `ValidationError(code, message)`
    on rejection. Caller treats every error as a 4xx user-facing
    failure. `policy` relaxes the private-host rules (MCP only)."""
    try:
        parsed = urlparse(raw_url)
        if not parsed.netloc:
            raise ValueError("missing netloc")
    except Exception:
        return ValidationError(code="invalid_url", message="URL is not parseable")

    scheme = parsed.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        return ValidationError(
            code="bad_scheme",
            message=f"Only http(s) URLs are allowed; got {scheme}:",
        )

    try:
        hostname = parsed.hostname
    except ValueError:
        return ValidationError(code="invalid_url", message="URL is not parseable")
    host_lower = (hostname or "").lower()
    if not host_lower:
        return ValidationError(code="invalid_url", message="URL has no hostname")
    # A trailing root dot (`localhost.`, `metadata.google.internal.`)
    # must not dodge the textual blocklists.
    host_match = host_lower[:-1] if host_lower.endswith(".") else host_lower

    if host_match in ALWAYS_BLOCKED_HOSTS:
        return ValidationError(
            code="blocked_host",
            message=f"Hostname {host_match!r} is blocked",
        )
    if not policy.allow_private_hosts:
        if host_match in BLOCKED_EXACT_HOSTS:
            return ValidationError(
                code="blocked_host",
                message=f"Hostname {host_match!r} is blocked",
            )
        for suffix in BLOCKED_HOST_SUFFIXES:
            if host_match == suffix.lstrip(".") or host_match.endswith(suffix):
                return ValidationError(
                    code="blocked_host",
                    message=f"Hostnames ending in {suffix!r} are blocked",
                )

    resolved = await resolve_public_addresses(host_lower, policy)
    if isinstance(resolved, ValidationError):
        return resolved
    return ValidationOk(url=raw_url)


async def resolve_public_addresses(
    host: str, policy: OutboundUrlPolicy = PUBLIC_ONLY
) -> list[str] | ValidationError:
    """Resolve `host` (hostname or IP literal) and return its addresses
    iff EVERY one is allowed under `policy` (public only by default).
    Any disallowed address → `ValidationError` (DNS rebinding defence —
    `evil.com` could resolve to 127.0.0.1).

    Used twice per outbound request: by `validate_outbound_url` before
    the request, and by `outbound_http`'s network backend at socket
    connect time, so the address actually dialled is the one checked
    (closes the TOCTOU window between validation and connect) — with
    the same policy both times."""
    host_lower = host.lower()

    # If the hostname is already a literal IP, check it directly.
    ip_literal = _try_ip(host_lower)
    if ip_literal is not None:
        if not is_address_allowed(ip_literal, policy):
            return ValidationError(
                code="private_address",
                message=f"Address {ip_literal} is in a private range",
            )
        return [ip_literal]

    # DNS lookup. Resolve both A and AAAA via getaddrinfo's
    # `family=AF_UNSPEC` (the default).
    try:
        infos = await _async_getaddrinfo(host_lower)
    except OSError as exc:
        return ValidationError(
            code="dns_lookup_failed",
            message=str(exc) or f"DNS lookup failed for {host_lower!r}",
        )
    if not infos:
        return ValidationError(
            code="dns_lookup_failed",
            message=f"DNS lookup returned no addresses for {host_lower!r}",
        )

    out: list[str] = []
    for addr in infos:
        ip = _try_ip(addr)
        if ip is None:
            return ValidationError(
                code="private_address",
                message=f"Hostname {host_lower!r} resolved to unparseable {addr!r}",
            )
        if not is_address_allowed(ip, policy):
            return ValidationError(
                code="private_address",
                message=(f"Hostname {host_lower!r} resolves to private address {addr}"),
            )
        if ip not in out:
            out.append(ip)
    return out


def is_address_allowed(addr: str, policy: OutboundUrlPolicy = PUBLIC_ONLY) -> bool:
    """Whether a numeric address may be connected to under `policy`
    (`isAddressAllowed` in the TS file): never an always-blocked one
    (link-local, metadata), any other under `allow_private_hosts`, else
    only a public one."""
    if _is_always_blocked_ip(addr):
        return False
    if policy.allow_private_hosts:
        return True
    return not _is_private_ip(addr)


def _is_always_blocked_ip(addr: str) -> bool:
    """Addresses no outbound request may reach under any policy:
    link-local (169.254.0.0/16 — the cloud metadata endpoint — and
    fe80::/10, plain or IPv4-mapped) and AWS's IPv6 IMDS address
    `fd00:ec2::254`. Unparseable input is denied."""
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return True
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return ip.ipv4_mapped.is_link_local
        return ip.is_link_local or ip == ipaddress.IPv6Address("fd00:ec2::254")
    return ip.is_link_local


def _try_ip(value: str) -> str | None:
    """Strip IPv6 brackets if present, then return the canonical
    address string if `value` is a valid IPv4 or IPv6 literal,
    None otherwise. Mirrors TS `stripIpv6Brackets` + `isIP`."""
    candidate = value
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


def _is_private_ip(addr: str) -> bool:
    """True for any private / loopback / link-local / multicast /
    reserved range — anything the SSRF gate should deny. Mirrors
    `isPrivateAddress` in the TS path. The ipaddress module's
    built-in properties cover the common cases; we add a few
    explicit ranges (CGNAT, benchmarking) to match TS exactly."""
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return True
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return True
    if isinstance(ip, ipaddress.IPv4Address):
        a, b = (int(p) for p in str(ip).split(".")[:2])
        # CGNAT (100.64.0.0/10) — RFC 6598. Not flagged by
        # `is_private` in stdlib.
        if a == 100 and 64 <= b <= 127:
            return True
        # IETF protocol assignments (192.0.0.0/24).
        if a == 192 and b == 0:
            return True
        # Benchmarking (198.18.0.0/15).
        if a == 198 and b in (18, 19):
            return True
    # IPv4-mapped IPv6 — reject the whole family. A legitimate
    # public IPv4 should arrive as IPv4, not embedded in IPv6.
    return isinstance(ip, ipaddress.IPv6Address) and str(ip).lower().startswith("::ffff:")


async def _async_getaddrinfo(hostname: str) -> list[str]:
    """Resolve hostname → list of address strings. socket.getaddrinfo
    is synchronous; run it in a thread executor to keep the event
    loop responsive."""
    import asyncio

    loop = asyncio.get_event_loop()
    infos = await loop.run_in_executor(
        None, socket.getaddrinfo, hostname, None, 0, socket.SOCK_STREAM
    )
    out: list[str] = []
    for family, _socktype, _proto, _canonname, sockaddr in infos:
        if family in (socket.AF_INET, socket.AF_INET6) and sockaddr:
            out.append(str(sockaddr[0]))
    return out


__all__ = [
    "ALLOWED_SCHEMES",
    "ALWAYS_BLOCKED_HOSTS",
    "BLOCKED_EXACT_HOSTS",
    "BLOCKED_HOST_SUFFIXES",
    "PUBLIC_ONLY",
    "OutboundUrlPolicy",
    "ValidationError",
    "ValidationOk",
    "ValidationResult",
    "is_address_allowed",
    "normalize_url",
    "resolve_public_addresses",
    "validate_outbound_url",
]
