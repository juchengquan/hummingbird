"""FastAPI application entry point.

Phase 0 shipped the health + auth endpoints; Phase 1 adds the
background `task_jobs` poll loop (dry-run — log + release, never
execute). The poll loop runs as an asyncio task managed by the
FastAPI lifespan: started on app startup, cancelled on shutdown.

Run locally:
    uv run uvicorn agent_py.main:app --reload --port 8000

Run in production (mirrors Dockerfile CMD):
    uv run uvicorn agent_py.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from typing import Annotated

import structlog
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import __version__, db, poller
from .auth import get_current_user
from .chat import (
    AI_SDK_STREAM_HEADER_NAME,
    AI_SDK_STREAM_HEADER_VALUE,
    DEFAULT_MAX_STEPS,
    DEFAULT_MAX_TOKENS,
    ChatConfig,
    ChatFormat,
    ChatMessage,
    chat_stream,
    chat_stream_ai_sdk,
    chat_stream_with_tools,
    chat_stream_with_tools_ai_sdk,
    resolve_anthropic_client,
)
from .extraction import ExtractionKind, extract_file
from .image_storage import sign_storage_path
from .settings import Settings, get_settings
from .tools import ToolDescriptor, default_tool_registry
from .url_fetch import FetchError, fetch_url_bookmark
from .url_validate import normalize_url

logger = structlog.get_logger(__name__)


def create_app(*, enable_poller: bool = True) -> FastAPI:
    """Application factory.

    Kept as a factory (rather than a module-level `app = FastAPI(...)`)
    so tests can spin up an isolated instance per test with overridden
    settings without leaking state across tests.

    `enable_poller` exists for tests that don't want the background
    task interfering with assertions; production callers leave it on.
    """
    settings = get_settings()

    # FastAPI's lifespan takes a callable that returns a context
    # manager. The closure captures `settings` so tests can swap env
    # vars without rebuilding everything.
    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if not enable_poller:
            yield
            return
        await db.init_pool(settings.SUPABASE_DB_URL)
        task: asyncio.Task[int] | None = None
        if settings.SUPABASE_DB_URL:
            task = asyncio.create_task(
                poller.run_poll_loop(settings),
                name="agent-py.poller",
            )
            logger.info(
                "lifespan.poller.started",
                interval=settings.POLL_INTERVAL_SECONDS,
                dry_run=settings.WORKER_DRY_RUN,
            )
        else:
            logger.info("lifespan.poller.skipped", reason="no_supabase_db_url")
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            await db.close_pool()
            logger.info("lifespan.shutdown.complete")

    app = FastAPI(
        title="Hummingbird Agent Service",
        version=__version__,
        description=(
            "Phase 1: health + auth endpoints + a read-only task_jobs poll "
            "loop. See docs/PLAN-agent-api.md for the full phased plan."
        ),
        # /openapi.json is the source of truth for `openapi-typescript`
        # codegen on the Next.js side (see scripts/codegen-agent-types.sh).
        openapi_url="/openapi.json",
        lifespan=lifespan,
    )

    @app.get("/healthz", tags=["meta"], response_model=HealthResponse)
    def healthz() -> HealthResponse:
        """Liveness probe — returns 200 as long as the process is up.

        Does NOT depend on Supabase, the model gateway, or any other
        external service. A failing /healthz means restart the container;
        a failing /readyz means *don't route traffic yet* but the process
        might recover on its own.
        """
        return HealthResponse(status="ok", service=settings.SERVICE_NAME, version=__version__)

    @app.get("/readyz", tags=["meta"], response_model=ReadinessResponse)
    def readyz() -> ReadinessResponse:
        """Readiness probe — reports configured dependencies.

        Phase 0 only reported config presence; Phase 1 additionally
        reports whether the Postgres pool is open (which is the closest
        we get to "Postgres reachable" without a per-request `SELECT 1`).
        Phase 2+ may add a `SELECT 1` if we see false-positive ready.
        """
        return ReadinessResponse(
            status="ok",
            checks=ReadinessChecks(
                supabase_url_configured=bool(settings.SUPABASE_URL),
                supabase_db_configured=bool(settings.SUPABASE_DB_URL),
                jwt_secret_configured=bool(settings.SUPABASE_JWT_SECRET),
                db_pool_open=db.has_pool(),
            ),
        )

    @app.post(
        "/v1/extract",
        tags=["extraction"],
        response_model=ExtractionResponse,
    )
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

    @app.post("/v1/chat", tags=["chat"])
    async def chat(
        request: Request,
        body: ChatRequest,
        _claims: Annotated[dict[str, object], Depends(get_current_user)],
        format: ChatFormat = "custom",
    ) -> StreamingResponse:
        """Streaming chat endpoint — Phase 4-1 of PLAN-agent-api.

        Mirrors `app/api/chat/route.ts` on the TS side. Accepts a
        narrow request (messages + model + optional system prompt
        + optional max_tokens) and streams Anthropic deltas back as
        SSE frames.

        Wire format is selectable via the `?format=` query parameter:

          - `format=custom` (default) — `{type:"text|error|done"}`
            frames that match the existing Next.js chat consumer
            (`use-chat-send.ts`). Phase 4-1 + 4-2 baseline so the
            selector can swap between TS and Python without changing
            the consumer.

          - `format=ai-sdk` — Phase 3g — AI SDK v5 UI message stream
            (`start`/`text-start`/`text-delta`/`text-end`/`finish` +
            `[DONE]` terminator), so a consumer using
            `@ai-sdk/react`'s `useChat()` can read Python output
            natively. Response adds the
            `x-vercel-ai-ui-message-stream: v1` header the SDK uses
            to advertise its protocol version.

        Phase 4-1 is **text-only**: tools / skills / attachments /
        MCP all deferred. The Python service already has the
        agent-loop machinery for tool use (Phase 2b-2 + 3c+);
        wiring it into the streaming chat path lands in Phase 4-3+.

        Returns 503 when `ANTHROPIC_API_KEY` is unset — fast-fail
        signal to monitoring that the deploy is misconfigured rather
        than a silent stub response."""
        client = resolve_anthropic_client()
        if client is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="ANTHROPIC_API_KEY is not configured on the agent service.",
            )

        # Phase 4-3: optionally register the built-in tools when the
        # caller flips `enable_tools`. The default registry only
        # includes context-free tools (e.g. `webFetch`) when no DB
        # pool is wired in here — `/v1/chat` is request-scoped and
        # doesn't currently carry a pool / user_id / workspace_id
        # through to ToolContext. Tools that need RLS impersonation
        # (`searchFiles`) and MCP can land in a follow-up that
        # threads the pool through.
        tools: tuple[ToolDescriptor, ...] = ()
        if body.enable_tools:
            tools = tuple(default_tool_registry(context=None).values())

        config = ChatConfig(
            model=body.model,
            messages=[ChatMessage(role=m.role, content=m.content) for m in body.messages],
            system=body.system,
            max_tokens=body.max_tokens or DEFAULT_MAX_TOKENS,
            tools=tools,
            max_steps=body.max_steps or DEFAULT_MAX_STEPS,
        )

        if tools:
            stream_gen = (
                chat_stream_with_tools_ai_sdk(client=client, config=config)
                if format == "ai-sdk"
                else chat_stream_with_tools(client=client, config=config)
            )
        else:
            stream_gen = (
                chat_stream_ai_sdk(client=client, config=config)
                if format == "ai-sdk"
                else chat_stream(client=client, config=config)
            )

        async def event_source() -> AsyncIterator[bytes]:
            async for frame in stream_gen:
                # Bail early if the caller already hung up — saves a
                # round-trip's worth of unnecessary tokens.
                if await request.is_disconnected():
                    logger.info(
                        "chat.client_disconnected",
                        model=body.model,
                        format=format,
                    )
                    return
                yield frame.encode("utf-8")

        # `text/event-stream` triggers SSE handling in browser EventSource
        # / the existing Next.js consumer. Cache-Control + Connection
        # headers match what production proxies (nginx, Cloudflare) need
        # to keep the stream from being buffered.
        headers = {
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
        if format == "ai-sdk":
            # `useChat()` checks this header to confirm the response
            # speaks the AI SDK UI message stream protocol. Mirrors
            # `UI_MESSAGE_STREAM_HEADERS` in the `ai` package.
            headers[AI_SDK_STREAM_HEADER_NAME] = AI_SDK_STREAM_HEADER_VALUE

        return StreamingResponse(
            event_source(),
            media_type="text/event-stream",
            headers=headers,
        )

    @app.post("/v1/url/fetch", tags=["url"])
    async def url_fetch(
        body: UrlFetchRequest,
        _claims: Annotated[dict[str, object], Depends(get_current_user)],
    ) -> UrlFetchResponse:
        """Fetch + extract a URL as a bookmark snapshot. Phase 4-4-a
        of PLAN-agent-api — Python mirror of `app/api/url/fetch/route.ts`.

        Pipeline:
          1. Normalise the URL (prepend https:// for bare-domain
             input, lowercase host, strip fragment).
          2. SSRF gate — scheme allowlist, textual hostname blocklist,
             DNS rebinding defence (resolve + private-IP check).
          3. Fetch with 10s timeout, manual redirect handling (5 hops
             max, each re-validated), 5 MB body cap.
          4. Extract title / content / description / favicon via lxml.

        Error → status mapping mirrors the TS path: validation /
        unsupported_content_type → 400, timeout → 408, body_too_large
        → 413, http_error / too_many_redirects / network → 502.
        """
        normalized = normalize_url(body.url)
        if normalized is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "invalid_url", "message": "URL is not parseable"},
            )
        result = await fetch_url_bookmark(normalized)
        if isinstance(result, FetchError):
            # Translate the structured error to the documented HTTP
            # status code. Mirrors the TS route's `httpStatusFor`.
            raise HTTPException(
                status_code=_url_fetch_error_status(result.code),
                detail={
                    "code": result.code,
                    "message": result.message,
                    **({"status": result.status} if result.status is not None else {}),
                },
            )
        snap = result.snapshot
        if snap is None:
            # Belt-and-braces — `FetchOk` always carries a snapshot
            # in practice, but the typed shape is `BookmarkSnapshot |
            # None` so guard anyway.
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={"code": "missing_snapshot", "message": "Empty fetch result."},
            )
        return UrlFetchResponse(
            ok=True,
            bookmark=BookmarkSnapshotModel(
                url=snap.url,
                title=snap.title,
                content=snap.content,
                content_truncated=snap.content_truncated,
                content_hash=snap.content_hash,
                description=snap.description,
                favicon_url=snap.favicon_url,
            ),
        )

    @app.post("/v1/images/refresh-url", tags=["images"])
    async def images_refresh_url(
        body: RefreshImageUrlRequest,
        claims: Annotated[dict[str, object], Depends(get_current_user)],
    ) -> RefreshImageUrlResponse:
        """Re-sign an expired generated-image URL. Phase 4-4-a of
        PLAN-agent-api — Python mirror of
        `app/api/images/refresh-url/route.ts`.

        Authorisation: the bucket layout is `<user_id>/...` (see
        `0003_storage.sql`); we reject any `storage_path` whose first
        segment doesn't match the JWT's `sub` claim before touching
        Storage. RLS would also reject the call but a clean 403 is
        friendlier than fighting an opaque Storage error.

        Returns 404 when the object doesn't exist OR Storage isn't
        configured (both look the same from the API's perspective).
        """
        user_id = claims.get("sub")
        if not isinstance(user_id, str) or not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"code": "auth", "message": "Token has no subject."},
            )

        first_segment = body.storage_path.split("/", 1)[0]
        if first_segment != user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "forbidden",
                    "message": "Storage path does not belong to you.",
                },
            )

        url = await sign_storage_path(body.storage_path)
        if url is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={
                    "code": "not_found",
                    "message": ("Could not re-sign the URL — object may be missing."),
                },
            )
        return RefreshImageUrlResponse(url=url)

    @app.get("/v1/whoami", tags=["auth"], response_model=WhoAmIResponse)
    def whoami(
        claims: Annotated[dict[str, object], Depends(get_current_user)],
    ) -> WhoAmIResponse:
        """Auth smoke test — echoes the verified claims (minus secrets).

        Useful during Phase 0 deployment to confirm the JWT secret and
        the Authorization-header plumbing work end-to-end before any
        real endpoints exist. Deliberately under `/v1` so the prefix
        convention exists from day one.
        """
        sub = claims.get("sub")
        role = claims.get("role")
        return WhoAmIResponse(
            user_id=str(sub) if sub is not None else None,
            role=str(role) if role is not None else None,
        )

    return app


# --- Response models --------------------------------------------------------


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str


class ReadinessChecks(BaseModel):
    supabase_url_configured: bool
    supabase_db_configured: bool
    jwt_secret_configured: bool
    db_pool_open: bool


class ReadinessResponse(BaseModel):
    status: str
    checks: ReadinessChecks


class WhoAmIResponse(BaseModel):
    user_id: str | None
    role: str | None


class ChatMessageRequest(BaseModel):
    """One message in the chat history. Tight: role is restricted to
    `user` / `assistant`, content is a flat string. The TS chat schema
    supports multimodal content parts; the Python endpoint accepts a
    narrower shape for now and grows it when tool support lands
    (Phase 4-2)."""

    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=200_000)


class ChatRequest(BaseModel):
    """Wire shape for POST /v1/chat. Mirrors the subset of
    `ChatRequestSchema` (TS) we honour today — messages + model +
    workspaceSystemPrompt + maxSteps proxied as `max_tokens`. Skills /
    attachments / MCP / referenceImage deferred.

    Phase 4-3 adds `enable_tools` (opt-in): when true, the route
    registers the built-in tool set (`webFetch`, plus the
    `TAVILY_API_KEY`/`MINIMAX_CN_API_KEY`-gated tools) and loops
    `messages.stream` + tool execution. Default false keeps the
    text-only Phase 4-1 behaviour."""

    messages: list[ChatMessageRequest] = Field(min_length=1, max_length=200)
    model: str = Field(min_length=1, max_length=100)
    system: str | None = Field(default=None, max_length=20_000)
    max_tokens: int | None = Field(default=None, ge=1, le=64_000)
    enable_tools: bool = False
    max_steps: int | None = Field(default=None, ge=1, le=20)


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


# --- /v1/url/fetch -------------------------------------------------------


class UrlFetchRequest(BaseModel):
    """Mirrors the TS `{ url }` body schema. Length capped to defeat
    pathological inputs — the SSRF gate runs after this."""

    url: str = Field(min_length=1, max_length=2000)


class BookmarkSnapshotModel(BaseModel):
    """Mirrors `BookmarkSnapshot` in `lib/server/url/fetch.ts`. Kept
    snake_case on the wire to match the rest of the Python service's
    convention (see `ExtractionResponse.full_text`)."""

    url: str
    title: str
    content: str
    content_truncated: bool
    content_hash: str
    description: str | None = None
    favicon_url: str | None = None


class UrlFetchResponse(BaseModel):
    ok: bool
    bookmark: BookmarkSnapshotModel


def _url_fetch_error_status(code: str) -> int:
    """Translate `FetchError.code` to its HTTP status. Mirrors
    `httpStatusFor` in the TS route."""
    if code in ("validation", "unsupported_content_type"):
        return status.HTTP_400_BAD_REQUEST
    if code == "timeout":
        return status.HTTP_408_REQUEST_TIMEOUT
    if code == "body_too_large":
        return status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
    if code in ("too_many_redirects", "http_error", "network"):
        return status.HTTP_502_BAD_GATEWAY
    return status.HTTP_500_INTERNAL_SERVER_ERROR


# --- /v1/images/refresh-url ---------------------------------------------


class RefreshImageUrlRequest(BaseModel):
    """Mirrors `RefreshImageUrlRequestSchema` in
    `lib/shared/api-schemas.ts`. The TS field is `storagePath`; the
    Python wire uses `storage_path` to match the rest of the
    service's convention."""

    storage_path: str = Field(min_length=1, max_length=1000)


class RefreshImageUrlResponse(BaseModel):
    url: str


# Module-level app for `uvicorn agent_py.main:app`. Tests use `create_app()`
# directly so they get a fresh instance.
app = create_app()


# Re-exports for typed Depends() in callers (mostly tests today; route handlers
# in Phase 2+).
__all__ = ["Settings", "app", "create_app"]
