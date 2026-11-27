"""`/v1/url/fetch` — fetch + extract a URL as a bookmark snapshot.
Mirrors `app/api/url/fetch/route.ts`.

Signed in or anonymous (wave 12, Q123/Q134 — `caller.optional_caller`):
an anonymous caller is refused under `REQUIRE_AUTH_FOR_AI` and limited to
Next's 30 fetches per IP per minute; a signed-in one isn't limited here
(unchanged).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from ..caller import AnonymousWindow, Caller, optional_caller
from ..contract import models
from ..url_fetch import FetchError, fetch_url_bookmark
from ..url_validate import normalize_url

router = APIRouter(tags=["url"])

#: Next's `bookmarkRateLimit`: 30 fetches per IP per minute.
ANONYMOUS_PER_MINUTE = 30
_anonymous_limit = AnonymousWindow(per_minute=ANONYMOUS_PER_MINUTE, message="Too many fetches.")


def reset_limits() -> None:
    """Forget the anonymous window (tests)."""
    _anonymous_limit.reset()


def _url_fetch_error_status(code: str) -> int:
    """Translate `FetchError.code` to its HTTP status. Mirrors
    `httpStatusFor` in the TS route."""
    if code in ("validation", "unsupported_content_type"):
        return status.HTTP_400_BAD_REQUEST
    if code == "timeout":
        return status.HTTP_408_REQUEST_TIMEOUT
    if code == "body_too_large":
        return status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
    if code in ("too_many_redirects", "http_error", "network"):
        return status.HTTP_502_BAD_GATEWAY
    return status.HTTP_500_INTERNAL_SERVER_ERROR


@router.post(
    "/v1/url/fetch", response_model=models.UrlFetchResponse, response_model_exclude_none=True
)
async def url_fetch(
    body: models.UrlFetchRequest,
    caller: Annotated[Caller, Depends(optional_caller)],
) -> models.UrlFetchResponse:
    """Fetch + extract a URL as a bookmark snapshot. Phase 4-4-a
    of PLAN-agent-api — Python mirror of `app/api/url/fetch/route.ts`.

    Pipeline:
      1. Normalise the URL (prepend https:// for bare-domain
         input, lowercase host, strip fragment).
      2. SSRF gate — scheme allowlist, textual hostname blocklist,
         DNS rebinding defence (resolve + private-IP check).
      3. Fetch with 10s timeout, manual redirect handling (5 hops
         max, each re-validated), 5 MB body cap.
      4. Extract title / content / description / favicon via lxml.

    Error → status mapping mirrors the TS path: validation /
    unsupported_content_type → 400, timeout → 408, body_too_large
    → 413, http_error / too_many_redirects / network → 502.
    """
    _anonymous_limit.check(caller)
    normalized = normalize_url(body.url)
    if normalized is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_url", "message": "URL is not parseable"},
        )
    result = await fetch_url_bookmark(normalized)
    if isinstance(result, FetchError):
        # Translate the structured error to the documented HTTP
        # status code. Mirrors the TS route's `httpStatusFor`.
        raise HTTPException(
            status_code=_url_fetch_error_status(result.code),
            detail={
                "code": result.code,
                "message": result.message,
                **({"status": result.status} if result.status is not None else {}),
            },
        )
    snap = result.snapshot
    if snap is None:
        # Belt-and-braces — `FetchOk` always carries a snapshot
        # in practice, but the typed shape is `BookmarkSnapshot |
        # None` so guard anyway.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "missing_snapshot", "message": "Empty fetch result."},
        )
    # The contract's `BookmarkSnapshot`: camelCase, as the browser's
    # `UrlFetchSnapshot` reads.
    return models.UrlFetchResponse(
        ok=True,
        bookmark=models.BookmarkSnapshot(
            url=snap.url,
            title=snap.title,
            content=snap.content,
            contentTruncated=snap.content_truncated,
            contentHash=snap.content_hash,
            description=snap.description,
            faviconUrl=snap.favicon_url,
        ),
    )
