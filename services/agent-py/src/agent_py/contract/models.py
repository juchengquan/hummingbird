# DO NOT EDIT — generated from packages/contract/openapi.yaml.
# Regenerate with: bun run contract:gen (packages/contract/scripts/gen.sh).

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field


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


class Brave(BaseModel):
    enabled: bool | None = None
    freshness: Literal["any", "pd", "pw", "pm", "py"] | None = None


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


class CreateConversationShareRequest(BaseModel):
    kind: Literal["conversation"]
    conversationId: UUID


class CreateDocumentShareRequest(BaseModel):
    kind: Literal["document"]
    documentId: UUID


type CreateShareRequest = Annotated[
    CreateConversationShareRequest | CreateDocumentShareRequest,
    Field(discriminator="kind"),
]
"""
A conversation share names `conversationId`; a document share names
`documentId` (a workspace owns several documents, so the target is
one document, not the workspace).

"""


class CreateShareResponse(BaseModel):
    token: Annotated[str, Field(min_length=1)]
    """
    The share token. The share page URL is `/share/<kind>/<token>`.
    """
    kind: ShareKind


type CspReportBody = Annotated[
    Any,
    Field(
        examples=[
            {
                "csp-report": {
                    "document-uri": "https://app.example.com/dashboard",
                    "effective-directive": "script-src-elem",
                    "blocked-uri": "https://cdn.example.com/x.js",
                    "disposition": "report",
                }
            }
        ]
    ),
]
"""
A legacy `report-uri` object (`{ "csp-report": { ... } }`) or a
Reporting-API batch (an array of `{ type, body }` reports; only
`type: csp-violation` entries are read, at most 20 per batch). Left
open: any JSON value is accepted and unknown shapes are ignored.

"""


class DeleteScheduleResponse(BaseModel):
    ok: Literal[True]


class EmbedRequest(BaseModel):
    fileId: Annotated[str, Field(max_length=64, min_length=1)]
    """
    Id of the caller's `files` row the sections belong to.
    """
    text: Annotated[str, Field(max_length=1200000)]
    """
    The file's extracted full text.
    """
    force: bool | None = None
    """
    Drop the file's existing sections and rebuild them.
    """


class EmbedResponse(BaseModel):
    status: Literal["indexed", "skipped"]
    sections: Annotated[int, Field(ge=0)]
    """
    Chunks written (`indexed`) or already present (`already_indexed`); otherwise 0.
    """
    reason: Literal["not_configured", "empty", "already_indexed", "file_not_found"] | None = None
    """
    Why the request was skipped. Absent when `indexed`.
    """


class ErrorResponse(ApiError):
    """
    The body of every non-2xx JSON response: an `ApiError`. (The
    transitional FastAPI `{ detail }` envelope is no longer accepted.)

    """


class Exa(BaseModel):
    enabled: bool | None = None
    type: Literal["auto", "neural", "keyword"] | None = None


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


class ImageGenSkillConfig(BaseModel):
    maxCalls: Annotated[int | None, Field(ge=1, le=50)] = None
    aspectRatio: Literal["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2"] | None = None


class MaxCallsSkillConfig(BaseModel):
    maxCalls: Annotated[int | None, Field(ge=1, le=50)] = None


class MemoryExtractRequest(BaseModel):
    turnText: Annotated[str, Field(max_length=50000, min_length=1)]
    """
    The finished turn, as `User: ...` / `Assistant: ...` paragraphs.
    """
    conversationId: Annotated[str | None, Field(max_length=64)] = None
    """
    Provenance stamped on new facts (`source_conversation_id`).
    """
    tainted: bool | None = None
    """
    The turn read third-party content; nothing is extracted.
    """


class MemoryExtractResponse(BaseModel):
    ok: Literal[True]


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
    scheduler_alive: bool | None = None
    """
    Null when the schedule dispatcher loop is not enabled; false when it was started and has died.
    """
    scheduler_last_tick_age_seconds: float | None = None
    """
    Seconds since the schedule dispatcher last finished a tick; null before the first.
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


class ResolvedConversationShare(BaseModel):
    kind: Literal["conversation"]
    conversationTitle: str
    messages: list[SharedMessage]
    """
    The conversation's messages in `position` order.
    """
    createdAt: AwareDatetime
    """
    When the share was created.
    """


class ResolvedDocumentShare(BaseModel):
    kind: Literal["document"]
    documentTitle: str
    """
    The document's title, or `Untitled` when it has none.
    """
    documentContent: str
    """
    The document body (markdown).
    """
    createdAt: AwareDatetime
    """
    When the share was created.
    """


type ResolvedShare = Annotated[
    ResolvedConversationShare | ResolvedDocumentShare, Field(discriminator="kind")
]
"""
What a share page renders, by `kind`.
"""


class RevokeShareResponse(BaseModel):
    ok: Literal[True]


class ScheduleCreateRequest(BaseModel):
    workspaceId: Annotated[str, Field(max_length=64, min_length=1)]
    """
    The workspace (owned by the caller) the scheduled runs belong to.
    """
    name: Annotated[str, Field(max_length=200, min_length=1)]
    prompt: Annotated[str, Field(max_length=20000, min_length=1)]
    cron: ScheduleCron
    timezone: Annotated[str | None, Field(max_length=100, min_length=1)] = None
    """
    IANA timezone, e.g. `America/Los_Angeles`. Absent means `UTC`.
    """
    enabled: bool | None = None
    """
    Absent means true.
    """
    model: Annotated[str | None, Field(max_length=100)] = None
    """
    Model id; null falls back to the workspace / global default at run time.
    """
    systemPrompt: Annotated[str | None, Field(max_length=20000)] = None
    skills: Annotated[list[SkillConfig] | None, Field(max_length=10)] = None
    maxSteps: Annotated[int | None, Field(ge=1, le=50)] = None
    """
    Step budget per run; null means 25.
    """


type ScheduleCron = Annotated[
    str,
    Field(
        examples=["0 8 * * *", "*/15 9-17 * * 1-5"],
        max_length=100,
        min_length=1,
        pattern="^\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+$",
    ),
]
"""
Five space-separated fields (minute hour day-of-month month
day-of-week), evaluated with cron-parser semantics. The backend
additionally rejects expressions that cannot be parsed or fire more
often than every 5 minutes (400 `invalid_request`).

"""


class ScheduleListResponse(BaseModel):
    schedules: list[ScheduleResponse]


class ScheduleResponse(BaseModel):
    id: str
    workspaceId: str
    name: str
    prompt: str
    cron: str
    timezone: str
    enabled: bool
    model: str | None
    systemPrompt: str | None
    skills: list[SkillConfig] | None = None
    """
    Absent when the schedule has no skill list.
    """
    maxSteps: int | None
    lastRunAt: AwareDatetime | None
    lastRunTaskId: str | None
    """
    The task the last fire created, for deep-linking to its result.
    """
    nextRunAt: AwareDatetime
    createdAt: AwareDatetime
    updatedAt: AwareDatetime


class ScheduleUpdateRequest(BaseModel):
    """
    Any subset of the create fields. `null` is accepted only where the create body accepts it.
    """

    workspaceId: Annotated[str | None, Field(max_length=64, min_length=1)] = None
    name: Annotated[str | None, Field(max_length=200, min_length=1)] = None
    prompt: Annotated[str | None, Field(max_length=20000, min_length=1)] = None
    cron: ScheduleCron | None = None
    timezone: Annotated[str | None, Field(max_length=100, min_length=1)] = None
    enabled: bool | None = None
    model: Annotated[str | None, Field(max_length=100)] = None
    systemPrompt: Annotated[str | None, Field(max_length=20000)] = None
    skills: Annotated[list[SkillConfig] | None, Field(max_length=10)] = None
    maxSteps: Annotated[int | None, Field(ge=1, le=50)] = None


type ShareKind = Literal["conversation", "document"]
"""
What a share points at.
"""


class SharedMessage(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    reasoning: str | None = None
    """
    The model's reasoning text, when it was kept.
    """
    position: int


class SkillConfig(BaseModel):
    """
    A skill enabled for a run, with optional per-skill settings (`ChatRequestSchema.shape.skills` in `lib/shared/api-schemas.ts`).
    """

    id: Annotated[str, Field(max_length=40)]
    webSearchConfig: WebSearchSkillConfig | None = None
    webFetchConfig: MaxCallsSkillConfig | None = None
    imageGenConfig: ImageGenSkillConfig | None = None
    fileSearchConfig: MaxCallsSkillConfig | None = None


class Tavily(BaseModel):
    enabled: bool | None = None
    searchDepth: Literal["basic", "advanced"] | None = None


class TypedColumnHint(BaseModel):
    label: Annotated[str, Field(max_length=60, min_length=1)]
    type: ColumnType | None = None


type ColumnHint = ColumnHint1 | TypedColumnHint


class ValidationErrorResponse(ApiError):
    """
    An `ApiError` (`code` is `invalid_request`) carrying the validation issues found.
    """

    issues: list[ValidationIssue] | None = None


class ValidationIssue(BaseModel):
    """
    One request-validation issue — where (`loc`), what (`msg`), and its machine `type`.
    """

    model_config = ConfigDict(
        extra="allow",
    )
    loc: list[str | int]
    msg: str
    type: str


class WebSearchSkillConfig(BaseModel):
    maxCalls: Annotated[int | None, Field(ge=1, le=50)] = None
    tavily: Tavily | None = None
    brave: Brave | None = None
    exa: Exa | None = None
