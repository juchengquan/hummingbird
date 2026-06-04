"""`/v1/images/refresh-url` — re-sign an expired generated-image URL.
Mirrors `app/api/images/refresh-url/route.ts`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import get_current_user
from ..image_storage import sign_storage_path

router = APIRouter(tags=["images"])


class RefreshImageUrlRequest(BaseModel):
    """Mirrors `RefreshImageUrlRequestSchema` in
    `lib/shared/api-schemas.ts`. The TS field is `storagePath`; the
    Python wire uses `storage_path` to match the rest of the
    service's convention."""

    storage_path: str = Field(min_length=1, max_length=1000)


class RefreshImageUrlResponse(BaseModel):
    url: str


@router.post("/v1/images/refresh-url")
async def images_refresh_url(
    body: RefreshImageUrlRequest,
    claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> RefreshImageUrlResponse:
    """Re-sign an expired generated-image URL. Phase 4-4-a of
    PLAN-agent-api — Python mirror of
    `app/api/images/refresh-url/route.ts`.

    Authorisation: the bucket layout is `<user_id>/...` (see
    `0003_storage.sql`); we reject any `storage_path` whose first
    segment doesn't match the JWT's `sub` claim before touching
    Storage. RLS would also reject the call but a clean 403 is
    friendlier than fighting an opaque Storage error.

    Returns 404 when the object doesn't exist OR Storage isn't
    configured (both look the same from the API's perspective).
    """
    user_id = claims.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "auth", "message": "Token has no subject."},
        )

    first_segment = body.storage_path.split("/", 1)[0]
    if first_segment != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "forbidden",
                "message": "Storage path does not belong to you.",
            },
        )

    url = await sign_storage_path(body.storage_path)
    if url is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "not_found",
                "message": ("Could not re-sign the URL — object may be missing."),
            },
        )
    return RefreshImageUrlResponse(url=url)
