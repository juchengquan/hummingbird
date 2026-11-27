"""`/v1/extract` — multipart text-from-file extraction. Mirrors
`app/api/extract/route.ts`.

Signed in or anonymous (wave 12, Q123/Q134 — `caller.optional_caller_ungated`):
text extraction spends no model budget, so an anonymous caller is served
even under `REQUIRE_AUTH_FOR_AI`, but without the vision pass. As on Next:

* anonymous callers: 60 extractions per IP per minute (signed-in callers
  aren't limited here — agent-py's signed-in limits are unchanged);
* the PDF vision pass (`extraction_vision`): 10 per IP per minute, every
  caller; past it, or on any failure, the text-only result;
* results cached by file content + effective vision mode
  (`response_cache`), a degraded one (`budget_denied` / `failed`) never.
"""

from __future__ import annotations

import hashlib
from typing import Annotated, Literal

import structlog
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool

from ..caller import AnonymousWindow, Caller, optional_caller_ungated
from ..chat import resolve_anthropic_client
from ..contract import models
from ..extraction import ExtractionResult, extract_file
from ..extraction_vision import (
    VisionMode,
    extract_with_vision,
    maybe_add_vision,
    render_pdf_pages,
    resolve_vision_model,
    transcribe_page,
)
from ..model_allowlist import get_model_allowlist
from ..rate_limit import SlidingWindow
from ..response_cache import get_response_cache, response_cache_key
from ..settings import get_settings
from ..zip_guard import ZipLimitError

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["extraction"])


#: Next's `extractTextLimit` (60 per IP per minute) — on anonymous callers.
TEXT_PER_MINUTE = 60
#: Next's `extractVisionLimit` (10 per IP per minute) — on every caller.
VISION_PER_MINUTE = 10
_text_limit = AnonymousWindow(per_minute=TEXT_PER_MINUTE, message="Too many extraction requests.")
_vision_limit = SlidingWindow(window_ms=60_000, max=VISION_PER_MINUTE)


def reset_limits() -> None:
    """Forget both windows (tests)."""
    global _vision_limit
    _text_limit.reset()
    _vision_limit = SlidingWindow(window_ms=60_000, max=VISION_PER_MINUTE)


def effective_vision_mode(requested: str | None, denied: bool) -> VisionMode:
    """`effectiveVisionMode`: the `vision` field, forced `off` when the
    sign-in gate denies vision."""
    if denied or requested == "false":
        return "off"
    return "on" if requested == "true" else "auto"


def _resolve_vision_model() -> str | None:
    return resolve_vision_model(get_model_allowlist(), get_settings().VISION_MODEL)


async def _run_vision(data: bytes, model_id: str) -> str:
    """Render + transcribe every page on `model_id` (a catalog id)."""
    target = get_model_allowlist().target(model_id)
    client = resolve_anthropic_client(target)
    if client is None:
        raise RuntimeError(f"No provider for {model_id} is configured.")
    pages = await run_in_threadpool(render_pdf_pages, data)

    async def transcribe(png: bytes, _page: int) -> str:
        return await transcribe_page(client, target.api_id, png)

    return await extract_with_vision(data, render=lambda _d: pages, transcribe=transcribe)


def _wire(result: ExtractionResult) -> models.ExtractionResponse:
    return models.ExtractionResponse(
        kind=result.kind,
        text=result.text,
        truncated=result.truncated,
        fullText=result.full_text,
        language=result.language,
    )


_READ_CHUNK_BYTES = 64 * 1024


async def _read_capped(file: UploadFile, max_bytes: int) -> bytes:
    """Read an upload in chunks, raising 413 as soon as it exceeds
    `max_bytes`. Never holds more than `max_bytes + chunk` in memory."""
    if file.size is not None and file.size > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail={"code": "payload_too_large", "message": "File too large."},
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
                    detail={"code": "payload_too_large", "message": "File too large."},
                )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("extract.read_failed", error=str(exc), filename=file.filename)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_request", "message": "Could not read uploaded file."},
        ) from exc
    return bytes(buf)


@router.post(
    "/v1/extract", response_model=models.ExtractionResponse, response_model_exclude_none=True
)
async def extract(
    caller: Annotated[Caller, Depends(optional_caller_ungated)],
    file: Annotated[UploadFile, File(description="The uploaded file to extract text from.")],
    vision: Annotated[
        Literal["true", "false"] | None,
        Form(description="Force the PDF vision pass on or off; absent → auto."),
    ] = None,
) -> models.ExtractionResponse:
    """Extract text from an uploaded file. Mirrors
    `app/api/extract/route.ts` — accepts multipart/form-data with
    a `file` field and returns a structured `ExtractionResponse`
    matching `ExtractionResponseSchema` on the TS side.

    Signed in or anonymous; the limits, the vision pass and the cache
    are in the module docstring. `fullText` is camelCase, as the
    contract's `ExtractionResponse` (and the browser) read it.

    File-size cap (`EXTRACT_MAX_BYTES`, default 5 MB) matches the
    Next.js side (`FILE_SIZE_LIMIT` in `lib/shared/upload-config.ts`);
    the upload is read in chunks and anything larger is rejected with
    413 before extraction runs. Extraction itself is CPU-bound
    (PDF / DOCX / XLSX parsing), so it runs in a worker thread to keep
    the event loop serving other requests. An extractor crash surfaces
    as 500 with the parser's error message so the frontend can show it
    to the user without trying to recover.
    """
    _text_limit.check(caller)
    max_bytes = get_settings().EXTRACT_MAX_BYTES
    data = await _read_capped(file, max_bytes)
    name = file.filename or "unnamed"
    mime_type = file.content_type or ""
    mode = effective_vision_mode(vision, caller.ai_denied)

    # Exact-key cache (as the Next route's): the effective vision mode is a
    # key part, so a caller denied vision never gets a cached vision result.
    cache = get_response_cache()
    cache_key = response_cache_key(
        kind="extract",
        model="-",
        input={
            "name": name,
            "mimeType": mime_type,
            "contentHash": hashlib.sha256(data).hexdigest(),
            "vision": mode,
        },
    )
    cached = cache.get(cache_key)
    if cached is not None:
        return models.ExtractionResponse.model_validate(cached)

    try:
        result = await run_in_threadpool(
            extract_file,
            name=name,
            mime_type=mime_type,
            data=data,
        )
    except ZipLimitError as exc:
        # Office zip whose entry count / real inflated size exceeds the
        # zip-bomb guard (`zip_guard.py`). 413, like the TS route.
        logger.warning("extract.zip_limit", error=str(exc), filename=file.filename)
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail={"code": "payload_too_large", "message": str(exc)},
        ) from exc
    except Exception as exc:  # broad on purpose — see comment
        # Any extractor crash is unexpected — the extractors swallow
        # known per-format failures. Mirrors the TS route's 500 on
        # `error.message`.
        logger.warning("extract.failed", error=str(exc), filename=file.filename)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "unknown", "message": str(exc) or "Extraction failed."},
        ) from exc

    result, outcome = await maybe_add_vision(
        result,
        data,
        mode=mode,
        resolve_model=_resolve_vision_model,
        consume_budget=lambda: _vision_limit.consume(f"ip:{caller.client_key}").allowed,
        run_vision=_run_vision,
    )
    wire = _wire(result)
    # A result degraded for THIS caller isn't what the key promises.
    if outcome not in ("budget_denied", "failed"):
        cache.set(cache_key, wire.model_dump(exclude_none=True))
    return wire
