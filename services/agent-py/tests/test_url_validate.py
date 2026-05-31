"""Tests for the URL SSRF gate (`url_validate.py`).

Covers:
  - `normalize_url`: bare-domain → https://; trailing slash strip;
    hostname lowercase; fragment drop; None on garbage.
  - `validate_outbound_url`: scheme allowlist; textual blocklist;
    IP literal private/loopback/multicast checks; CGNAT range;
    IPv6 reject; DNS rebinding (private IP returned by
    `getaddrinfo` → reject); DNS lookup failure → distinct code.

DNS resolution is patched at the boundary so tests stay hermetic
and the IPv6 / CGNAT / benchmark ranges are deterministic.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from agent_py.url_validate import (
    ValidationError,
    ValidationOk,
    normalize_url,
    validate_outbound_url,
)

# --- normalize_url ---------------------------------------------------


def test_normalize_url_prepends_https_for_bare_domain() -> None:
    assert normalize_url("example.com") == "https://example.com"


def test_normalize_url_preserves_explicit_scheme() -> None:
    assert normalize_url("http://example.com") == "http://example.com"


def test_normalize_url_lowercases_hostname() -> None:
    assert normalize_url("https://EXAMPLE.com/Foo") == "https://example.com/Foo"


def test_normalize_url_strips_trailing_slash() -> None:
    assert normalize_url("https://example.com/foo/") == "https://example.com/foo"
    # Root path is kept as-is.
    assert normalize_url("https://example.com/") == "https://example.com/"


def test_normalize_url_drops_fragment() -> None:
    assert normalize_url("https://example.com/p#section") == "https://example.com/p"


def test_normalize_url_preserves_port() -> None:
    assert normalize_url("https://example.com:8443/p") == "https://example.com:8443/p"


def test_normalize_url_bare_domain_with_port_not_mistaken_for_scheme() -> None:
    # `example.com:8080` is a host+port, not a scheme — we prepend https://.
    assert normalize_url("example.com:8080/p") == "https://example.com:8080/p"


def test_normalize_url_empty_and_garbage() -> None:
    assert normalize_url("") is None
    assert normalize_url("   ") is None


# --- validate_outbound_url — syntactic --------------------------------


@pytest.mark.asyncio
async def test_validate_rejects_unparseable_url() -> None:
    out = await validate_outbound_url("not a url")
    assert isinstance(out, ValidationError) and out.code == "invalid_url"


@pytest.mark.asyncio
async def test_validate_rejects_non_http_scheme() -> None:
    out = await validate_outbound_url("ftp://example.com/")
    assert isinstance(out, ValidationError) and out.code == "bad_scheme"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "https://localhost/p",
        "https://metadata.google.internal/p",
        "https://foo.local/p",
        "https://api.internal/p",
        "https://x.svc.cluster.local/p",
    ],
)
async def test_validate_rejects_textual_blocklist(url: str) -> None:
    out = await validate_outbound_url(url)
    assert isinstance(out, ValidationError) and out.code == "blocked_host"


# --- validate_outbound_url — IP literals ------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url, why",
    [
        ("https://127.0.0.1/p", "loopback"),
        ("https://10.0.0.1/p", "RFC1918"),
        ("https://192.168.1.1/p", "RFC1918"),
        ("https://172.16.0.1/p", "RFC1918"),
        ("https://169.254.169.254/p", "link-local"),
        ("https://100.64.0.1/p", "CGNAT"),
        ("https://198.18.0.1/p", "benchmarking"),
        ("https://224.0.0.1/p", "multicast"),
        ("https://[::1]/p", "IPv6 loopback"),
        ("https://[fc00::1]/p", "IPv6 unique local"),
        ("https://[fe80::1]/p", "IPv6 link-local"),
        ("https://[::ffff:127.0.0.1]/p", "IPv4-mapped IPv6"),
    ],
)
async def test_validate_rejects_private_ip_literals(url: str, why: str) -> None:
    out = await validate_outbound_url(url)
    assert isinstance(out, ValidationError), f"{url} ({why})"
    assert out.code == "private_address", out


@pytest.mark.asyncio
async def test_validate_accepts_public_ip_literal() -> None:
    # No DNS lookup since this is already an IP literal.
    out = await validate_outbound_url("https://1.1.1.1/p")
    assert isinstance(out, ValidationOk)


# --- validate_outbound_url — DNS --------------------------------------


@pytest.mark.asyncio
async def test_validate_dns_returns_public_ip_accepts() -> None:
    """Mock the resolver to return a public IP — should pass."""
    with patch(
        "agent_py.url_validate._async_getaddrinfo",
        return_value=["93.184.216.34"],  # example.com
    ):
        out = await validate_outbound_url("https://example.com/p")
    assert isinstance(out, ValidationOk)


@pytest.mark.asyncio
async def test_validate_dns_rebinding_rejected() -> None:
    """Hostname resolves to a private IP → reject. Classic DNS
    rebinding defence."""
    with patch(
        "agent_py.url_validate._async_getaddrinfo",
        return_value=["127.0.0.1"],
    ):
        out = await validate_outbound_url("https://evil.example.com/p")
    assert isinstance(out, ValidationError)
    assert out.code == "private_address"


@pytest.mark.asyncio
async def test_validate_dns_one_private_one_public_rejects() -> None:
    """If `getaddrinfo` returns multiple records and ANY one is
    private, deny — protects against partial DNS rebinding."""
    with patch(
        "agent_py.url_validate._async_getaddrinfo",
        return_value=["93.184.216.34", "127.0.0.1"],
    ):
        out = await validate_outbound_url("https://example.com/p")
    assert isinstance(out, ValidationError)
    assert out.code == "private_address"


@pytest.mark.asyncio
async def test_validate_dns_lookup_failure_distinct_code() -> None:
    """DNS resolution error → `dns_lookup_failed` (not `private_address`)
    so the route can distinguish "couldn't resolve" from "resolves
    somewhere dangerous"."""
    with patch(
        "agent_py.url_validate._async_getaddrinfo",
        side_effect=OSError("nxdomain"),
    ):
        out = await validate_outbound_url("https://does-not-exist.test/p")
    assert isinstance(out, ValidationError) and out.code == "dns_lookup_failed"


@pytest.mark.asyncio
async def test_validate_dns_unparseable_returned_address_rejects() -> None:
    """If the resolver returns something that doesn't parse as IPv4
    or IPv6, deny — unknown format is safer to refuse."""

    async def fake_dns(*args: Any) -> list[str]:
        return ["garbage-not-an-ip"]

    with patch("agent_py.url_validate._async_getaddrinfo", new=fake_dns):
        out = await validate_outbound_url("https://example.com/p")
    assert isinstance(out, ValidationError)
    assert out.code == "private_address"
