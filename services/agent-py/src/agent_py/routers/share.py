"""`/v1/share` — create, revoke and publicly read share links.

Mirrors `app/api/share/route.ts` (create), `app/api/share/[token]/route.ts`
(revoke) and `lib/server/share/resolve.ts` (the public read the share
pages use). Data access lives in `agent_py.shares`; the wire models are
the ones generated from `packages/contract/openapi.yaml`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Request, status
from pydantic import Field

from .. import shares
from ..auth import get_current_user
from ..contract import models
from ..db import get_pool, has_pool
from ..rate_limit import SlidingWindow, rate_limit_key

router = APIRouter(tags=["sharing"])

# Per-IP budget for the public read. Generous for people opening links,
# tight enough that walking the token space (128 bits, so hopeless anyway)
# or hammering the DB from one address is cut off. In-process, like the
# chat limiter.
_share_read_per_ip_limit = SlidingWindow(window_ms=60_000, max=60)

_TOKEN_PATH = Path(min_length=1, max_length=256, description="The opaque share token.")

CreateShareBody = Annotated[
    models.CreateConversationShareRequest | models.CreateDocumentShareRequest,
    Field(discriminator="kind"),
]
ResolvedShareBody = Annotated[
    models.ResolvedConversationShare | models.ResolvedDocumentShare,
    Field(discriminator="kind"),
]


def _require_user_id(claims: dict[str, object]) -> str:
    user_id = claims.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "auth", "message": "Token has no subject."},
        )
    return user_id


def _require_pool_for_user_writes() -> None:
    # The Next.js routes answer 503 when Supabase isn't configured; here
    # the equivalent is "no DB pool to impersonate the user on".
    if not has_pool():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "unavailable",
                "message": "SUPABASE_DB_URL is not configured on the agent service.",
            },
        )


def _share_not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"code": "not_found", "message": "Share not found."},
    )


@router.post("/v1/share")
async def create_share(
    body: Annotated[CreateShareBody, Body()],
    claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> models.CreateShareResponse:
    """Mint a share token for one of the caller's conversations or
    documents. Same answers as the Next.js route:

    - the target is missing or not the caller's → 404 `not_found`
      ("Conversation not found" / "Document not found");
    - the insert failed → 500 `unknown` (the DB message is logged, not
      echoed);
    - no DB configured → 503 `unavailable`.
    """
    user_id = _require_user_id(claims)
    _require_pool_for_user_writes()

    if isinstance(body, models.CreateConversationShareRequest):
        kind: shares.ShareKind = "conversation"
        target_id = str(body.conversationId)
    else:
        kind = "document"
        target_id = str(body.documentId)

    result = await shares.create_share(get_pool(), user_id=user_id, kind=kind, target_id=target_id)
    if result.error == "not_found":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "not_found",
                "message": "Conversation not found"
                if kind == "conversation"
                else "Document not found",
            },
        )
    if result.token is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "unknown", "message": "Could not create the share."},
        )
    return models.CreateShareResponse(token=result.token, kind=kind)


@router.delete("/v1/share/{token}")
async def revoke_share(
    token: Annotated[str, _TOKEN_PATH],
    claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> models.RevokeShareResponse:
    """Revoke the caller's share. RLS (plus an explicit owner filter)
    limits the update to the caller's rows, so another user's token
    matches nothing and answers the same 404 as an unknown one."""
    user_id = _require_user_id(claims)
    _require_pool_for_user_writes()
    try:
        revoked = await shares.revoke_share(get_pool(), user_id=user_id, token=token)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "unknown", "message": "Could not revoke the share."},
        ) from exc
    if not revoked:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "Not found"},
        )
    return models.RevokeShareResponse(ok=True)


@router.get("/v1/share/{token}", response_model=ResolvedShareBody)
async def get_share(
    token: Annotated[str, _TOKEN_PATH],
    request: Request,
) -> models.ResolvedConversationShare | models.ResolvedDocumentShare:
    """**Public — no auth.** What the read-only share pages render.

    Every reason a token can't be shown — unknown, revoked, target gone
    or not owned by the share's creator, no database configured, a read
    error — is the same 404 `not_found`, so the answer leaks nothing
    beyond "this token resolves". (The Next.js share pages likewise call
    `notFound()` for all of them, including a missing service-role key.)
    Rate limited per client IP."""
    verdict = _share_read_per_ip_limit.consume(rate_limit_key(request))
    if not verdict.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "rate_limit", "message": "Too many requests. Slow down and retry."},
            headers={"Retry-After": str(verdict.retry_after_sec)},
        )
    if not has_pool():
        raise _share_not_found()

    resolved = await shares.resolve_share(get_pool(), token)
    if resolved is None:
        raise _share_not_found()
    if isinstance(resolved, shares.ResolvedDocumentShare):
        return models.ResolvedDocumentShare(
            kind="document",
            documentTitle=resolved.document_title,
            documentContent=resolved.document_content,
            createdAt=resolved.created_at,
        )
    return models.ResolvedConversationShare(
        kind="conversation",
        conversationTitle=resolved.conversation_title,
        messages=[
            models.SharedMessage(
                id=m.id,
                role=m.role,
                content=m.content,
                reasoning=m.reasoning,
                position=m.position,
            )
            for m in resolved.messages
        ],
        createdAt=resolved.created_at,
    )
