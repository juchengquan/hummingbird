"""Share-link data access: create / revoke (as the user) and the public
resolve (as the service).

Python mirror of `app/api/share/route.ts`, `app/api/share/[token]/route.ts`
and `lib/server/share/resolve.ts`. The router (`routers/share.py`) maps
the results onto HTTP answers.

Two access modes, mirroring the Next.js split between the user's
Supabase client and the service-role admin client:

- **create / revoke** run inside a transaction under the caller's
  identity (`store._set_user_context`), so the `shares` / `conversations`
  / `documents` RLS policies apply exactly as they do for the Next.js
  route's user-scoped client. Every statement also filters on
  `user_id = <caller>` — defence in depth on top of RLS, same as the
  other user-scoped queries in `store.py`.
- **resolve** reads with the pool's own role (RLS bypassed — the
  equivalent of the service-role client), because anonymous viewers have
  no identity to impersonate. The token is the capability; every target
  read is filtered by the *share creator's* `user_id`, so a `shares` row
  pointing at someone else's conversation/document resolves to nothing
  (same belt as `resolveShare`; migration 0031 is the braces).
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

import asyncpg
import structlog

from . import store

logger = structlog.get_logger(__name__)

ShareKind = Literal["conversation", "document"]

# Supabase's PostgREST answers at most `max_rows` (1000 by default) rows per
# request, which is what bounds the Next.js resolver's messages read. The
# public read here is unauthenticated, so keep the same ceiling explicitly.
MAX_SHARED_MESSAGES = 1000


def mint_token() -> str:
    """128 random bits, base64url without padding (22 chars) — the same
    strength and alphabet as `mintToken` in `app/api/share/route.ts`."""
    return secrets.token_urlsafe(16)


# --- create ---------------------------------------------------------------

_OWNED_CONVERSATION_SQL = (
    "SELECT 1 FROM public.conversations WHERE id = $1::uuid AND user_id = $2::uuid"
)
_OWNED_DOCUMENT_SQL = "SELECT 1 FROM public.documents WHERE id = $1::uuid AND user_id = $2::uuid"
_INSERT_SHARE_SQL = (
    "INSERT INTO public.shares (token, user_id, kind, conversation_id, document_id) "
    "VALUES ($1, $2::uuid, $3, $4::uuid, $5::uuid)"
)


@dataclass(frozen=True)
class CreateShareResult:
    """`token` on success; otherwise `error` is `not_found` (the target
    is missing or not the caller's) or `failed` (the insert raised)."""

    token: str | None = None
    error: Literal["not_found", "failed"] | None = None


async def create_share(
    pool: asyncpg.Pool,
    *,
    user_id: str,
    kind: ShareKind,
    target_id: str,
) -> CreateShareResult:
    """Check the caller owns the target, then insert the share row — one
    transaction under the caller's RLS. The ownership check mirrors the
    Next.js route's: RLS would reject the insert anyway (the
    `shares: fk ownership (insert)` policy), but a 404 is a cleaner answer
    than the policy violation."""
    owned_sql = _OWNED_CONVERSATION_SQL if kind == "conversation" else _OWNED_DOCUMENT_SQL
    token = mint_token()
    try:
        async with pool.acquire() as conn, conn.transaction():
            await store._set_user_context(conn, user_id=user_id)
            if await conn.fetchval(owned_sql, target_id, user_id) is None:
                return CreateShareResult(error="not_found")
            # Explicit nulls on the unused side; the
            # `shares_target_matches_kind` check enforces exactly one.
            await conn.execute(
                _INSERT_SHARE_SQL,
                token,
                user_id,
                kind,
                target_id if kind == "conversation" else None,
                target_id if kind == "document" else None,
            )
    except Exception as exc:
        logger.warning("shares.create_failed", kind=kind, error=str(exc))
        return CreateShareResult(error="failed")
    return CreateShareResult(token=token)


# --- revoke ---------------------------------------------------------------

# Like the Next.js route, no `revoked_at IS NULL` filter: revoking an
# already-revoked share succeeds again (and re-stamps the time).
_REVOKE_SHARE_SQL = (
    "UPDATE public.shares SET revoked_at = now() "
    "WHERE token = $1 AND user_id = $2::uuid RETURNING token"
)


async def revoke_share(pool: asyncpg.Pool, *, user_id: str, token: str) -> bool:
    """Stamp `revoked_at` on the caller's share. True when a row matched;
    False when none did — a wrong token and another user's token look the
    same. Raises on a database error (the router answers 500)."""
    async with pool.acquire() as conn, conn.transaction():
        await store._set_user_context(conn, user_id=user_id)
        row = await conn.fetchrow(_REVOKE_SHARE_SQL, token, user_id)
    return row is not None


# --- resolve (public) ------------------------------------------------------


@dataclass(frozen=True)
class SharedMessage:
    id: str
    role: Literal["user", "assistant"]
    content: str
    reasoning: str | None
    position: int


@dataclass(frozen=True)
class ResolvedConversationShare:
    conversation_title: str
    messages: list[SharedMessage]
    created_at: datetime
    kind: Literal["conversation"] = "conversation"


@dataclass(frozen=True)
class ResolvedDocumentShare:
    document_title: str
    document_content: str
    created_at: datetime
    kind: Literal["document"] = "document"


ResolvedShare = ResolvedConversationShare | ResolvedDocumentShare

_SHARE_SQL = (
    "SELECT user_id::text AS user_id, kind, conversation_id::text AS conversation_id, "
    "document_id::text AS document_id, created_at, revoked_at "
    "FROM public.shares WHERE token = $1"
)
_DOCUMENT_SQL = (
    "SELECT title, content FROM public.documents WHERE id = $1::uuid AND user_id = $2::uuid"
)
_CONVERSATION_SQL = (
    "SELECT title FROM public.conversations WHERE id = $1::uuid AND user_id = $2::uuid"
)
_MESSAGES_SQL = (
    "SELECT id::text AS id, role, content, reasoning, position FROM public.messages "
    "WHERE conversation_id = $1::uuid AND user_id = $2::uuid "
    f"ORDER BY position ASC LIMIT {MAX_SHARED_MESSAGES}"
)


async def resolve_share(pool: asyncpg.Pool, token: str) -> ResolvedShare | None:
    """Resolve a public share token. None — which the router turns into
    one indistinguishable 404 — when, exactly as in `resolveShare`:

    - the token matches no row;
    - the share is revoked;
    - the share has no owner;
    - its target id is missing, or the target doesn't exist / isn't owned
      by the share's creator;
    - any read fails.

    Only the fields the share pages render come back — never a user id.
    Reads run in one read-only transaction so the share row and its
    target are a consistent snapshot."""
    try:
        async with pool.acquire() as conn, conn.transaction(readonly=True):
            return await _resolve(conn, token)
    except Exception as exc:
        logger.warning("shares.resolve_failed", error=str(exc))
        return None


async def _resolve(conn: asyncpg.Connection, token: str) -> ResolvedShare | None:
    share = await conn.fetchrow(_SHARE_SQL, token)
    if share is None or share["revoked_at"] is not None or not share["user_id"]:
        return None
    owner = share["user_id"]

    if share["kind"] == "document":
        if not share["document_id"]:
            return None
        doc = await conn.fetchrow(_DOCUMENT_SQL, share["document_id"], owner)
        if doc is None:
            return None
        return ResolvedDocumentShare(
            document_title=doc["title"] or "Untitled",
            document_content=doc["content"],
            created_at=share["created_at"],
        )

    # Anything that isn't a document share resolves as a conversation share,
    # as in `resolveShare` (the `kind` check constraint allows only the two).
    if not share["conversation_id"]:
        return None
    conv = await conn.fetchrow(_CONVERSATION_SQL, share["conversation_id"], owner)
    if conv is None:
        return None
    rows = await conn.fetch(_MESSAGES_SQL, share["conversation_id"], owner)
    return ResolvedConversationShare(
        conversation_title=conv["title"],
        messages=[
            SharedMessage(
                id=r["id"],
                role=r["role"],
                content=r["content"],
                reasoning=r["reasoning"],
                position=r["position"],
            )
            for r in rows
        ],
        created_at=share["created_at"],
    )


__all__ = [
    "MAX_SHARED_MESSAGES",
    "CreateShareResult",
    "ResolvedConversationShare",
    "ResolvedDocumentShare",
    "ResolvedShare",
    "SharedMessage",
    "create_share",
    "mint_token",
    "resolve_share",
    "revoke_share",
]
