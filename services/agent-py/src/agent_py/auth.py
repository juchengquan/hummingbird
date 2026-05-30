"""Supabase JWT verification middleware.

Phase 0 contract: every authenticated endpoint depends on `get_current_user`,
which extracts the `Authorization: Bearer <jwt>` header, verifies the
signature against `SUPABASE_JWT_SECRET` (HS256 — the algorithm Supabase
issues by default), and returns the decoded `{ sub, role, ... }` claims.

Phase 1+ will widen this to:
  - reject expired tokens (PyJWT does this already; just making it explicit)
  - distinguish service-role tokens from user tokens (the worker path needs
    the service role; user requests must never carry it)
  - thread the claims into structured logs so a request id is traceable
    back to a user without dumping the JWT body
"""

from __future__ import annotations

from typing import Annotated

import jwt
from fastapi import Depends, Header, HTTPException, status

from .settings import Settings, get_settings


def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
    settings: Annotated[Settings, Depends(get_settings)] = None,  # type: ignore[assignment]
) -> dict[str, object]:
    """Verify a Supabase JWT and return its claims.

    Failure modes:
        - No header → 401.
        - Header doesn't start with `Bearer ` → 401.
        - `SUPABASE_JWT_SECRET` unset → 503 (configuration error, distinct
          from auth failure so monitoring can alert on it separately).
        - Signature / expiry / format invalid → 401.

    Returns the decoded claims dict. Typical Supabase claims include
    `sub` (the user UUID), `role` (`authenticated` or `service_role`),
    `email`, `aud`, `exp`, `iat`.
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
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization.removeprefix("Bearer ").strip()
    try:
        claims = jwt.decode(
            token,
            settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            # Supabase issues tokens with `aud="authenticated"`. PyJWT
            # defaults to NOT verifying audience, which is the right call
            # here — service-role tokens use `aud="authenticated"` too,
            # and the role check belongs at the endpoint, not in this
            # middleware. Phase 1 may tighten this.
            options={"verify_aud": False},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    return claims
