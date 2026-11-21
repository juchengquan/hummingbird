"""`/v1/extract-table` — build a citation table from a research report.
Mirrors `app/api/extract-table/route.ts`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from ..api_errors import categorize_error
from ..auth import get_current_user
from ..chat import resolve_anthropic_client
from ..extract_table import (
    ColumnHint,
    ColumnType,
    ExtractionFailure,
    NumberedSource,
    build_extract_table_prompt,
    extraction_to_citation_table,
    generate_extraction,
)
from ..model_allowlist import UnknownModelError, get_model_allowlist

router = APIRouter(tags=["artifacts"])


# --- Request (mirrors `ExtractTableRequestSchema`) ---------------------


class ExtractTableSource(BaseModel):
    title: Annotated[str, Field(max_length=300)]
    url: Annotated[str, Field(max_length=2000)]
    snippet: Annotated[str, Field(max_length=2000)]


class ExtractTableColumnHint(BaseModel):
    label: Annotated[str, Field(min_length=1, max_length=60)]
    type: ColumnType | None = None


class ExtractTableRequest(BaseModel):
    """Mirrors `ExtractTableRequestSchema` in `lib/shared/api-schemas.ts`
    — camelCase on the wire. `columnHints` entries are a plain label
    (legacy, treated as Text) or `{label, type?}`."""

    model_config = ConfigDict(populate_by_name=True)

    report_text: Annotated[str, Field(alias="reportText", min_length=1, max_length=100_000)]
    sources: Annotated[list[ExtractTableSource], Field(min_length=1, max_length=100)]
    model: Annotated[str | None, Field(max_length=100)] = None
    column_hints: Annotated[
        list[
            Annotated[str, StringConstraints(min_length=1, max_length=60)] | ExtractTableColumnHint
        ]
        | None,
        Field(alias="columnHints", max_length=8),
    ] = None


# --- Response (mirrors `CitationTableSchema`) --------------------------


class CitationTableCitation(BaseModel):
    sourceId: str  # wire name
    quote: str


class CitationTableCell(BaseModel):
    value: str
    citations: list[CitationTableCitation]


class CitationTableColumn(BaseModel):
    id: str
    label: str
    type: ColumnType | None = None


class CitationTableSource(BaseModel):
    id: str
    title: str
    url: str | None = None
    snippet: str | None = None


class CitationTableResponse(BaseModel):
    columns: list[CitationTableColumn]
    rows: list[dict[str, CitationTableCell]]
    sources: list[CitationTableSource]


@router.post(
    "/v1/extract-table",
    response_model=CitationTableResponse,
    # `url` / `snippet` are optional in `CitationTableSourceSchema` —
    # absent, never null.
    response_model_exclude_none=True,
)
async def extract_table(
    body: ExtractTableRequest,
    _claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> CitationTableResponse:
    """Python mirror of `app/api/extract-table/route.ts`.

    Differences from the Next.js route, both shared with `/v1/summarize`:
      - **Models.** This service only calls Anthropic, so `model` must be
        an allowed `anthropic/*` id from `config/models.json` (else 400
        `unknown_model`, the Next.js code); absent → `AGENT_DEFAULT_MODEL`
        instead of the Next.js route's `google/gemini-2.5-flash`.
      - **No provider key** → 503 `auth` (this service's convention for a
        missing `ANTHROPIC_API_KEY`) where the Next.js route answers 401
        `auth`.

    Everything else matches: structured output first when the catalog
    flags the model `supportsStructuredOutput`, then the lenient JSON
    text path; unparseable / off-schema output → 502 `provider`; a
    provider error → `categorize_error` (port of `categorizeError`).
    Sign-in is always required — like every agent-py AI route, there is
    no anonymous mode here.
    """
    allowlist = get_model_allowlist()
    try:
        api_model = allowlist.resolve_optional(body.model)
    except UnknownModelError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=exc.to_detail()
        ) from exc

    client = resolve_anthropic_client()
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "auth", "message": "ANTHROPIC_API_KEY is not configured."},
        )

    numbered = [
        NumberedSource(id=f"s{i + 1}", title=s.title, url=s.url, snippet=s.snippet)
        for i, s in enumerate(body.sources)
    ]
    hints: list[ColumnHint | str] | None = (
        None
        if body.column_hints is None
        else [
            h if isinstance(h, str) else ColumnHint(label=h.label, type=h.type)
            for h in body.column_hints
        ]
    )
    prompt = build_extract_table_prompt(body.report_text, numbered, hints)

    try:
        outcome = await generate_extraction(
            client=client,
            model=api_model,
            prompt=prompt,
            structured=allowlist.supports_structured_output(body.model),
        )
    except Exception as exc:
        categorized = categorize_error(exc)
        raise HTTPException(status_code=categorized.status, detail=categorized.to_detail()) from exc

    if isinstance(outcome, ExtractionFailure):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "provider", "message": outcome.message},
        )
    return CitationTableResponse.model_validate(extraction_to_citation_table(outcome, numbered))
