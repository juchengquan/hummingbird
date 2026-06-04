"""Auth smoke test endpoint. Verifies the JWT secret and
Authorization-header plumbing work end-to-end before any real
endpoints exist.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..auth import get_current_user

router = APIRouter(tags=["auth"])


class WhoAmIResponse(BaseModel):
    user_id: str | None
    role: str | None


@router.get("/v1/whoami", response_model=WhoAmIResponse)
def whoami(
    claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> WhoAmIResponse:
    """Auth smoke test — echoes the verified claims (minus secrets).

    Useful during Phase 0 deployment to confirm the JWT secret and
    the Authorization-header plumbing work end-to-end before any
    real endpoints exist. Deliberately under `/v1` so the prefix
    convention exists from day one.
    """
    sub = claims.get("sub")
    role = claims.get("role")
    return WhoAmIResponse(
        user_id=str(sub) if sub is not None else None,
        role=str(role) if role is not None else None,
    )
