"""`/v1/summarize` — discriminated union over file / conversation /
compress / project-breakdown modes. Mirrors `app/api/summarize/route.ts`.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import get_current_user
from ..chat import ChatMessage, resolve_anthropic_client
from ..model_allowlist import UnknownModelError, resolve_optional_model
from ..summarise import (
    SummariseError,
    summarise_compress,
    summarise_conversation,
    summarise_file,
    summarise_project_breakdown,
)

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
    _claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> dict[str, Any]:
    """Summarisation endpoint — Phase 4-4b of PLAN-agent-api.
    Python mirror of `app/api/summarize/route.ts`.

    Four modes via discriminated union on `mode`: file /
    conversation / compress / project-breakdown. Three return
    JSON; compress returns `{recap: str}` markdown.

    Notable difference from TS: this endpoint only talks to
    Anthropic (no Vercel-gateway routing). `model` is optional; when
    sent it must be an allowed `anthropic/*` catalog id from
    `config/models.json` (else `400 unknown_model`, as on the Next.js
    route). Absent → `AGENT_DEFAULT_MODEL`.
    """
    try:
        model = resolve_optional_model(body.model)
    except UnknownModelError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=exc.to_detail()
        ) from exc

    client = resolve_anthropic_client()
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "auth",
                "message": "ANTHROPIC_API_KEY is not configured.",
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
    return result.payload
