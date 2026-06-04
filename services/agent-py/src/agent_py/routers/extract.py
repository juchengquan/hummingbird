"""`/v1/extract` — multipart text-from-file extraction. Mirrors
`app/api/extract/route.ts`.
"""

from __future__ import annotations

from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel

from ..auth import get_current_user
from ..extraction import ExtractionKind, extract_file

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["extraction"])


class ExtractionResponse(BaseModel):
    """Mirrors `ExtractionResponseSchema` in
    `lib/shared/api-schemas.ts` for kind / text / truncated / language.
    Keeps snake_case on `full_text` to match the rest of the Python
    service's wire format (see `WhoAmIResponse.user_id`); the
    generated TS types reflect that so the Phase 4 cutover doesn't
    have to recase fields."""

    kind: ExtractionKind
    text: str
    truncated: bool
    full_text: str | None = None
    language: str | None = None


@router.post("/v1/extract", response_model=ExtractionResponse)
async def extract(
    _claims: Annotated[dict[str, object], Depends(get_current_user)],
    file: Annotated[UploadFile, File(description="The uploaded file to extract text from.")],
) -> ExtractionResponse:
    """Extract text from an uploaded file. Mirrors
    `app/api/extract/route.ts` — accepts multipart/form-data with
    a `file` field and returns a structured `ExtractionResponse`
    matching `ExtractionResponseSchema` on the TS side.

    Auth-protected (JWT) — Phase 4 cuts the frontend over to this
    endpoint, at which point the existing Next.js route can be
    deleted. Until then both producers exist and the wire schema
    keeps them aligned.

    File-size cap matches the Next.js side (`FILE_SIZE_LIMIT` in
    `lib/shared/upload-config.ts`); FastAPI enforces multipart size
    at the framework level. A read failure surfaces as 500 with
    the parser's error message so the frontend can show it to the
    user without trying to recover.
    """
    try:
        data = await file.read()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Could not read uploaded file: {exc}",
        ) from exc

    try:
        result = extract_file(
            name=file.filename or "unnamed",
            mime_type=file.content_type or "",
            data=data,
        )
    except Exception as exc:  # broad on purpose — see comment
        # Any extractor crash is unexpected — the extractors swallow
        # known per-format failures. Mirrors the TS route's 500 on
        # `error.message`.
        logger.warning("extract.failed", error=str(exc), filename=file.filename)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc) or "Extraction failed.",
        ) from exc

    return ExtractionResponse(
        kind=result.kind,
        text=result.text,
        truncated=result.truncated,
        full_text=result.full_text,
        language=result.language,
    )
