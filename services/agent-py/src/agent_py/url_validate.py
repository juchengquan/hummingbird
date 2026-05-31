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


async def validate_outbound_url(raw_url: str) -> ValidationResult:
    """Two-pass URL validation. Returns `ValidationOk(url)` with the
    canonical form on success, or `ValidationError(code, message)`
    on rejection. Caller treats every error as a 4xx user-facing
    failure."""
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

    host_lower = (parsed.hostname or "").lower()
    if not host_lower:
        return ValidationError(code="invalid_url", message="URL has no hostname")

    if host_lower in BLOCKED_EXACT_HOSTS:
        return ValidationError(
            code="blocked_host",
            message=f"Hostname {host_lower!r} is blocked",
        )
    for suffix in BLOCKED_HOST_SUFFIXES:
        if host_lower == suffix.lstrip(".") or host_lower.endswith(suffix):
            return ValidationError(
                code="blocked_host",
                message=f"Hostnames ending in {suffix!r} are blocked",
            )

    # If the hostname is already a literal IP, check it directly.
    ip_literal = _try_ip(host_lower)
    if ip_literal is not None:
        if _is_private_ip(ip_literal):
            return ValidationError(
                code="private_address",
                message=f"Address {ip_literal} is in a private range",
            )
        return ValidationOk(url=raw_url)

    # DNS lookup. Resolve both A and AAAA via getaddrinfo's
    # `family=AF_UNSPEC` (the default). Reject if any address is
    # private (DNS rebinding defence — `evil.com` could resolve to
    # 127.0.0.1).
    try:
        infos = await _async_getaddrinfo(host_lower)
    except OSError as exc:
        return ValidationError(
            code="dns_lookup_failed",
            message=str(exc) or f"DNS lookup failed for {host_lower!r}",
        )

    for addr in infos:
        ip = _try_ip(addr)
        if ip is None:
            return ValidationError(
                code="private_address",
                message=f"Hostname {host_lower!r} resolved to unparseable {addr!r}",
            )
        if _is_private_ip(ip):
            return ValidationError(
                code="private_address",
                message=(f"Hostname {host_lower!r} resolves to private address {addr}"),
            )

    return ValidationOk(url=raw_url)


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
    "BLOCKED_EXACT_HOSTS",
    "BLOCKED_HOST_SUFFIXES",
    "ValidationError",
    "ValidationOk",
    "ValidationResult",
    "normalize_url",
    "validate_outbound_url",
]
