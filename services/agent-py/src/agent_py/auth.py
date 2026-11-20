"""Supabase JWT verification middleware.

Every authenticated endpoint depends on `get_current_user`, which
extracts the `Authorization: Bearer <jwt>` header, verifies the
signature against `SUPABASE_JWT_SECRET` (HS256 — the algorithm Supabase
issues by default), and returns the decoded `{ sub, role, ... }` claims.

A valid signature alone is NOT enough: the legacy Supabase anon key is
itself an HS256 JWT signed with the same project secret (role `anon`,
no `sub`) and ships in the browser bundle. So on top of the signature
we require:
  - `exp` present and in the future,
  - `aud` == `SUPABASE_JWT_AUDIENCE` (Supabase default `authenticated`),
  - `role` == `authenticated` (rejects `anon` and `service_role`),
  - `sub` present and a UUID (the auth.users id every DB call keys on).

Failure details are logged server-side only; the client always sees a
generic 401 body so the response doesn't help an attacker probe which
check tripped.
"""

from __future__ import annotations

import uuid
from typing import Annotated

import jwt
import structlog
from fastapi import Depends, Header, HTTPException, status

from .settings import Settings, get_settings

logger = structlog.get_logger(__name__)

#: The only `role` claim accepted on user-facing endpoints.
REQUIRED_ROLE = "authenticated"


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _is_uuid(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
    settings: Annotated[Settings, Depends(get_settings)] = None,  # type: ignore[assignment]
) -> dict[str, object]:
    """Verify a Supabase user JWT and return its claims.

    Failure modes:
        - No header → 401.
        - Header doesn't start with `Bearer ` → 401.
        - `SUPABASE_JWT_SECRET` unset → 503 (configuration error, distinct
          from auth failure so monitoring can alert on it separately).
        - Signature / expiry / audience / format invalid → 401.
        - `role` not `authenticated`, or `sub` missing / not a UUID → 401.

    Returns the decoded claims dict (`sub`, `role`, `email`, `aud`,
    `exp`, `iat`, ...).
    """
    if settings is None:  # defensive — FastAPI always populates the Depends
        settings = get_settings()

    if not settings.SUPABASE_JWT_SECRET:
        # Distinct from 401 so /healthz alerts can fire on misconfig.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Auth not configured (SUPABASE_JWT_SECRET missing).",
        )
    if not authorization or not authorization.startswith("Bearer "):
        raise _unauthorized("Missing or malformed Authorization header.")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        claims = jwt.decode(
            token,
            settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience=settings.SUPABASE_JWT_AUDIENCE,
            options={"require": ["exp", "sub", "aud"]},
        )
    except jwt.PyJWTError as exc:
        # Log the precise reason; never echo it to the client.
        logger.info("auth.token_rejected", reason=type(exc).__name__, error=str(exc))
        raise _unauthorized("Invalid token.") from exc

    role = claims.get("role")
    if role != REQUIRED_ROLE:
        logger.info("auth.token_rejected", reason="role", role=str(role))
        raise _unauthorized("Invalid token.")
    if not _is_uuid(claims.get("sub")):
        logger.info("auth.token_rejected", reason="sub")
        raise _unauthorized("Invalid token.")
    return claims
