"""`/v1/extract` — multipart text-from-file extraction. Mirrors
`app/api/extract/route.ts`.
"""

from __future__ import annotations

from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from ..auth import get_current_user
from ..extraction import ExtractionKind, extract_file
from ..settings import get_settings
from ..zip_guard import ZipLimitError

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


_READ_CHUNK_BYTES = 64 * 1024


async def _read_capped(file: UploadFile, max_bytes: int) -> bytes:
    """Read an upload in chunks, raising 413 as soon as it exceeds
    `max_bytes`. Never holds more than `max_bytes + chunk` in memory."""
    if file.size is not None and file.size > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="File too large.",
        )
    buf = bytearray()
    try:
        while True:
            chunk = await file.read(_READ_CHUNK_BYTES)
            if not chunk:
                break
            buf.extend(chunk)
            if len(buf) > max_bytes:
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail="File too large.",
                )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("extract.read_failed", error=str(exc), filename=file.filename)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not read uploaded file.",
        ) from exc
    return bytes(buf)


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

    File-size cap (`EXTRACT_MAX_BYTES`, default 5 MB) matches the
    Next.js side (`FILE_SIZE_LIMIT` in `lib/shared/upload-config.ts`);
    the upload is read in chunks and anything larger is rejected with
    413 before extraction runs. Extraction itself is CPU-bound
    (PDF / DOCX / XLSX parsing), so it runs in a worker thread to keep
    the event loop serving other requests. An extractor crash surfaces
    as 500 with the parser's error message so the frontend can show it
    to the user without trying to recover.
    """
    max_bytes = get_settings().EXTRACT_MAX_BYTES
    data = await _read_capped(file, max_bytes)

    try:
        result = await run_in_threadpool(
            extract_file,
            name=file.filename or "unnamed",
            mime_type=file.content_type or "",
            data=data,
        )
    except ZipLimitError as exc:
        # Office zip whose entry count / real inflated size exceeds the
        # zip-bomb guard (`zip_guard.py`). 413, like the TS route.
        logger.warning("extract.zip_limit", error=str(exc), filename=file.filename)
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=str(exc),
        ) from exc
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
