"""`/v1/files/refresh-url` — re-sign an expired generated-file URL.
Mirrors `app/api/files/refresh-url/route.ts`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from ..auth import get_current_user
from ..image_storage import is_storage_configured, sign_storage_path

router = APIRouter(tags=["files"])


def _check_storage_path(path: str) -> str:
    # Same refinements as `RefreshFileUrlRequestSchema`. The first-segment
    # ownership check in the route is what actually protects other users'
    # objects; these reject obvious traversal up front.
    if ".." in path:
        raise ValueError("storagePath must not contain ..")
    if path.startswith("/"):
        raise ValueError("storagePath must not start with /")
    return path


class RefreshFileUrlRequest(BaseModel):
    """Mirrors `RefreshFileUrlRequestSchema` in `lib/shared/api-schemas.ts`
    — camelCase `storagePath` on the wire, unlike `/v1/images/refresh-url`
    (`storage_path`), so the body is exactly the Zod shape."""

    model_config = ConfigDict(populate_by_name=False)

    storage_path: Annotated[
        str,
        Field(alias="storagePath", min_length=1, max_length=512),
        AfterValidator(_check_storage_path),
    ]


class RefreshFileUrlResponse(BaseModel):
    url: str = Field(min_length=1)


@router.post("/v1/files/refresh-url")
async def files_refresh_url(
    body: RefreshFileUrlRequest,
    claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> RefreshFileUrlResponse:
    """Re-sign an expired generated-file URL (`persistGeneratedFiles` URLs
    carry a 1-year TTL; the bytes stay in Storage at `storagePath`).

    Same answers as the Next.js route:
      - Storage not configured → 503 `unavailable`;
      - path's first segment ≠ the caller's uid (JWT `sub`) → 403
        `forbidden` (bucket layout is `<user_id>/...`; the service-role
        key bypasses RLS, so this check is the authorisation);
      - object missing / sign failed → 404 `not_found`.

    Signs in the shared `user-files` bucket with the same 1-year TTL as
    the image route (`image_storage.sign_storage_path`), which is the TTL
    `lib/server/file-storage.ts` uses too.
    """
    user_id = claims.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "auth", "message": "Token has no subject."},
        )

    if not is_storage_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "unavailable", "message": "Supabase is not configured."},
        )

    first_segment = body.storage_path.split("/", 1)[0]
    if first_segment != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "message": "Storage path does not belong to you."},
        )

    url = await sign_storage_path(body.storage_path)
    if url is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "not_found",
                "message": "Could not re-sign the URL — object may be missing.",
            },
        )
    return RefreshFileUrlResponse(url=url)
