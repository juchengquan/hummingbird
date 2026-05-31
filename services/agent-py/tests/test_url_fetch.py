"""Tests for `url_fetch.py` — the URL bookmark fetcher.

Hermetic — `httpx.MockTransport` intercepts every HTTP call. The
SSRF gate's DNS lookups are short-circuited by using IP literals
(public IPs pass the syntactic checks without resolution).
"""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest

from agent_py.url_fetch import (
    BookmarkSnapshot,
    FetchError,
    FetchOk,
    fetch_url_bookmark,
)


def _mock(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.AsyncClient:
    """Build an `httpx.AsyncClient` whose transport is the given
    handler. `follow_redirects=False` so the bookmark fetcher's
    manual hop logic runs."""
    return httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        follow_redirects=False,
    )


# Use a public IP literal so SSRF DNS pass without mocking.
PUBLIC = "https://1.1.1.1/p"


@pytest.mark.asyncio
async def test_fetch_html_extracts_title_content_description_favicon() -> None:
    html = """
    <html>
      <head>
        <title>Example Title</title>
        <meta name="description" content="A short page">
        <link rel="icon" href="/favicon.png">
      </head>
      <body>
        <nav>Nav</nav>
        <main>
          <h1>Body heading</h1>
          <p>Hello   world.</p>
        </main>
        <footer>Footer</footer>
        <script>console.log("ignored")</script>
      </body>
    </html>
    """

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=html.encode(), headers={"content-type": "text/html"})

    async with _mock(handler) as client:
        out = await fetch_url_bookmark(PUBLIC, client=client)

    assert isinstance(out, FetchOk)
    snap = out.snapshot
    assert isinstance(snap, BookmarkSnapshot)
    assert snap.title == "Example Title"
    assert "Body heading" in snap.content
    assert "Hello world." in snap.content
    # Stripped: nav + footer + script.
    assert "Nav" not in snap.content
    assert "Footer" not in snap.content
    assert "console.log" not in snap.content
    assert snap.description == "A short page"
    assert snap.favicon_url is not None and "/favicon.png" in snap.favicon_url


@pytest.mark.asyncio
async def test_fetch_html_falls_back_through_title_sources() -> None:
    """No `<title>` → og:title → hostname."""
    html = (
        '<html><head><meta property="og:title" content="OG Title"></head>'
        "<body><p>x</p></body></html>"
    )

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=html.encode(), headers={"content-type": "text/html"})

    async with _mock(handler) as client:
        out = await fetch_url_bookmark(PUBLIC, client=client)
    assert isinstance(out, FetchOk) and out.snapshot is not None
    assert out.snapshot.title == "OG Title"


@pytest.mark.asyncio
async def test_fetch_html_falls_back_to_default_favicon() -> None:
    html = "<html><head><title>T</title></head><body>x</body></html>"

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=html.encode(), headers={"content-type": "text/html"})

    async with _mock(handler) as client:
        out = await fetch_url_bookmark(PUBLIC, client=client)
    assert isinstance(out, FetchOk) and out.snapshot is not None
    assert out.snapshot.favicon_url is not None and out.snapshot.favicon_url.endswith(
        "/favicon.ico"
    )


@pytest.mark.asyncio
async def test_fetch_plain_text_keeps_body() -> None:
    """Non-HTML text content keeps the body verbatim; title falls back
    to hostname + path."""

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"line one\nline two", headers={"content-type": "text/plain"}
        )

    async with _mock(handler) as client:
        out = await fetch_url_bookmark(PUBLIC, client=client)
    assert isinstance(out, FetchOk) and out.snapshot is not None
    assert "line one" in out.snapshot.content
    assert out.snapshot.title.endswith("/p")


@pytest.mark.asyncio
async def test_fetch_rejects_unsupported_content_type() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"binary", headers={"content-type": "image/png"})

    async with _mock(handler) as client:
        out = await fetch_url_bookmark(PUBLIC, client=client)
    assert isinstance(out, FetchError)
    assert out.code == "unsupported_content_type"


@pytest.mark.asyncio
async def test_fetch_http_4xx_returns_http_error() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(404, content=b"missing")

    async with _mock(handler) as client:
        out = await fetch_url_bookmark(PUBLIC, client=client)
    assert isinstance(out, FetchError)
    assert out.code == "http_error"
    assert out.status == 404


@pytest.mark.asyncio
async def test_fetch_5xx_returns_http_error() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(503, content=b"down")

    async with _mock(handler) as client:
        out = await fetch_url_bookmark(PUBLIC, client=client)
    assert isinstance(out, FetchError)
    assert out.code == "http_error"
    assert out.status == 503


@pytest.mark.asyncio
async def test_fetch_redirect_revalidates_hop() -> None:
    """A 302 to a private IP target should be rejected by the SSRF
    gate on the redirect target, not silently followed."""

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if url.startswith("https://1.1.1.1"):
            return httpx.Response(
                302,
                headers={"location": "https://127.0.0.1/internal"},
            )
        # Should never reach here — but if we did, return 200.
        return httpx.Response(200, content=b"leaked")

    async with _mock(handler) as client:
        out = await fetch_url_bookmark(PUBLIC, client=client)
    assert isinstance(out, FetchError) and out.code == "validation"


@pytest.mark.asyncio
async def test_fetch_too_many_redirects() -> None:
    """A redirect loop hits the 5-redirect cap and returns
    `too_many_redirects` (not `network`)."""
    counter = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        counter["n"] += 1
        # Each hop points to the next public IP via Location. Keep
        # them all public so the SSRF gate doesn't short-circuit.
        return httpx.Response(302, headers={"location": f"https://1.1.1.{counter['n'] + 1}/p"})

    async with _mock(handler) as client:
        out = await fetch_url_bookmark(PUBLIC, client=client)
    assert isinstance(out, FetchError)
    assert out.code == "too_many_redirects"


@pytest.mark.asyncio
async def test_fetch_body_too_large() -> None:
    """5 MB cap — handler returns 6 MB → body_too_large code."""
    huge = b"x" * (6 * 1024 * 1024)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=huge, headers={"content-type": "text/plain"})

    async with _mock(handler) as client:
        out = await fetch_url_bookmark(PUBLIC, client=client)
    assert isinstance(out, FetchError)
    assert out.code == "body_too_large"


@pytest.mark.asyncio
async def test_fetch_network_error() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("DNS failed")

    async with _mock(handler) as client:
        out = await fetch_url_bookmark(PUBLIC, client=client)
    assert isinstance(out, FetchError)
    assert out.code == "network"


@pytest.mark.asyncio
async def test_fetch_validation_error_for_blocked_host() -> None:
    async with _mock(lambda req: httpx.Response(200)) as client:
        out = await fetch_url_bookmark("https://localhost/p", client=client)
    assert isinstance(out, FetchError)
    assert out.code == "validation"


@pytest.mark.asyncio
async def test_fetch_extracted_text_capped() -> None:
    """200 KB extraction budget — a body past that returns truncated=True."""
    from agent_py.url_fetch import EXTRACTED_TEXT_BUDGET

    body = b"a" * (EXTRACTED_TEXT_BUDGET + 1000)

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "text/plain"})

    async with _mock(handler) as client:
        out = await fetch_url_bookmark(PUBLIC, client=client)
    assert isinstance(out, FetchOk) and out.snapshot is not None
    assert out.snapshot.content_truncated is True
    assert len(out.snapshot.content) == EXTRACTED_TEXT_BUDGET


@pytest.mark.asyncio
async def test_fetch_content_hash_is_deterministic() -> None:
    """Same content twice → same hash. Confirms the change-detection
    use case the TS path documents."""

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"hello", headers={"content-type": "text/plain"})

    async with _mock(handler) as client:
        a = await fetch_url_bookmark(PUBLIC, client=client)
        b = await fetch_url_bookmark(PUBLIC, client=client)
    assert isinstance(a, FetchOk) and a.snapshot is not None
    assert isinstance(b, FetchOk) and b.snapshot is not None
    assert a.snapshot.content_hash == b.snapshot.content_hash
