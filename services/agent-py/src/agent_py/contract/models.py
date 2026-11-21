# DO NOT EDIT — generated from packages/contract/openapi.yaml.
# Regenerate with: bun run contract:gen (packages/contract/scripts/gen.sh).

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class ApiError(BaseModel):
    """
    The error envelope every backend returns on a non-2xx JSON response:
    a stable machine-readable `code` plus a human-readable `message`. The
    client keys typed UI off `code`; `message` is for display only.

    `code` is an open set (new codes are additive). In use today:
    `invalid_request`, `auth`, `auth_required`, `forbidden`, `not_found`,
    `unavailable`, `rate_limit`, `context_window`, `invalid_model`,
    `unknown_model`, `provider`, `aborted`, `unknown`. See
    `lib/shared/api-errors.ts`.

    """

    model_config = ConfigDict(
        extra="allow",
    )
    code: Annotated[str, Field(examples=["auth", "invalid_request", "not_found"], min_length=1)]
    message: str


class Citation(BaseModel):
    sourceId: Annotated[str, Field(min_length=1)]
    quote: Annotated[str, Field(max_length=2000)]


class CitationTable(BaseModel):
    """
    A table artefact whose cells cite quotes from `sources`. See `lib/shared/artifacts/citation-table.ts`.
    """

    columns: Annotated[list[CitationTableColumn], Field(max_length=12, min_length=1)]
    rows: Annotated[list[dict[str, CitationTableCell]], Field(max_length=200)]
    """
    One row is a map of column id to cell. A column with no entry renders as an empty cell.
    """
    sources: Annotated[list[CitationTableSource], Field(max_length=100)]


class CitationTableCell(BaseModel):
    value: Annotated[str, Field(max_length=4000)]
    citations: Annotated[list[Citation] | None, Field(max_length=8, validate_default=True)] = []
    """
    Quote-cited support for the value. May be empty.
    """


class CitationTableColumn(BaseModel):
    id: Annotated[str, Field(max_length=60, min_length=1)]
    label: Annotated[str, Field(max_length=120, min_length=1)]
    type: ColumnType | None = None


class CitationTableSource(BaseModel):
    id: Annotated[str, Field(min_length=1)]
    title: Annotated[str, Field(max_length=300, min_length=1)]
    url: Annotated[str | None, Field(max_length=2000)] = None
    snippet: Annotated[str | None, Field(max_length=1000)] = None


type ColumnHint1 = Annotated[str, Field(max_length=60, min_length=1)]


type ColumnType = Literal["text", "number", "link", "date"]
"""
How a citation-table column's values are formatted and sorted.
"""


class ExtractTableRequest(BaseModel):
    reportText: Annotated[str, Field(max_length=100000, min_length=1)]
    sources: Annotated[list[ExtractTableSource], Field(max_length=100, min_length=1)]
    model: Annotated[str | None, Field(max_length=100)] = None
    """
    Model id from the backend's allow-list. Absent means the backend's default extraction model.
    """
    columnHints: Annotated[list[ColumnHint] | None, Field(max_length=8)] = None
    """
    Optional column hints. Each entry is a plain label (legacy, treated
    as `text`) or `{ label, type? }`. When present the model uses these
    labels verbatim.

    """


class ExtractTableSource(BaseModel):
    title: Annotated[str, Field(max_length=300)]
    url: Annotated[str, Field(max_length=2000)]
    snippet: Annotated[str, Field(max_length=2000)]


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: str
    """
    The implementation's name, e.g. `agent-py`.
    """
    version: str
    """
    The implementation's own version.
    """


class LegacyFastApiError(BaseModel):
    """
    Transitional. agent-py currently returns FastAPI's default envelope —
    `{ detail: <string | ApiError | validation issues> }` — instead of a
    flat `ApiError`. Accepted so the suite describes today's backend;
    removed once agent-py flattens its errors (run the conformance suite
    with `CONTRACT_STRICT_ERRORS=1` to reject it).

    """

    detail: str | ApiError | list[ValidationIssue]


type ErrorResponse = ApiError | LegacyFastApiError
"""
An `ApiError`, or (transitionally) the legacy FastAPI envelope.
"""


class ReadinessChecks(BaseModel):
    """
    Implementation-specific dependency checks. The keys below are the
    ones agent-py reports; every key is optional and another backend may
    report others.

    """

    model_config = ConfigDict(
        extra="allow",
    )
    __annotations__ = {
        "__pydantic_extra__": dict[str, bool | float | str | None],
    }
    supabase_url_configured: bool | None = None
    supabase_db_configured: bool | None = None
    jwt_secret_configured: bool | None = None
    db_pool_open: bool | None = None
    poller_alive: bool | None = None
    """
    Null when no background poll loop was started; false when it was started and has died.
    """
    poller_last_tick_age_seconds: float | None = None
    """
    Seconds since the poll loop last finished a tick; null before the first.
    """


class ReadinessResponse(BaseModel):
    status: Literal["ok", "degraded"]
    checks: ReadinessChecks


class RefreshFileUrlRequest(BaseModel):
    storagePath: Annotated[
        str,
        Field(
            examples=["8a6e0804-2bd0-4672-b79d-d97027f9071a/generated/report.pdf"],
            max_length=512,
            min_length=1,
        ),
    ]
    """
    Object path inside the bucket, `<user_id>/...`. Must not start
    with `/` or contain `..`; its first segment must be the caller's
    user id.

    """


class RefreshStorageUrlRequest(BaseModel):
    storage_path: Annotated[
        str,
        Field(
            examples=["8a6e0804-2bd0-4672-b79d-d97027f9071a/images/abc.png"],
            max_length=512,
            min_length=1,
        ),
    ]
    """
    Object path inside the bucket, `<user_id>/...`. Must not start
    with `/` or contain `..`; its first segment must be the caller's
    user id.

    """


class RefreshStorageUrlResponse(BaseModel):
    url: Annotated[str, Field(min_length=1)]
    """
    A newly signed, long-lived URL for the object.
    """


class TypedColumnHint(BaseModel):
    label: Annotated[str, Field(max_length=60, min_length=1)]
    type: ColumnType | None = None


type ColumnHint = ColumnHint1 | TypedColumnHint


class ValidationIssue(BaseModel):
    """
    One FastAPI/Pydantic request-validation issue.
    """

    model_config = ConfigDict(
        extra="allow",
    )
    loc: list[str | int]
    msg: str
    type: str
