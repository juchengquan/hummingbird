"""`/v1/chat` — streaming AI SDK v5 UI-message-stream over Anthropic.
Mirrors `app/api/chat/route.ts`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..auth import get_current_user
from ..chat import (
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
from ..db import get_pool, has_pool
from ..mcp_tools import extend_registry_with_mcp
from ..tools import (
    SkillConfigs,
    ToolContext,
    ToolDescriptor,
    default_tool_registry,
)

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["chat"])


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


@router.post("/v1/chat")
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
