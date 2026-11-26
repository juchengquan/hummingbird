"""Supabase JWT verification middleware.

Every authenticated endpoint depends on `get_current_user`, which
extracts the `Authorization: Bearer <jwt>` header, verifies the
signature and returns the decoded `{ sub, role, ... }` claims. The key
follows the token's `alg` header (wave 9, Q106):

  - `HS256` → `SUPABASE_JWT_SECRET` (the legacy project secret);
  - `ES256` / `RS256` → the key its `kid` names in the project's JWKS
    (`jwks.py`: `SUPABASE_JWKS_URL`, else derived from `SUPABASE_URL`),
    and only with that key's own algorithm;
  - anything else (`none`, `HS512`, `ES384`, …) → 401.

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

from . import jwks
from .settings import Settings, get_settings

logger = structlog.get_logger(__name__)

#: The only `role` claim accepted on user-facing endpoints.
REQUIRED_ROLE = "authenticated"


def _unauthorized(message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": "auth", "message": message},
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


def auth_configured(settings: Settings) -> bool:
    """Whether a token can be verified at all: the HS256 secret or a JWKS."""
    return bool(settings.SUPABASE_JWT_SECRET or jwks.jwks_url(settings))


def _verification_key(token: str, settings: Settings) -> tuple[object, str]:
    """The key and the one algorithm `token` must verify with."""
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        logger.info("auth.token_rejected", reason=type(exc).__name__, error=str(exc))
        raise _unauthorized("Invalid token.") from exc
    alg = header.get("alg")
    if alg == "HS256":
        if not settings.SUPABASE_JWT_SECRET:
            logger.info("auth.token_rejected", reason="hs256_without_secret")
            raise _unauthorized("Invalid token.")
        return settings.SUPABASE_JWT_SECRET, "HS256"
    if alg not in jwks.ASYMMETRIC_ALGORITHMS:
        logger.info("auth.token_rejected", reason="alg", alg=str(alg))
        raise _unauthorized("Invalid token.")
    url = jwks.jwks_url(settings)
    kid = header.get("kid")
    if not url or not isinstance(kid, str) or not kid:
        logger.info("auth.token_rejected", reason="kid" if url else "no_jwks")
        raise _unauthorized("Invalid token.")
    try:
        key = jwks.cache_for(url).key_for(kid)
    except jwks.JwksUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "unavailable", "message": "Auth keys unavailable. Try again shortly."},
        ) from exc
    if key is None or key.alg != alg:
        logger.info("auth.token_rejected", reason="unknown_kid" if key is None else "alg_mismatch")
        raise _unauthorized("Invalid token.")
    return key.key, alg


def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
    settings: Annotated[Settings, Depends(get_settings)] = None,  # type: ignore[assignment]
) -> dict[str, object]:
    """Verify a Supabase user JWT and return its claims.

    Failure modes:
        - No header → 401.
        - Header doesn't start with `Bearer ` → 401.
        - Neither `SUPABASE_JWT_SECRET` nor a JWKS URL → 503 (configuration
          error, distinct from auth failure so monitoring can alert on it
          separately); the JWKS unreadable with no keys cached → 503.
        - Signature / expiry / audience / format invalid → 401.
        - `role` not `authenticated`, or `sub` missing / not a UUID → 401.

    Returns the decoded claims dict (`sub`, `role`, `email`, `aud`,
    `exp`, `iat`, ...).
    """
    if settings is None:  # defensive — FastAPI always populates the Depends
        settings = get_settings()

    if not auth_configured(settings):
        # Distinct from 401 so /healthz alerts can fire on misconfig.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "unavailable",
                "message": "Auth not configured (SUPABASE_JWT_SECRET missing).",
            },
        )
    if not authorization or not authorization.startswith("Bearer "):
        raise _unauthorized("Missing or malformed Authorization header.")
    token = authorization.removeprefix("Bearer ").strip()
    key, alg = _verification_key(token, settings)
    try:
        claims = jwt.decode(
            token,
            key,  # type: ignore[arg-type]
            algorithms=[alg],
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
