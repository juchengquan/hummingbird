"""`/v1/ai/command` + `/v1/ai/complete` — the rich-text editor's AI
(wave 9, Phase 4; Q101-Q105). Mirrors `app/api/ai/command/handler.ts` and
`app/api/ai/complete/route.ts`; the streams are `editor_ai.command`'s.

Gates, as the Next routes plus what agent-py's anonymous callers get:

* a bearer is verified (a bad one is 401, never anonymous); without one
  the caller is anonymous, refused under `REQUIRE_AUTH_FOR_AI`
  (`401 auth_required`, before the model is touched);
* an anonymous command consumes the runs' anonymous per-IP windows
  (`AnonymousLimits.check_anonymous_call`: shared budget with anonymous
  chat); a signed-in one isn't limited, as on Next;
* every completion is limited per IP, 60 a minute (Next's window);
* models: the allowlist (`400 unknown_model`), absent → the default;
* no `ANTHROPIC_API_KEY` → `503 auth` (the editor's demo fallback, as
  for summarize);
* body caps: the Next routes' (32 MiB, 256 KiB — `body_limit.py`)."""

from __future__ import annotations

from typing import Annotated, Any, NoReturn

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..auth import get_current_user
from ..chat import resolve_anthropic_client
from ..contract import models
from ..editor_ai.command import CommandInput, command_frames, complete_text
from ..editor_ai.prompts import EditorDocument, EditorMessage, EditTarget
from ..model_allowlist import UnknownModelError, resolve_optional_model
from ..rate_limit import SlidingWindow, rate_limit_key
from ..runs.access import RequireAuthConfigError, require_auth_for_ai
from ..runs.wiring import RunServices, get_run_services
from ..settings import Settings, get_settings

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["editor"])

AUTH_REQUIRED_MESSAGE = "Sign in to use AI features on this server."

#: `/api/ai/complete`'s per-IP window: a typist pausing every 2 s makes
#: ~30 a minute; past 60 is hammering.
_COMPLETE_PER_MINUTE = 60
_complete_limit = SlidingWindow(window_ms=60_000, max=_COMPLETE_PER_MINUTE)


def reset_limits() -> None:
    """Forget the completion window (tests)."""
    global _complete_limit
    _complete_limit = SlidingWindow(window_ms=60_000, max=_COMPLETE_PER_MINUTE)


def _text_delay(delay_ms: int) -> float:
    """The joiner's pause after a text chunk, in seconds (tests: 0)."""
    return delay_ms / 1000


def _raise(
    status: int, code: str, message: str, *, headers: dict[str, str] | None = None
) -> NoReturn:
    raise HTTPException(
        status_code=status, detail={"code": code, "message": message}, headers=headers
    )


def editor_caller(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
) -> str | None:
    """The signed-in user's id, or None for an anonymous caller."""
    if authorization is not None:
        return str(get_current_user(authorization, settings)["sub"])
    try:
        gated = require_auth_for_ai(settings)
    except RequireAuthConfigError as exc:
        logger.error("editor_ai.require_auth_config", error=str(exc))
        _raise(500, "unknown", "Server misconfigured.")
    if gated:
        _raise(401, "auth_required", AUTH_REQUIRED_MESSAGE)
    return None


def _model(model_id: str | None) -> str:
    try:
        return resolve_optional_model(model_id)
    except UnknownModelError as exc:
        raise HTTPException(status_code=400, detail=exc.to_detail()) from exc


def _client() -> Any:
    client = resolve_anthropic_client()
    if client is None:
        _raise(503, "auth", "ANTHROPIC_API_KEY is not configured.")
    return client


def _document(doc: models.EditorAiDocument) -> EditorDocument:
    if doc.isSelecting and (doc.edit is None or doc.generateContext is None):
        _raise(400, "invalid_request", "A selecting document needs its edit and generate contexts.")
    return EditorDocument(
        is_selecting=doc.isSelecting,
        generate_context=doc.generateContext,
        edit=EditTarget(kind=doc.edit.kind, context=doc.edit.context) if doc.edit else None,
        comment_context=doc.commentContext,
    )


_SSE_HEADERS = {
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "x-vercel-ai-ui-message-stream": "v1",
    "x-accel-buffering": "no",
}


@router.post(
    "/v1/ai/command",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}},
)
async def ai_command(
    request: Request,
    body: models.EditorAiCommandRequest,
    user_id: Annotated[str | None, Depends(editor_caller)],
    services: Annotated[RunServices, Depends(get_run_services)],
) -> StreamingResponse:
    """Plate's AI menu: generate, edit or comment, streamed as the AI SDK
    UI message stream (`editor_ai.command`)."""
    if user_id is None:
        refusal = services.limits.check_anonymous_call(rate_limit_key(request))
        if refusal is not None:
            _raise(
                429,
                "rate_limit",
                refusal.message,
                headers={"Retry-After": str(refusal.retry_after_sec)},
            )
    document = _document(body.document)
    if body.toolName == "edit" and document.edit is None:
        _raise(400, "invalid_request", "Edit needs a selection.")
    model = _model(body.model)
    client = _client()
    command = CommandInput(
        messages=tuple(
            EditorMessage(
                role=m.role,
                texts=tuple(p.text or "" for p in m.parts if p.type == "text"),
            )
            for m in body.messages
        ),
        document=document,
        tool_name=body.toolName,
    )
    return StreamingResponse(
        command_frames(
            client=client,
            model=model,
            request=command,
            delay=lambda ms: _text_delay(ms),
        ),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.post(
    "/v1/ai/complete",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/plain": {"schema": {"type": "string"}}}}},
)
async def ai_complete(
    request: Request,
    body: models.EditorAiCompleteRequest,
    _user_id: Annotated[str | None, Depends(editor_caller)],
) -> StreamingResponse:
    """Ghost-text autocomplete: a short continuation of `blockText`, as text."""
    verdict = _complete_limit.consume(rate_limit_key(request))
    if not verdict.allowed:
        _raise(
            429,
            "rate_limit",
            f"Too many completion requests. Retry in {verdict.retry_after_sec}s.",
            headers={"Retry-After": str(verdict.retry_after_sec)},
        )
    model = _model(body.model)
    client = _client()
    return StreamingResponse(
        complete_text(client=client, model=model, block_text=body.blockText, prefix=body.prefix),
        media_type="text/plain; charset=utf-8",
    )


__all__ = ["reset_limits", "router"]
