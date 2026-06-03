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
from typing import Annotated, Any, Literal

import structlog
from fastapi import (
    Depends,
    FastAPI,
    File,
    Header,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from . import __version__, db, poller
from .auth import get_current_user
from .chat import (
    AI_SDK_STREAM_HEADER_NAME,
    AI_SDK_STREAM_HEADER_VALUE,
    DEFAULT_MAX_STEPS,
    DEFAULT_MAX_TOKENS,
    ChatConfig,
    ChatMessage,
    chat_stream_ai_sdk,
    chat_stream_with_tools_ai_sdk,
    generate_chat_suggestions,
    resolve_anthropic_client,
    sse_frame,
)
from .db import get_pool, has_pool
from .extraction import ExtractionKind, extract_file
from .image_storage import sign_storage_path
from .mcp_client import McpEndpoint
from .mcp_client import call_tool as mcp_call_tool
from .mcp_client import discover as mcp_discover
from .mcp_client import read_resource as mcp_read_resource
from .mcp_credentials import fetch_decrypted_credentials
from .mcp_tools import extend_registry_with_mcp
from .settings import Settings, get_settings
from .summarise import (
    SummariseError,
    summarise_compress,
    summarise_conversation,
    summarise_file,
    summarise_project_breakdown,
)
from .summarise import (
    resolve_model as summarise_resolve_model,
)
from .tools import (
    SkillConfigs,
    ToolContext,
    ToolDescriptor,
    default_tool_registry,
)
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
        claims: Annotated[dict[str, object], Depends(get_current_user)],
    ) -> StreamingResponse:
        """Streaming chat endpoint. Mirrors `app/api/chat/route.ts`
        on the TS side. Accepts a narrow request (messages + model +
        optional system prompt + optional max_tokens) and streams
        Anthropic deltas back as SSE frames in the AI SDK v5 UI
        message stream protocol (what `@ai-sdk/react`'s `useChat()`
        consumes natively). Adds the `x-vercel-ai-ui-message-stream:
        v1` header so the SDK can advertise its protocol version.

        The legacy custom wire format was retired in B.3 of
        PLAN-useChat-adoption.md; the `?format=` query param is
        silently ignored.

        Returns 503 when `ANTHROPIC_API_KEY` is unset — fast-fail
        signal to monitoring that the deploy is misconfigured rather
        than a silent stub response."""
        client = resolve_anthropic_client()
        if client is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="ANTHROPIC_API_KEY is not configured on the agent service.",
            )

        # Phase 4-3 + follow-up: build a per-request `ToolContext`
        # so the context-bound tools (`searchFiles`, cloud-mode MCP)
        # work end-to-end. Pool comes from the lifespan; user_id
        # from the verified JWT sub claim; workspace_id from the
        # request body (optional — without it, MCP discovery
        # silently skips). When the pool is unset (dev / no
        # SUPABASE_DB_URL) we fall back to `context=None` and lose
        # the context-bound tools, matching the pre-follow-up
        # behaviour.
        tools_dict: dict[str, ToolDescriptor] = {}
        if body.enable_tools:
            sub_claim = claims.get("sub")
            user_id: str | None = sub_claim if isinstance(sub_claim, str) else None
            tool_context: ToolContext | None = None
            if has_pool() and user_id:
                tool_context = ToolContext(
                    pool=get_pool(),
                    user_id=user_id,
                    workspace_id=body.workspace_id,
                )
            skill_configs = _collect_skill_configs(body.skills)
            tools_dict = default_tool_registry(
                context=tool_context,
                skill_configs=skill_configs,
            )
            # Cloud-mode MCP — only when we have a workspace_id and
            # a pool. Mirrors the wiring in executor.py.
            if tool_context is not None and tool_context.workspace_id:
                try:
                    await extend_registry_with_mcp(
                        tools_dict,
                        pool=tool_context.pool,
                        user_id=tool_context.user_id,
                        workspace_id=tool_context.workspace_id,
                    )
                except Exception as exc:
                    # MCP discovery failures shouldn't fail the chat
                    # turn — log and continue without MCP tools.
                    logger.warning(
                        "chat.mcp_discovery_failed",
                        error=str(exc),
                        workspace_id=tool_context.workspace_id,
                    )
        tools: tuple[ToolDescriptor, ...] = tuple(tools_dict.values())

        config = ChatConfig(
            model=body.model,
            messages=[ChatMessage(role=m.role, content=m.content) for m in body.messages],
            system=body.system,
            max_tokens=body.max_tokens or DEFAULT_MAX_TOKENS,
            tools=tools,
            max_steps=body.max_steps or DEFAULT_MAX_STEPS,
        )

        # Post-stream chips. Mirrors the Next.js inline route's
        # behaviour: on a successful turn, ask a cheap Haiku call
        # for 3 follow-up questions and emit them as
        # `data-suggestions` parts. Decoration only — failures are
        # swallowed by `generate_chat_suggestions`.
        async def on_complete(assistant_text: str) -> AsyncIterator[str]:
            values = await generate_chat_suggestions(
                client=client,
                history=config.messages,
                assistant_reply=assistant_text,
            )
            if not values:
                return
            yield sse_frame({"type": "data-suggestions", "data": {"values": values}})

        if tools:
            stream_gen = chat_stream_with_tools_ai_sdk(
                client=client, config=config, on_complete=on_complete
            )
        else:
            stream_gen = chat_stream_ai_sdk(client=client, config=config, on_complete=on_complete)

        async def event_source() -> AsyncIterator[bytes]:
            async for frame in stream_gen:
                # Bail early if the caller already hung up — saves a
                # round-trip's worth of unnecessary tokens.
                if await request.is_disconnected():
                    logger.info(
                        "chat.client_disconnected",
                        model=body.model,
                    )
                    return
                yield frame.encode("utf-8")

        # `text/event-stream` triggers SSE handling in browser EventSource
        # / the existing Next.js consumer. Cache-Control + Connection
        # headers match what production proxies (nginx, Cloudflare) need
        # to keep the stream from being buffered. The
        # `x-vercel-ai-ui-message-stream: v1` header is always set
        # so `useChat()` consumers can confirm the protocol.
        headers = {
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            AI_SDK_STREAM_HEADER_NAME: AI_SDK_STREAM_HEADER_VALUE,
        }

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

    @app.post("/v1/summarize", tags=["summarize"])
    async def summarize(
        body: SummariseRequest,
        _claims: Annotated[dict[str, object], Depends(get_current_user)],
    ) -> dict[str, Any]:
        """Summarisation endpoint — Phase 4-4b of PLAN-agent-api.
        Python mirror of `app/api/summarize/route.ts`.

        Four modes via discriminated union on `mode`: file /
        conversation / compress / project-breakdown. Three return
        JSON; compress returns `{recap: str}` markdown.

        Notable difference from TS: this endpoint only talks to
        Anthropic (no Vercel-gateway routing). When the caller's
        `model` doesn't look like an Anthropic id (e.g. the TS
        default `google/gemini-2.5-flash`), we fall back to
        `claude-3-5-haiku-20241022`. Caller behaviour is unaffected
        because the field is still accepted; the TS-shape body comes
        through unchanged.
        """
        client = resolve_anthropic_client()
        if client is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "code": "auth",
                    "message": "ANTHROPIC_API_KEY is not configured.",
                },
            )

        model = summarise_resolve_model(body.model)

        if isinstance(body, FileSummariseBody):
            result = await summarise_file(
                client=client, model=model, name=body.name, text=body.text
            )
        elif isinstance(body, ConversationSummariseBody):
            result = await summarise_conversation(
                client=client,
                model=model,
                messages=[ChatMessage(role=m.role, content=m.content) for m in body.messages],
            )
        elif isinstance(body, CompressSummariseBody):
            result = await summarise_compress(
                client=client,
                model=model,
                messages=[ChatMessage(role=m.role, content=m.content) for m in body.messages],
            )
        else:
            # ProjectBreakdownBody — the remaining variant.
            result = await summarise_project_breakdown(
                client=client,
                model=model,
                goal=body.goal,
                existing_titles=body.existing_titles,
            )

        if isinstance(result, SummariseError):
            # `provider` / `invalid_json` both surface as 502 — the
            # request was valid; the upstream model failed or
            # disobeyed the format. Same mapping the TS route uses.
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={"code": result.code, "message": result.message},
            )
        return result.payload

    @app.post("/v1/mcp/{server_id}/{action}", tags=["mcp"])
    async def mcp_proxy(
        server_id: str,
        action: str,
        body: McpProxyBody,
        claims: Annotated[dict[str, object], Depends(get_current_user)],
        x_mcp_credentials: Annotated[str | None, Header(alias="X-MCP-Credentials")] = None,
    ) -> dict[str, Any]:
        """MCP proxy — Phase 4-4b of PLAN-agent-api. Python mirror of
        `app/api/mcp/[serverId]/[action]/route.ts`.

        Actions:
          - `discover` → returns `{capabilities}` from the MCP
            handshake (tools / resources / prompts).
          - `call` → invokes a tool, returns `{result: {text,
            is_error}}`.
          - `read` → reads a resource by URI, returns `{result:
            {text?, mime_type?}}`.

        Credentials come from two places:
          1. `X-MCP-Credentials` header (local-mode — the client
             attaches the cred from localStorage). Decoded as
             base64-JSON, same shape the TS path expects.
          2. Cloud-mode fallback when no header — looks up the
             server row by id under per-user RLS impersonation,
             decrypts the credential via the SECURITY DEFINER RPC.

        If neither produces a credential and the upstream MCP server
        actually requires auth, the call fails upstream and the
        proxy surfaces it as 502 — same as TS."""
        if action not in ("discover", "call", "read"):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

        # Path / body server id mismatch protects against a buggy
        # client accidentally hitting the wrong server config.
        if body.server.id != server_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "serverId_mismatch", "message": "Path / body id mismatch."},
            )

        credentials = _decode_mcp_credential_header(x_mcp_credentials)
        # Cloud lookup only when the header didn't supply a cred AND
        # we can resolve a user id from the JWT.
        if credentials is None and has_pool():
            user_id = claims.get("sub")
            if isinstance(user_id, str) and user_id:
                credentials = await fetch_decrypted_credentials(
                    get_pool(), user_id=user_id, server_id=server_id
                )

        endpoint = McpEndpoint(id=server_id, name=body.server.name, url=body.server.url)

        try:
            if action == "discover":
                caps = await mcp_discover(endpoint, credentials=credentials)
                return {
                    "capabilities": {
                        "tools": (
                            [
                                {
                                    "name": t.name,
                                    "description": t.description,
                                    "inputSchema": t.input_schema,
                                }
                                for t in caps.tools
                            ]
                            if caps.tools is not None
                            else None
                        ),
                        "resources": (
                            [
                                {
                                    "uri": r.uri,
                                    "name": r.name,
                                    "description": r.description,
                                    "mimeType": r.mime_type,
                                }
                                for r in caps.resources
                            ]
                            if caps.resources is not None
                            else None
                        ),
                        "prompts": (
                            [{"name": p.name, "description": p.description} for p in caps.prompts]
                            if caps.prompts is not None
                            else None
                        ),
                    }
                }
            if action == "call":
                if not body.tool:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail={"code": "invalid_body", "message": "`tool` required."},
                    )
                tool_result = await mcp_call_tool(
                    endpoint, credentials, body.tool, body.input or {}
                )
                return {
                    "result": {
                        "text": tool_result.text,
                        "isError": tool_result.is_error,
                    }
                }
            # action == "read"
            if not body.uri:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail={"code": "invalid_body", "message": "`uri` required."},
                )
            res = await mcp_read_resource(endpoint, credentials, body.uri)
            return {
                "result": {"text": res.text, "mimeType": res.mime_type},
            }
        except HTTPException:
            raise
        except Exception as exc:
            # Never include credentials in error responses.
            logger.warning(
                "mcp.proxy_failed",
                server=server_id,
                action=action,
                error=str(exc),
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={"code": "mcp_call_failed", "message": str(exc)},
            ) from exc

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


class ChatSkillEntry(BaseModel):
    """One entry on `ChatRequest.skills` — the per-skill config the
    client included with this request. Mirrors the TS schema; only
    `id` is required, every config sub-object is optional + permissive
    (extra keys ignored)."""

    model_config = ConfigDict(extra="allow")

    id: str = Field(max_length=40)
    webSearchConfig: dict[str, Any] | None = None
    webFetchConfig: dict[str, Any] | None = None
    imageGenConfig: dict[str, Any] | None = None


class ChatRequest(BaseModel):
    """Wire shape for POST /v1/chat. Mirrors the subset of
    `ChatRequestSchema` (TS) we honour today — messages + model +
    workspaceSystemPrompt + maxSteps proxied as `max_tokens`. Skills /
    attachments / MCP / referenceImage deferred.

    Phase 4-3 adds `enable_tools` (opt-in): when true, the route
    registers the built-in tool set (`webFetch`, plus the
    `TAVILY_API_KEY`/`MINIMAX_CN_API_KEY`-gated tools) and loops
    `messages.stream` + tool execution. Default false keeps the
    text-only Phase 4-1 behaviour.

    Phase 4-3 follow-up: `workspace_id` opts the registry into the
    context-bound tools (`searchFiles` + cloud-mode MCP). `skills[]`
    threads per-skill config (caps, provider toggles) — same shape
    the TS side has used since the Phase 4-2 selector landed."""

    messages: list[ChatMessageRequest] = Field(min_length=1, max_length=200)
    model: str = Field(min_length=1, max_length=100)
    system: str | None = Field(default=None, max_length=20_000)
    max_tokens: int | None = Field(default=None, ge=1, le=64_000)
    enable_tools: bool = False
    max_steps: int | None = Field(default=None, ge=1, le=20)
    workspace_id: str | None = Field(default=None, max_length=64)
    skills: list[ChatSkillEntry] | None = Field(default=None, max_length=20)


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


# --- /v1/summarize ------------------------------------------------------


class SummariseMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=200_000)


class FileSummariseBody(BaseModel):
    mode: Literal["file"]
    name: str | None = Field(default=None, max_length=500)
    text: str = Field(min_length=1, max_length=50_000)
    model: str | None = Field(default=None, max_length=100)


class ConversationSummariseBody(BaseModel):
    mode: Literal["conversation"]
    messages: list[SummariseMessage] = Field(min_length=1, max_length=200)
    model: str | None = Field(default=None, max_length=100)


class CompressSummariseBody(BaseModel):
    mode: Literal["compress"]
    messages: list[SummariseMessage] = Field(min_length=2, max_length=200)
    model: str | None = Field(default=None, max_length=100)


class ProjectBreakdownBody(BaseModel):
    mode: Literal["project-breakdown"]
    goal: str = Field(min_length=1, max_length=4000)
    existing_titles: list[str] | None = Field(default=None, max_length=100, alias="existingTitles")
    model: str | None = Field(default=None, max_length=100)
    model_config = {"populate_by_name": True}


SummariseRequest = Annotated[
    FileSummariseBody | ConversationSummariseBody | CompressSummariseBody | ProjectBreakdownBody,
    Field(discriminator="mode"),
]


def _collect_skill_configs(
    entries: list[ChatSkillEntry] | None,
) -> SkillConfigs:
    """Reduce the request's per-skill list into a `SkillConfigs`
    bundle. The TS schema sends a list keyed by `id` (`{id, webSearchConfig?,
    webFetchConfig?, imageGenConfig?, ...}`); we pick out the
    sub-objects each Python tool factory honours today.

    Tolerant on shape: a list of `null`s / entries with no config
    object reduce to an empty `SkillConfigs`. Each tool clamps its
    own value when it's invalid, so we don't validate here."""
    if not entries:
        return SkillConfigs()
    web_search: dict[str, Any] | None = None
    web_fetch: dict[str, Any] | None = None
    image_gen: dict[str, Any] | None = None
    for entry in entries:
        if entry is None:
            continue
        if entry.webSearchConfig:
            web_search = entry.webSearchConfig
        if entry.webFetchConfig:
            web_fetch = entry.webFetchConfig
        if entry.imageGenConfig:
            image_gen = entry.imageGenConfig
    return SkillConfigs(
        web_search=web_search,
        web_fetch=web_fetch,
        image_gen=image_gen,
    )


# --- /v1/mcp/{server_id}/{action} --------------------------------------


class McpServerBody(BaseModel):
    """Subset of `McpServer` the proxy actually needs. Mirrors the
    TS `ServerSchema` in the route. Transport is fixed at `http`
    matching the DB CHECK constraint."""

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    url: str = Field(min_length=1)
    transport: Literal["http"] = "http"


class McpProxyBody(BaseModel):
    """One body shape for all three actions. `tool` is required for
    `call`, `uri` for `read`; the route validates per-action."""

    server: McpServerBody
    tool: str | None = Field(default=None, min_length=1)
    input: dict[str, Any] | None = None
    uri: str | None = Field(default=None, min_length=1)


def _decode_mcp_credential_header(raw: str | None) -> dict[str, Any] | None:
    """Decode the `X-MCP-Credentials` header. TS uses base64-encoded
    JSON; we accept the same shape so a frontend client can hit the
    Python proxy without changing its serialization. Returns None on
    any decode error — caller may fall through to cloud lookup."""
    if not raw:
        return None
    import base64

    try:
        decoded = base64.b64decode(raw, validate=True).decode("utf-8")
        parsed = __import__("json").loads(decoded)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


# Module-level app for `uvicorn agent_py.main:app`. Tests use `create_app()`
# directly so they get a fresh instance.
app = create_app()


# Re-exports for typed Depends() in callers (mostly tests today; route handlers
# in Phase 2+).
__all__ = ["Settings", "app", "create_app"]
