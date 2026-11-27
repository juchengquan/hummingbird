"""`/v1/summarize` — discriminated union over file / conversation /
compress / project-breakdown modes. Mirrors `app/api/summarize/route.ts`.

Signed in or anonymous (wave 12, Q123/Q134 — `caller.optional_caller`):
an anonymous caller is refused under `REQUIRE_AUTH_FOR_AI`, and gets the
Next route's budget, which is no rate limit; what the route does have is
its response cache (`response_cache`), scoped per caller (the user, else
a hash of the client IP) — exact key, plus a near match on `file` and
title-less `project-breakdown` requests when an embedder is configured.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..caller import Caller, optional_caller
from ..chat import ChatMessage, resolve_anthropic_client
from ..embeddings import embed_texts, embedding_config
from ..model_allowlist import UnknownModelError, resolve_optional_target
from ..response_cache import (
    caller_scope,
    get_response_cache,
    response_cache_key,
    summarize_similarity_target,
)
from ..summarise import (
    SummariseError,
    summarise_compress,
    summarise_conversation,
    summarise_file,
    summarise_project_breakdown,
)

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["summarize"])


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


@router.post("/v1/summarize")
async def summarize(
    body: SummariseRequest,
    caller: Annotated[Caller, Depends(optional_caller)],
) -> dict[str, Any]:
    """Summarisation endpoint — Phase 4-4b of PLAN-agent-api.
    Python mirror of `app/api/summarize/route.ts`.

    Four modes via discriminated union on `mode`: file /
    conversation / compress / project-breakdown. Three return
    JSON; compress returns `{recap: str}` markdown.

    `model` is optional; when sent it must be a catalog id from
    `config/models.json`, served on its provider's route (else `400
    unknown_model`, as on the Next.js
    route). Absent → `AGENT_DEFAULT_MODEL`.
    """
    try:
        target = resolve_optional_target(body.model)
    except UnknownModelError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=exc.to_detail()
        ) from exc

    model = target.api_id

    # The cache (as the Next route's): the body minus `model` is the input,
    # the resolved catalog id a key part of its own, so "model omitted" and
    # "model = the default" share an entry.
    scope = caller_scope(user_id=caller.user_id, client_key=caller.client_key)
    cache = get_response_cache()
    cache_input = body.model_dump(by_alias=True, exclude_none=True, exclude={"model"})
    cache_key = response_cache_key(
        kind="summarize", model=target.catalog_id, input=cache_input, scope=scope
    )
    cached = cache.get(cache_key)
    if cached is not None:
        return dict(cached)
    similarity = summarize_similarity_target(cache_input, target.catalog_id, scope)
    sim_embedding: list[float] | None = None
    config = embedding_config() if similarity is not None else None
    if similarity is not None and config is not None:
        try:
            sim_embedding = (await embed_texts([similarity[1]], config=config))[0]
        except Exception as exc:  # advisory: any failure → run the model
            logger.info("summarize.similarity_skipped", error=type(exc).__name__)
            sim_embedding = None
        if sim_embedding is not None:
            hit = cache.find_similar(scope=similarity[0], embedding=sim_embedding)
            if hit is not None:
                return dict(hit)

    client = resolve_anthropic_client(target)
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "auth",
                "message": f"No provider for {target.catalog_id} is configured.",
            },
        )

    if isinstance(body, FileSummariseBody):
        result = await summarise_file(client=client, model=model, name=body.name, text=body.text)
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
    if similarity is not None and sim_embedding is not None:
        cache.set(cache_key, result.payload, embedding=sim_embedding, scope=similarity[0])
    else:
        cache.set(cache_key, result.payload)
    return result.payload
