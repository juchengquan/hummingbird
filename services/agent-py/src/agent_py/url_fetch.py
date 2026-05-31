"""URL bookmark fetcher — Python port of `lib/server/url/fetch.ts`.

`fetch_url_bookmark(url, client?)` validates the URL via the SSRF
gate, follows up to 5 redirects (re-validating each hop), reads the
body with a 5 MB cap, and extracts title / content / description /
favicon. Returns a `BookmarkSnapshot` on success or a structured
`FetchError` on any failure mode — the route maps each error code
to its HTTP status.

Caps mirror the TS path:
  - 10s timeout
  - 5 redirects max
  - 5 MB response body cap
  - 200 KB extracted text per bookmark (truncation marker set)

The optional `client` arg is a test seam — production callers let
the function build its own short-lived `httpx.AsyncClient`. Tests
pass a pre-built client backed by `httpx.MockTransport` so they
stay hermetic.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urljoin, urlparse

import httpx
import structlog

from .url_validate import ValidationOk, validate_outbound_url

logger = structlog.get_logger(__name__)

FETCH_TIMEOUT_S = 10.0
MAX_REDIRECTS = 5
MAX_BODY_BYTES = 5 * 1024 * 1024
EXTRACTED_TEXT_BUDGET = 200 * 1024

USER_AGENT = "Hummingbird-Bookmark/1.0 (+https://github.com/juchengquan/hummingbird)"
ACCEPT_HEADER = "text/html, application/json, text/plain;q=0.9, text/markdown;q=0.9, */*;q=0.5"


FetchErrorCode = Literal[
    "validation",
    "timeout",
    "too_many_redirects",
    "body_too_large",
    "http_error",
    "unsupported_content_type",
    "network",
]


@dataclass(frozen=True)
class BookmarkSnapshot:
    url: str
    title: str
    content: str
    content_truncated: bool
    content_hash: str
    description: str | None = None
    favicon_url: str | None = None


@dataclass(frozen=True)
class FetchError:
    ok: Literal[False] = False
    code: FetchErrorCode = "network"
    message: str = ""
    status: int | None = None
    """Set only for `http_error` — the upstream's HTTP status."""


@dataclass(frozen=True)
class FetchOk:
    ok: Literal[True] = True
    snapshot: BookmarkSnapshot | None = None


FetchResult = FetchOk | FetchError


async def fetch_url_bookmark(
    raw_url: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> FetchResult:
    """Fetch + extract a single URL. Returns a `FetchOk(snapshot)`
    on success or a `FetchError(code, message[, status])` on any
    failure mode. Never raises — every error mode goes through the
    structured shape so the route can map to HTTP status cleanly."""
    current_url = raw_url
    redirects_remaining = MAX_REDIRECTS

    own_client = client is None
    if client is None:
        client = httpx.AsyncClient(
            timeout=FETCH_TIMEOUT_S,
            follow_redirects=False,
            headers={"User-Agent": USER_AGENT, "Accept": ACCEPT_HEADER},
        )

    try:
        while True:
            validation = await validate_outbound_url(current_url)
            if not isinstance(validation, ValidationOk):
                return FetchError(code="validation", message=validation.message)

            try:
                response = await client.get(validation.url)
            except httpx.TimeoutException:
                return FetchError(
                    code="timeout",
                    message=f"Fetch timed out after {FETCH_TIMEOUT_S}s",
                )
            except httpx.HTTPError as exc:
                return FetchError(code="network", message=str(exc))

            # Manual redirect handling so we re-validate each hop.
            if 300 <= response.status_code < 400:
                location = response.headers.get("location")
                if not location:
                    return FetchError(
                        code="http_error",
                        status=response.status_code,
                        message=(f"Redirect ({response.status_code}) with no Location header"),
                    )
                if redirects_remaining <= 0:
                    return FetchError(
                        code="too_many_redirects",
                        message=f"Exceeded {MAX_REDIRECTS} redirects",
                    )
                redirects_remaining -= 1
                # Resolve relative redirects against the current URL.
                current_url = urljoin(validation.url, location)
                continue

            if response.status_code >= 400:
                return FetchError(
                    code="http_error",
                    status=response.status_code,
                    message=(
                        f"Upstream returned {response.status_code} "
                        f"{response.reason_phrase or ''}".strip()
                    ),
                )

            content_type = (response.headers.get("content-type") or "").lower()
            is_html = "text/html" in content_type
            is_json = "application/json" in content_type
            is_text = content_type.startswith("text/") or "xml" in content_type

            if not is_html and not is_json and not is_text:
                return FetchError(
                    code="unsupported_content_type",
                    message=(f"Cannot extract text from {content_type or 'unknown content type'}"),
                )

            body = response.content
            if len(body) > MAX_BODY_BYTES:
                return FetchError(
                    code="body_too_large",
                    message=(f"Response body exceeded {MAX_BODY_BYTES // (1024 * 1024)} MB"),
                )

            text = body.decode(response.encoding or "utf-8", errors="replace")
            if is_html:
                extracted = _extract_html(text, validation.url)
            else:
                extracted = _extract_plain(text, validation.url)

            final_text = extracted["content"][:EXTRACTED_TEXT_BUDGET]
            truncated = len(extracted["content"]) > len(final_text)
            content_hash = hashlib.sha256(final_text.encode("utf-8")).hexdigest()[:16]

            return FetchOk(
                snapshot=BookmarkSnapshot(
                    url=validation.url,
                    title=extracted["title"],
                    content=final_text,
                    content_truncated=truncated,
                    content_hash=content_hash,
                    description=extracted.get("description"),
                    favicon_url=extracted.get("favicon_url"),
                )
            )
    finally:
        if own_client:
            await client.aclose()


# --- HTML extraction --------------------------------------------------------


def _extract_html(html: str, base_url: str) -> dict[str, Any]:
    """Extract title / content / description / favicon from an HTML
    page. Uses lxml (already a dep from Phase 3e file extraction).
    Falls back gracefully on malformed input — returns hostname for
    title, empty content."""
    from lxml import html as lxml_html

    try:
        doc = lxml_html.fromstring(html)
    except Exception:
        parsed_base = urlparse(base_url)
        return {
            "title": parsed_base.hostname or base_url,
            "content": "",
        }

    # Title precedence: <title>, then og:title, then hostname.
    title_node = doc.find(".//title")
    title = (title_node.text_content().strip() if title_node is not None else "") or ""
    if not title:
        for meta in doc.findall(".//meta"):
            if (meta.get("property") or "").lower() == "og:title":
                title = (meta.get("content") or "").strip()
                if title:
                    break
    if not title:
        title = urlparse(base_url).hostname or base_url

    # Description: <meta name="description"> or og:description.
    description: str | None = None
    for meta in doc.findall(".//meta"):
        name = (meta.get("name") or "").lower()
        if name == "description":
            description = (meta.get("content") or "").strip() or None
            if description:
                break
    if description is None:
        for meta in doc.findall(".//meta"):
            if (meta.get("property") or "").lower() == "og:description":
                description = (meta.get("content") or "").strip() or None
                if description:
                    break

    # Favicon — first <link rel="...icon">, fallback to /favicon.ico.
    favicon_url: str | None = None
    for link in doc.findall(".//link"):
        rel = (link.get("rel") or "").lower()
        if "icon" in rel:
            href = link.get("href")
            if href:
                try:
                    favicon_url = urljoin(base_url, href)
                except Exception:
                    favicon_url = None
            break
    if not favicon_url:
        favicon_url = urljoin(base_url, "/favicon.ico")

    # Content: prefer <main>, then <article>, then <body>. Strip
    # noise before extracting text.
    container = doc.find(".//main")
    if container is None:
        container = doc.find(".//article")
    if container is None:
        container = doc.find(".//body")
    if container is None:
        container = doc

    for sel in ("nav", "footer", "aside", "script", "style", "noscript", "svg"):
        for el in container.findall(f".//{sel}"):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)

    raw_text = container.text_content() or ""
    content = " ".join(raw_text.split())

    return {
        "title": title,
        "content": content,
        "description": description,
        "favicon_url": favicon_url,
    }


def _extract_plain(text: str, base_url: str) -> dict[str, Any]:
    parsed = urlparse(base_url)
    title = (parsed.hostname or "") + parsed.path
    return {"title": title, "content": text}


__all__ = [
    "EXTRACTED_TEXT_BUDGET",
    "FETCH_TIMEOUT_S",
    "MAX_BODY_BYTES",
    "MAX_REDIRECTS",
    "BookmarkSnapshot",
    "FetchError",
    "FetchOk",
    "FetchResult",
    "fetch_url_bookmark",
]
