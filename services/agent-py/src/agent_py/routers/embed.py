"""`/v1/embed` — chunk + embed a file's text into `file_sections`.
Mirrors `app/api/embed/route.ts`.

Signed-out callers are served too (wave 12, Q123/Q134 —
`caller.optional_caller`): refused under `REQUIRE_AUTH_FOR_AI`, limited to
30 calls per IP per minute, and answered `200 skipped / not_signed_in` —
`file_sections` rows belong to a user, so there is nothing to index.
"""

from __future__ import annotations

from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, HTTPException, status

from ..caller import Caller, optional_caller
from ..contract import models
from ..db import get_pool, has_pool
from ..embeddings import (
    EmbeddingError,
    embed_texts,
    embedding_config,
    index_file_sections,
    result_to_wire,
)
from ..rate_limit import SlidingWindow

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["embeddings"])

#: Per-user cap, as on the Next.js route: each call can embed ~1 MB of
#: text (many paid chunks); 30/min still covers a multi-file drop plus the
#: client's `file_not_found` backoff retries. Anonymous callers get the
#: same 30/min, per IP (Q134), in their own `ip:` buckets.
_embed_limit = SlidingWindow(window_ms=60_000, max=30)

#: `EmbedRequestSchema.text` cap. Zod counts UTF-16 code units, Pydantic
#: code points, so the route re-checks in UTF-16 units.
_TEXT_MAX_UTF16_UNITS = 1_200_000


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _consume(key: str) -> None:
    verdict = _embed_limit.consume(key)
    if not verdict.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "rate_limit",
                "message": f"Too many embed requests. Retry in {verdict.retry_after_sec}s.",
            },
            headers={"Retry-After": str(verdict.retry_after_sec)},
        )


@router.post("/v1/embed", response_model=models.EmbedResponse, response_model_exclude_none=True)
async def embed_file(
    body: models.EmbedRequest,
    caller: Annotated[Caller, Depends(optional_caller)],
) -> dict[str, object]:
    """Python mirror of `app/api/embed/route.ts`: same body, same answers —
    `skipped / not_configured` (200) with no embedder, the per-user
    30/min limit (429 + `Retry-After`), `indexFileSections`' outcomes,
    500 `embed_failed` on an embedder / database failure.

    Differences from the Next.js route:
      - A bad bearer is 401 before the body is read, and an invalid body
        is FastAPI's 422, not 400.
      - Signed out it is a `200 skipped / not_signed_in` (limited 30/min
        per IP, refused under `REQUIRE_AUTH_FOR_AI`) where Next answers
        401 `not_signed_in` (Q123: signed-out calls never reach Next).
      - No DB pool (`SUPABASE_DB_URL` unset) with an embedder configured →
        503 `db_unconfigured` (the Next.js route answers 401 when Supabase
        is not configured — it cannot tell the cases apart).
      - The 429 `code` is `rate_limit` (this service's and the contract's
        code) where the Next.js route says `rate_limited`.
    """
    user_id = caller.user_id
    if _utf16_len(body.text) > _TEXT_MAX_UTF16_UNITS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "invalid_request", "message": "Invalid embed request."},
        )

    config = embedding_config()
    if config is None:
        return {"status": "skipped", "sections": 0, "reason": "not_configured"}

    if user_id is None:
        _consume(f"ip:{caller.client_key}")
        return {"status": "skipped", "sections": 0, "reason": "not_signed_in"}

    if not has_pool():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "db_unconfigured",
                "message": "SUPABASE_DB_URL is not configured on the agent service.",
            },
        )

    _consume(f"user:{user_id}")

    async def embed(texts: list[str]) -> list[list[float]]:
        return await embed_texts(texts, config=config)

    try:
        result = await index_file_sections(
            get_pool(),
            user_id=user_id,
            file_id=body.fileId,
            text=body.text,
            embed=embed,
            force=bool(body.force),
        )
    except (EmbeddingError, RuntimeError) as exc:
        logger.warning("embed.failed", file_id=body.fileId, error=str(exc)[:300])
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "embed_failed", "message": str(exc) or "Embedding failed."},
        ) from exc
    except Exception as exc:
        logger.exception("embed.unexpected_error", file_id=body.fileId)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "embed_failed", "message": "Embedding failed."},
        ) from exc
    return result_to_wire(result)
