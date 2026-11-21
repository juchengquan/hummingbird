"""`/v1/memory/extract` — best-effort post-turn memory extraction.
Mirrors `app/api/memory/extract/route.ts`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from ..auth import get_current_user
from ..chat import resolve_anthropic_client
from ..contract import models
from ..db import get_pool, has_pool
from ..memory_extract import extract_facts, resolve_memory_model
from ..model_allowlist import get_model_allowlist
from ..settings import get_settings

router = APIRouter(tags=["memory"])


@router.post("/v1/memory/extract", response_model=models.MemoryExtractResponse)
async def memory_extract(
    body: models.MemoryExtractRequest,
    claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> models.MemoryExtractResponse:
    """Python mirror of `app/api/memory/extract/route.ts`. Every
    well-formed, authenticated request answers `{ok: true}`; extraction
    runs only when the turn is not `tainted` and the user has
    `profiles.memory_enabled`, and never surfaces a failure.

    Differences from the Next.js route:
      - **Sign-in is always required** (401 without a valid bearer token).
        The Next.js route only 401s under `REQUIRE_AUTH_FOR_AI` and
        otherwise no-ops for anonymous callers.
      - **Model.** `MEMORY_EXTRACT_MODEL` is used only when it is an
        allowed `anthropic/*` id of `config/models.json`; otherwise (and
        when unset — the Next.js default is `google/gemini-2.5-flash`)
        `AGENT_DEFAULT_MODEL`. No `ANTHROPIC_API_KEY` → nothing is
        extracted (still `{ok: true}`), as when the Next.js route's model
        provider is unavailable.
      - **No DB pool** (`SUPABASE_DB_URL` unset) → nothing is extracted
        (still `{ok: true}`), as when Supabase is not configured for the
        Next.js route.
      - An invalid body is FastAPI's 422, not 400.
    """
    user_id = claims.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "auth", "message": "Token has no subject."},
        )
    # A tainted turn (it read attachments / web / MCP / file content) is
    # refused: extracting from it could turn injected text into a durable
    # memory. Same `{ok: true}` answer — extraction is best-effort.
    if body.tainted:
        return models.MemoryExtractResponse(ok=True)
    if not has_pool():
        return models.MemoryExtractResponse(ok=True)

    model = resolve_memory_model(get_model_allowlist(), get_settings().MEMORY_EXTRACT_MODEL)
    await extract_facts(
        get_pool(),
        user_id=user_id,
        turn_text=body.turnText,
        conversation_id=body.conversationId,
        client=resolve_anthropic_client(),
        model=model,
    )
    return models.MemoryExtractResponse(ok=True)
