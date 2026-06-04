"""`/v1/url/fetch` — fetch + extract a URL as a bookmark snapshot.
Mirrors `app/api/url/fetch/route.ts`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import get_current_user
from ..url_fetch import FetchError, fetch_url_bookmark
from ..url_validate import normalize_url

router = APIRouter(tags=["url"])


class UrlFetchRequest(BaseModel):
    """Mirrors the TS `{ url }` body schema. Length capped to defeat
    pathological inputs — the SSRF gate runs after this."""

    url: str = Field(min_length=1, max_length=2000)


class BookmarkSnapshotModel(BaseModel):
    """Mirrors `BookmarkSnapshot` in `lib/server/url/fetch.ts`. Kept
    snake_case on the wire to match the rest of the Python service's
    convention (see `ExtractionResponse.full_text`)."""

    url: str
    title: str
    content: str
    content_truncated: bool
    content_hash: str
    description: str | None = None
    favicon_url: str | None = None


class UrlFetchResponse(BaseModel):
    ok: bool
    bookmark: BookmarkSnapshotModel


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


@router.post("/v1/url/fetch")
async def url_fetch(
    body: UrlFetchRequest,
    _claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> UrlFetchResponse:
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
    return UrlFetchResponse(
        ok=True,
        bookmark=BookmarkSnapshotModel(
            url=snap.url,
            title=snap.title,
            content=snap.content,
            content_truncated=snap.content_truncated,
            content_hash=snap.content_hash,
            description=snap.description,
            favicon_url=snap.favicon_url,
        ),
    )
