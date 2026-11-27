# DO NOT EDIT — generated from packages/contract/openapi.yaml.
# Regenerate with: bun run contract:gen (packages/contract/scripts/gen.sh).

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

type AllowedMcpServerId = Annotated[str, Field(max_length=64, min_length=1)]


class AnswerRunRequest(BaseModel):
    """
    The answers to a sub-agent run's open interrupts (`answerRun`):
    one AG-UI `ResumeEntry` per interrupt, as in a resume's
    `RunAgentInput.resume`.

    """

    resume: Annotated[list[ResumeEntry], Field(max_length=16, min_length=1)]


class ApiError(BaseModel):
    """
    The error envelope every backend returns on a non-2xx JSON response:
    a stable machine-readable `code` plus a human-readable `message`. The
    client keys typed UI off `code`; `message` is for display only.

    `code` is an open set (new codes are additive). In use today:
    `invalid_request`, `auth`, `auth_required`, `forbidden`, `not_found`,
    `unavailable`, `rate_limit`, `context_window`, `invalid_model`,
    `unknown_model`, `provider`, `aborted`, `unknown`. See
    `lib/shared/api-errors.ts`. The runs operations add
    `run_id_conflict`, `run_already_resumed`, `run_already_answered`,
    `run_answer_applied` and `invalid_attachment`, and use
    `invalid_state`.

    """

    model_config = ConfigDict(
        extra="allow",
    )
    code: Annotated[str, Field(examples=["auth", "invalid_request", "not_found"], min_length=1)]
    message: str


class Attributable(BaseModel):
    """
    Composed into everything that can belong to a subagent's work: the events that describe content or progress, the message types, and each interrupt. Run-scoped events omit it — RUN_STARTED, RUN_FINISHED and RUN_ERROR describe the run itself and MESSAGES_SNAPSHOT is conversation-wide, so none of them can belong to one subagent. A tool call omits it too and inherits its containing message's attribution.
    """

    subagentRunId: SubagentRunId | None = None
    """
    The subagent invocation this belongs to. Absent means the parent agent produced it directly.
    """


class ActivityMessage(Attributable):
    """
    Structured progress that is not conversation content, materialised as a message so it keeps its place in the sequence. Stands alone rather than composing BaseMessage, because its content is an object rather than a string.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    id: str
    """
    Identifies the message.
    """
    role: Literal["activity"]
    """
    Fixed. Declared here rather than inherited, because this message does not compose BaseMessage.
    """
    activityType: str
    """
    What kind of activity this is. An open string: the set is the producer's.
    """
    content: dict[str, Any]
    """
    The activity's payload, open by key.
    """
    metadata: Metadata | None = None
    """
    Extra information attached to this message.
    """


class AudioPart(BaseModel):
    """
    An audio part.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    type: Literal["audio"]
    """
    Discriminator.
    """
    id: str | None = None
    """
    Identifies this part within its message. Optional, and nothing reads it yet: reserved as on the text part.
    """
    source: PartSource
    """
    Where the audio comes from.
    """
    metadata: Any | None = None
    """
    Extra information about this part. Unconstrained, as on the other media parts.
    """


class BaseMessage(Attributable):
    """
    The fields shared by the developer, system, assistant and user messages. Deliberately excludes content, because a user message's content may be an array while the others are strings, and composition here intersects rather than overrides: a base that constrained content to a string would make an array content invalid. The tool, activity and reasoning messages do not compose this, because they carry no name.
    """

    id: str
    """
    Identifies the message within the conversation.
    """
    role: str
    """
    Who the message is from. Each message definition narrows this to a single value.
    """
    name: str | None = None
    """
    An optional display name for the author.
    """
    encryptedValue: str | None = None
    """
    A provider's opaque artefact belonging to this message, stored by a consumer and returned on a later turn.
    """
    metadata: Metadata | None = None
    """
    Extra information attached to this message.
    """


class AssistantMessage(BaseMessage):
    """
    A message from the agent. Content is optional because a turn may consist only of tool calls.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    role: Literal["assistant"]
    """
    Who the message is from. Each message definition narrows this to a single value.
    """
    content: str | None = None
    """
    What the agent said, if it said anything.
    """
    toolCalls: list[ToolCall] | None = None
    """
    The tool calls this turn made.
    """
    id: str
    """
    Identifies the message within the conversation.
    """


class Brave(BaseModel):
    enabled: bool | None = None
    freshness: Literal["any", "pd", "pw", "pm", "py"] | None = None


class Capabilities(BaseModel):
    tools: Annotated[list[LocalMcpTool] | None, Field(max_length=64)] = None


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


class CodeResult(BaseModel):
    model_config = ConfigDict(
        extra="allow",
    )
    id: str
    """
    The `runCode` tool call id.
    """
    stdout: str | None = None
    stderr: str | None = None
    results: list[dict[str, Any]] | None = None


type ColumnHint1 = Annotated[str, Field(max_length=60, min_length=1)]


type ColumnType = Literal["text", "number", "link", "date"]
"""
How a citation-table column's values are formatted and sorted.
"""


class Context(BaseModel):
    """
    A named piece of ambient information given to the agent for the run, distinct from the conversation.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    description: str
    """
    What this context is, for the agent to interpret.
    """
    value: str
    """
    The context itself.
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


class DataSource(BaseModel):
    """
    Bytes carried inline.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    type: Literal["data"]
    """
    Discriminator.
    """
    value: Annotated[str, Field(json_schema_extra={"contentEncoding": "base64"})]
    """
    The bytes, base64-encoded. contentEncoding is an annotation rather than a constraint in 2020-12, so a malformed string still validates here; rejecting one is the decoder's job.
    """
    mimeType: str
    """
    What the bytes are. Required here, unlike on a URL source, because nothing else can tell a consumer how to read them.
    """


class DeleteScheduleResponse(BaseModel):
    ok: Literal[True]


class DeveloperMessage(BaseMessage):
    """
    Instructions from the application developer.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    role: Literal["developer"]
    """
    Who the message is from. Each message definition narrows this to a single value.
    """
    content: str
    """
    The instructions. Required: a developer message with nothing in it says nothing.
    """
    id: str
    """
    Identifies the message within the conversation.
    """


class DocumentPart(BaseModel):
    """
    A document part.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    type: Literal["document"]
    """
    Discriminator.
    """
    id: str | None = None
    """
    Identifies this part within its message. Optional, and nothing reads it yet: reserved as on the text part.
    """
    source: PartSource
    """
    Where the document comes from.
    """
    metadata: Any | None = None
    """
    Extra information about this part. Unconstrained, as on the other media parts.
    """


class EditorAiCommandRequest(BaseModel):
    messages: Annotated[list[EditorAiMessage], Field(max_length=1000, min_length=1)]
    """
    The editor's AI chat so far; the last user message is the instruction.
    """
    document: EditorAiDocument
    toolName: EditorAiToolName | None = None
    """
    The menu's action; absent or null lets the model choose. `edit` needs a selection.
    """
    model: Annotated[str | None, Field(max_length=100)] = None
    """
    A catalog model id; absent or null means the backend's default.
    """


class EditorAiCompleteRequest(BaseModel):
    blockText: Annotated[str, Field(max_length=4000)]
    """
    The current block's text (markdown); the completion continues it.
    """
    prefix: Annotated[str | None, Field(max_length=32000)] = None
    """
    The preceding document (markdown); its last 8000 characters are used.
    """
    model: Annotated[str | None, Field(max_length=100)] = None
    """
    A catalog model id; absent means the backend's default.
    """


class EditorAiDocument(BaseModel):
    """
    The editor document as the prompts read it (Q101), rendered by the
    browser from the Plate value and selection.

    """

    isSelecting: bool
    """
    The selection is a range, not a caret.
    """
    generateContext: str | None
    """
    `generate`'s context while selecting (the selected blocks' markdown); null otherwise.
    """
    edit: EditorAiEdit | None
    """
    The edit prompt's kind and context while selecting; null otherwise.
    """
    commentContext: str
    """
    `comment`'s context: the blocks as `<block id="…">` markdown.
    """


class EditorAiEdit(BaseModel):
    kind: EditorAiEditKind
    context: str


type EditorAiEditKind = Literal["selection", "multi-block", "table"]
"""
Which edit prompt: a span inside one block (`selection`, marked with
`<Selection>` tags), several blocks (`multi-block`), or several table
cells (`table`, answered with `data-table` cell updates).

"""


class EditorAiMessage(BaseModel):
    """
    An AI SDK UI message; only `role` and the text parts are read.
    """

    role: Literal["system", "user", "assistant"]
    parts: Annotated[list[EditorAiMessagePart], Field(max_length=100)]


class EditorAiMessagePart(BaseModel):
    type: Annotated[str, Field(max_length=100)]
    text: Annotated[str | None, Field(max_length=200000)] = None


type EditorAiToolName = Literal["generate", "edit", "comment"]


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


class File(BaseModel):
    model_config = ConfigDict(
        extra="allow",
    )
    id: str | None = None
    name: str | None = None
    sizeBytes: int | None = None
    mimeType: str | None = None
    url: str
    storagePath: str | None = None


class FileSource(BaseModel):
    """
    Bytes already at the provider, named by a handle the provider issued: an OpenAI or Anthropic file id, a Gemini file URI, a storage URL only that provider can read. No bytes travel and nothing is fetched. Only the provider that minted the handle can resolve it; a peer that cannot drops the part as it drops any part it cannot use.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    type: Literal["file"]
    """
    Discriminator.
    """
    value: str
    """
    The handle, exactly as the provider issued it. Opaque: a consumer MUST NOT fetch it, parse it or read a scheme out of it.
    """
    provider: str | None = None
    """
    Who issued the handle, when the producer knows. Optional: an agent already knows which provider it talks to. When present, SHOULD be the lowercase vendor id (openai, anthropic, google) that TokenUsage.provider uses, so a peer can tell before sending whether a handle is one it can use.
    """
    mimeType: str | None = None
    """
    What the file is, when the producer knows. Optional, because the provider that holds the bytes knows.
    """


class FunctionCall(BaseModel):
    """
    The name and arguments of a tool call.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    name: str
    """
    Which tool is being called.
    """
    arguments: str
    """
    The arguments as a JSON string, not as parsed JSON. Kept as written because a model can emit arguments that are not valid JSON, and losing them at the protocol boundary would hide the fault from the consumer that has to handle it.
    """


type HeadersAdditionalProperty = Annotated[str, Field(max_length=8192)]


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


class Image(BaseModel):
    model_config = ConfigDict(
        extra="allow",
    )
    id: str | None = None
    url: str
    storagePath: str | None = None
    width: int | None = None
    height: int | None = None
    format: str | None = None
    prompt: str | None = None
    mode: str | None = None


class ImageGenSkillConfig(BaseModel):
    maxCalls: Annotated[int | None, Field(ge=1, le=50)] = None
    aspectRatio: Literal["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2"] | None = None


class ImagePart(BaseModel):
    """
    An image part.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    type: Literal["image"]
    """
    Discriminator.
    """
    id: str | None = None
    """
    Identifies this part within its message. Optional, and nothing reads it yet: reserved as on the text part.
    """
    source: PartSource
    """
    Where the image comes from.
    """
    metadata: Any | None = None
    """
    Extra information about this part. Unconstrained rather than an object: inherited from the SDKs, which declare it unknown rather than a record; listed under known divergences in the README rather than resolved here.
    """


class Interrupt(Attributable):
    """
    Something a run needs from outside before it can continue, such as an approval or a missing value.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    id: str
    """
    Identifies the interrupt. A resume entry answers it by this id.
    """
    reason: str
    """
    Why the run stopped. An open string rather than an enumeration: the protocol does not attempt to classify every reason an agent might need input.
    """
    message: str | None = None
    """
    A human-readable prompt for whoever answers.
    """
    toolCallId: str | None = None
    """
    The tool call this interrupt concerns, when it is a tool approval.
    """
    responseSchema: dict[str, Any] | None = None
    """
    A JSON Schema describing the answer this interrupt expects, so a consumer can build a form for it. Carried opaquely: the protocol does not constrain or validate it. Restricted to an object because TypeScript and Python both declare it that way; .NET holds it as any JSON, and the ticket that commissioned this schema lists it among the arbitrary-JSON fields. Following the two that constrain it keeps the schema from accepting documents the reference client rejects, at the cost of rejecting the boolean schemas JSON Schema also permits — a bare true for "any answer". Recorded as a known divergence rather than settled.
    """
    expiresAt: str | None = None
    """
    When the interrupt stops being answerable. Deliberately unconstrained rather than a date-time format, because producers already disagree about the representation and tightening it here would reject streams that work today. The documented convention is ISO 8601, and a consumer comparing this value will parse it as a date, so a value that is not one leaves the interrupt looking permanently unexpired.
    """
    metadata: Metadata | None = None
    """
    Extra information attached to this interrupt.
    """


class LocalMcpCredential(BaseModel):
    """
    One local MCP server's credential, as the browser stores it — the
    Next chat body's `mcpServers[].credentials`. Travels only in
    `RunAgentInput.state["hummingbird.localMcp"]` (`LocalMcpCredentials`).

    """

    type: Annotated[str | None, Field(max_length=40)] = None
    headers: Annotated[dict[str, HeadersAdditionalProperty] | None, Field(max_length=32)] = None
    """
    HTTP headers sent to the server (e.g. `Authorization`).
    """


type LocalMcpCredentials = Annotated[dict[str, LocalMcpCredential], Field(max_length=8)]
"""
The value of `RunAgentInput.state["hummingbird.localMcp"]`: server
id (a `localMcpServers[].id`) → its credential (Q45). The backend
never stores or logs it — not in the run row, its checkpoint, the
event log or an error — and never echoes it; a resume re-sends it.

"""


class LocalMcpServer(BaseModel):
    """
    A local-mode MCP server (credentials held by the browser) and its
    cached capabilities — the Next chat body's `mcpServers[]` entry
    without `credentials`.

    """

    id: Annotated[str, Field(max_length=64, min_length=1)]
    name: Annotated[str, Field(max_length=200, min_length=1)]
    url: Annotated[str, Field(max_length=2000, min_length=1)]
    """
    The server's MCP endpoint (HTTP transport).
    """
    transport: Literal["http"] | None = None
    requiresApproval: bool | None = None
    """
    Every tool of this server waits for the user's approval.
    """
    capabilities: Capabilities | None = None


class LocalMcpTool(BaseModel):
    """
    One tool from a local MCP server's cached tool list; offered as `mcp__<serverId>__<name>`.
    """

    name: Annotated[str, Field(max_length=200, min_length=1)]
    description: Annotated[str | None, Field(max_length=2000)] = None
    inputSchema: Any | None = None
    """
    The tool's JSON Schema, forwarded to the model as is.
    """
    uiResourceUri: Annotated[str | None, Field(max_length=2000)] = None
    """
    The `ui://` resource an MCP App tool renders.
    """


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


class Metadata(BaseModel):
    """
    Extra information attached to an event, a message, a tool call, a tool, an interrupt or a resume entry. Open by key: any JSON value is allowed under a key, including null, because a null there is meaningful data. The object itself may be absent but is never null when present. The key ag-ui is reserved for the protocol's own use; reservation is by convention, since validating the shape of a key's value would contradict being open by key.
    """

    model_config = ConfigDict(
        extra="allow",
    )


class ModelList(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    models: list[ServedModel]
    """
    The catalog ids with a provider here, in catalog order.
    """
    defaultModel: str
    """
    The backend's default (`AGENT_DEFAULT_MODEL`): what a request
    without a model runs on, and the model of the follow-up chips and
    of structured-output calls a model without it hands over.

    """
    auto: bool
    """
    Whether `auto` (smart routing) runs here — both models of the catalog's routing pair are served.
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


class ReasoningMessage(Attributable):
    """
    A span of the agent's reasoning, materialised as a message. Stands alone rather than composing BaseMessage, because it carries no name.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    id: str
    """
    Identifies the message.
    """
    role: Literal["reasoning"]
    """
    Fixed. Declared here rather than inherited, because this message does not compose BaseMessage.
    """
    content: str
    """
    The reasoning text.
    """
    encryptedValue: str | None = None
    """
    A provider's opaque reasoning artefact belonging to this message.
    """
    metadata: Metadata | None = None
    """
    Extra information attached to this message.
    """


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


type RequireApprovalForItem = Annotated[str, Field(min_length=1)]


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


class ResumeEntry(BaseModel):
    """
    An answer to one interrupt, sent on the run that continues from it.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    interruptId: str
    """
    The interrupt being answered.
    """
    status: Literal["resolved", "cancelled"]
    """
    Whether the interrupt was answered or abandoned.
    """
    payload: Any | None = None
    """
    The answer the agent asked for and will act on. Any JSON value.
    """
    metadata: Metadata | None = None
    """
    Envelope information about the response, such as signatures or routing keys, as opposed to payload, which is the answer itself.
    """


class RevokeShareResponse(BaseModel):
    ok: Literal[True]


class Run(BaseModel):
    """
    The run resource (modelled on the LangChain Agent Protocol's run).
    Exactly one of `result` / `error` / `openInterrupts` is meaningful,
    by `status`: `succeeded` → `result`; `failed` → `error`;
    `interrupted` → `openInterrupts` (non-empty); otherwise all are
    empty.

    """

    id: UUID
    threadId: UUID
    mode: RunMode
    status: RunStatus
    parentRunId: UUID | None
    """
    The run that spawned this one as a separate (background) sub-agent run. Sub-agents that run inside a run appear in its stream as `SUBAGENT_*` events instead.
    """
    previousRunId: UUID | None
    """
    The interrupted run this one answered (`forwardedProps.previousRunId`).
    """
    openInterrupts: list[Interrupt]
    """
    What an `interrupted` run waits for; the same objects as its `RUN_FINISHED` interrupt outcome. Empty in every other status.
    """
    result: RunResult | None
    error: RunError | None
    lastSeq: Annotated[int, Field(ge=0)]
    """
    The highest log `seq` so far (0 before the first event, or after the log was purged).
    """
    goal: str | None
    """
    Background-run progress: the task's title
    (`forwardedProps.goal`, else the last user message's text).
    Null for an interactive run.

    """
    maxSteps: Annotated[int | None, Field(ge=1)]
    """
    Background-run progress — the step budget. Null for an interactive run.
    """
    step: Annotated[int | None, Field(ge=0)]
    """
    Background-run progress — the steps taken so far (0 before
    the first). Null for an interactive run.

    """
    createdAt: AwareDatetime
    startedAt: AwareDatetime | None
    finishedAt: AwareDatetime | None
    """
    When the run ended (`succeeded`, `failed`, `cancelled` or `interrupted`).
    """
    updatedAt: AwareDatetime
    rootRunId: UUID
    """
    The task this run belongs to (0.5.0, Q69, Q75): its first run.
    A run that answered another (`previousRunId`) has that run's
    root, a sub-agent run its parent's; any other run is its own
    root (`rootRunId` = `id`). Interactive runs too: a chat turn
    and its answers.

    """
    currentRunId: UUID | None
    """
    Null when this run is its task's **current run** (Q75): the
    newest run of the task that holds its question — the root, or
    a run that answered it and is live, succeeded, or ended
    *after* applying the answers. Otherwise the id of the task's
    current run, which carries the task's status: set on an
    `interrupted` run a later run answered (follow it — the
    question is closed), and on a resume that failed or was
    cancelled before applying (a dead branch: its root's question
    is open again, with this failure as a note). A sub-agent run
    is answered in place (Q59), so it is always its own current
    run.

    """
    research: bool
    """
    A research run (`forwardedProps.research`, Q46); a resume has
    its previous run's. False for interactive runs.

    """
    delivered: bool
    """
    The task's result was marked delivered (`markRunDelivered`,
    Q77) — read from the task's root, so every run of the task
    agrees. False for interactive runs.

    """
    childrenAsking: Annotated[int, Field(ge=0)]
    """
    How many of this run's sub-agent runs are `interrupted`,
    waiting on an answer (`answerRun`, Q59): one whose answer was
    accepted and not yet picked up (its `answerPending` is true)
    no longer counts — the question is answered. The parent
    itself reads `running` meanwhile.

    """
    answerPending: bool
    """
    An answer to this `interrupted` run was accepted and is
    queued, not yet picked up by a worker (`answerRun`, or the old
    task respond route): show the question as answered. False
    otherwise.

    """


class RunAccepted(BaseModel):
    runId: UUID
    status: RunStatus


class RunAgentInput(BaseModel):
    """
    A request to run an agent. Also echoed back as RUN_STARTED.input. Only threadId, runId and messages are required: those are the three the SDKs already agree on, and for tools and context an absent key and an empty array mean the same thing, so requiring them would catch nothing a producer could get wrong.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    threadId: str
    """
    The conversation this run belongs to.
    """
    runId: str
    """
    Identifies this run.
    """
    protocolVersion: str | None = None
    """
    The protocol version this consumer speaks, such as "1.0". Absent means the input was produced before the protocol carried a version — the versioning rules in the prose govern what each side does with that. Sent in-band rather than by the transport, so a recorded exchange stays self-describing.
    """
    parentRunId: str | None = None
    """
    The run that spawned this one.
    """
    state: State | None = None
    """
    The state the run starts from.
    """
    messages: list[Message]
    """
    The conversation so far, in order.
    """
    tools: list[Tool] | None = None
    """
    The tools the agent may call. Absent means none.
    """
    context: list[Context] | None = None
    """
    Ambient information for the run. Absent means none.
    """
    forwardedProps: Any | None = None
    """
    Application-specific values passed through to the agent untouched. Any JSON value.
    """
    resume: list[ResumeEntry] | None = None
    """
    Answers to the interrupts that ended a previous run, when this run continues from one.
    """


class RunBookmarkAttachment(BaseModel):
    """
    A URL bookmark with the text fetched for it, capped. Third-party
    content: it taints the turn for memory extraction.

    """

    kind: Literal["bookmark"]
    id: Annotated[str | None, Field(max_length=64)] = None
    """
    The bookmark's id, if the client has one.
    """
    url: Annotated[str, Field(max_length=2000, min_length=1)]
    title: Annotated[str, Field(max_length=500, min_length=1)]
    text: Annotated[str, Field(max_length=220000)]
    """
    The fetched page text (the Next body's `ATTACHMENT_TEXT_MAX`).
    """
    truncated: bool | None = None
    fetchedAt: Annotated[str | None, Field(max_length=64)] = None
    """
    When the text was fetched (ISO 8601).
    """


type RunCursor = Annotated[
    str,
    Field(
        examples=["0", "42", "42.1"],
        pattern="^(0|[1-9][0-9]{0,9})(\\.(0|[1-9][0-9]{0,3}))?$",
    ),
]
"""
A replay cursor — an SSE `id` a run stream sent: `<seq>` (after
log entry `seq` entirely) or `<seq>.<k>` (after the k-th AG-UI
event entry `seq` produced). `0` is before the first entry.

"""


class RunError(BaseModel):
    """
    Why a run failed — also `RUN_ERROR`'s `code` / `message`.
    """

    code: Annotated[str, Field(min_length=1)]
    """
    An `ApiError` code: `rate_limit`, `auth`, `context_window`, `provider`, `upstream`, `max_steps`, `no_worker`, `worker_lost`, `unknown`, …
    """
    message: str


class RunFileAttachment(BaseModel):
    """
    A cloud file (a synced `files` row), by id. The backend reads its
    extracted text (and an image's stored data URL) itself, after
    checking the caller owns it (its Storage / database access bypasses
    RLS); a row it cannot read as the caller's renders as the name
    only. Signed-in runs only: on an anonymous run, or a backend with
    no database, it is `400 invalid_attachment`.

    """

    kind: Literal["file"]
    fileId: Annotated[str, Field(max_length=64, min_length=1)]
    """
    The file's id (`UploadedFile.id`, the `files` row id).
    """
    name: Annotated[str, Field(max_length=500, min_length=1)]
    """
    The file name, as the user sees it.
    """
    mimeType: Annotated[str | None, Field(max_length=100)] = None
    sizeBytes: Annotated[int | None, Field(ge=0)] = None
    extractedKind: Annotated[str | None, Field(max_length=40)] = None
    """
    What extraction made of it (`UploadedFile.extractedKind`, e.g. `pdf`).
    """
    retrievalMode: Literal["inline", "rag"] | None = None
    """
    `inline` (default): the text goes into the prompt, within
    the attachments budget. `rag`: only a note that the file can
    be searched with `searchFiles` (by its id, Q47).

    """


class RunForwardedProps(BaseModel):
    """
    Hummingbird's run options, carried in AG-UI's
    `RunAgentInput.forwardedProps` (application-specific values the
    protocol passes through). Open: a backend ignores keys it does not
    know, and new keys are additive. Every key is optional.

    """

    model_config = ConfigDict(
        extra="allow",
    )
    mode: RunMode | None = None
    previousRunId: UUID | None = None
    """
    The interrupted run this one answers. Required with a
    non-empty `resume[]`, otherwise ignored.

    """
    model: Annotated[str | None, Field(max_length=100)] = None
    """
    Model id from the backend's allow-list. Absent means the backend's default.
    """
    systemPrompt: Annotated[str | None, Field(max_length=20000)] = None
    """
    Extra instructions (workspace / conversation system prompt), prepended to the backend's own.
    """
    skills: Annotated[list[SkillConfig] | None, Field(max_length=10)] = None
    goal: Annotated[str | None, Field(max_length=2000)] = None
    """
    Background runs — the task's title. Absent means the last user message's text.
    """
    maxSteps: Annotated[int | None, Field(ge=1, le=50)] = None
    """
    Step budget. Absent means 25 (background; 35 with `research`) or the chat default (interactive).
    """
    requireApprovalFor: Annotated[list[RequireApprovalForItem] | None, Field(max_length=64)] = None
    """
    Tool names that wait for the user's approval before they run
    (an `approval` interrupt, RUN_EVENTS.md § 4). Adds to what
    always waits (`askUser`, `renderUI`, MCP tools their server
    marks for approval).

    """
    workspaceId: Annotated[str | None, Field(max_length=64, min_length=1)] = None
    """
    The caller's workspace the run belongs to (signed-in runs):
    scopes `searchFiles` and adds the workspace's cloud MCP
    tools. Ignored for anonymous runs.

    """
    reasoningEffort: Literal["low", "medium", "high"] | None = None
    """
    Reasoning-effort tier (the chat's `reasoningEffort`): the
    model thinks before answering with a budget per tier (agent-py:
    Anthropic extended thinking, 2048 / 8192 / 16384 budget
    tokens). Ignored for a model that takes no tier
    (`supportsReasoningEffort` in the catalog). Absent means the
    provider default (no extended thinking).

    """
    research: bool | None = None
    """
    Research mode (Q46): the run follows the research task
    prompt (plan → per-section search → gap pass → a cited
    Markdown report), and its citations are verified. Absent
    means false. Not called `mode`, which is interactive /
    background. A background research run's step budget
    defaults to 35. agent-py: background runs (interactive runs
    take only the citation checks, `verifyCitations`).

    """
    allowedMcpServerIds: Annotated[list[AllowedMcpServerId] | None, Field(max_length=64)] = None
    """
    MCP servers whose tools the run may offer (Q48), cloud
    (`workspaceId`) and local (`localMcpServers`) alike. Absent
    means no restriction; an empty list means no MCP tools. On a
    resume, interactive or background, it can only narrow the
    paused run's list (Q51); absent keeps that list.

    """
    attachments: Annotated[list[RunAttachment] | None, Field(max_length=40)] = None
    """
    Sources attached to this turn — files, URL bookmarks, MCP
    resources — the way the Next chat route's `attachments`
    carries them, but large inputs by reference (Q44): a cloud
    file by id, never its text. Rendered into the system prompt
    under one character budget, files first, as the Next chat
    route renders them; a cloud file's header carries its id, and
    a RAG-mode file is a note to call `searchFiles` with it (Q47).
    Every attachment marks the turn as reading third-party content
    (`RunResult.memoryTainted`). Interactive runs only: a
    background run refuses them (Q49, `400 invalid_request`). One
    the run cannot give the model is `400 invalid_attachment`
    (see `RunFileAttachment`, `RunInlineFileAttachment`).

    """
    memoryBypass: bool | None = None
    """
    The conversation's memory opt-out (the chat body's
    `memoryBypass`, set from `Conversation.memoryOff`): no
    remembered facts in the prompt and no remember / forget
    tools. Absent means false.

    """
    verifyCitations: bool | None = None
    """
    Opt-in citation verification: when the turn produced cited
    claims over retrieved sources, a post-turn verifier pass
    emits a `hummingbird.verification` part (agent-py: when
    `VERIFY_MODEL` is set). Absent means false.

    """
    referenceImage: RunReferenceImage | None = None
    localFilesOnly: bool | None = None
    """
    The account's "store files locally" preference: generated
    images come back as data URLs instead of being uploaded to
    Storage. Absent means false.

    """
    sandboxFiles: Annotated[list[RunSandboxFile] | None, Field(max_length=10)] = None
    """
    The files `runCode` may mount at `/mnt/files/<name>` (0.5.2,
    Q92), when the `codeInterpreter` skill is on: the Next chat
    body's `sandboxFiles`, the model naming them by `name`. A cloud
    file goes by id — the backend reads it only if it is the
    caller's (Q44); `dataBase64` only for a signed-out user's local
    file, within the request size limit. A background run takes
    cloud files only (Q93): one with `dataBase64` is
    `400 invalid_request`. A file that can't be mounted is a note
    to the model, never an error.

    """
    localMcpServers: Annotated[list[LocalMcpServer] | None, Field(max_length=8)] = None
    """
    Local-mode MCP servers (Q42, Q45): servers whose credentials
    live in the browser, with their cached tool list. Interactive
    runs only — a background run refuses them. **No
    credentials here**: they ride in `RunAgentInput.state` under
    `hummingbird.localMcp` (see `StartRunRequest`).

    """
    ephemeral: bool | None = None
    """
    0.8.0 (Q135, Q136): a throwaway run on a temporary thread —
    the Explain-selection popover. The backend keeps it in
    memory only, as it keeps an anonymous run: never stored
    with the caller's tasks, never in `listRuns`, gone a while
    after it ends (agent-py: `RUNS_MEMORY_TTL_SECONDS`). A
    signed-in caller still owns it — their bearer reads, streams
    and cancels it, and their limits apply. It offers the model
    **no tools**: the backend ignores `skills`, MCP servers,
    `localMcpServers` and AG-UI `tools`, and offers no `askUser`
    / `renderUI` either, so the run never runs a tool and never
    ends `interrupted`; no follow-up suggestions. Interactive
    only and never a resume: with `mode: background`,
    `previousRunId` or `resume[]` it is `400 invalid_request`.
    Absent means false.

    """


class RunGapEventValue(BaseModel):
    """
    The `value` of the `CUSTOM` event named `hummingbird.gap`: the
    requested cursor points at events the log no longer holds. The
    next event is always a `MESSAGES_SNAPSHOT` (id `resumeAt`, or no id
    when `resumeAt` is null) holding this run's output up to
    `resumeAt`; the stream then continues after it.

    """

    after: RunCursor
    resumeAt: Annotated[int | None, Field(ge=1)]
    """
    The seq the snapshot covers up to (the compacted entry's seq); null when the whole log was purged.
    """
    reason: Literal["compacted", "purged"]
    """
    `compacted` — deltas were folded into the snapshot (Q17); `purged` — the log is gone after its retention window and the snapshot is empty (Q30).
    """


class RunInlineFileAttachment(BaseModel):
    """
    A file that exists only in the browser (a signed-out user's, or
    one not synced), sent by value: its extracted `text`, or — for a
    small file with none — its bytes as a `data:` URL. One of the
    two is expected. A `dataUrl` follows the media rules of
    `StartRunRequest` (an image, a PDF or a text file within their
    limits), else `400 invalid_attachment`.

    """

    kind: Literal["inlineFile"]
    name: Annotated[str, Field(max_length=500, min_length=1)]
    mimeType: Annotated[str | None, Field(max_length=100)] = None
    sizeBytes: Annotated[int | None, Field(ge=0)] = None
    extractedKind: Annotated[str | None, Field(max_length=40)] = None
    text: Annotated[str | None, Field(max_length=120000)] = None
    """
    The extracted text (the Next body's `FileSummary.text` cap).
    """
    truncated: bool | None = None
    """
    The text was cut before sending.
    """
    dataUrl: Annotated[str | None, Field(max_length=1500000, pattern="^data:")] = None
    """
    The file's bytes, base64 in a `data:` URL (about 1 MiB at most).
    """


class RunList(BaseModel):
    runs: list[Run]
    nextPageToken: str | None
    """
    Pass back as `pageToken` for the next page; null on the last page.
    """


class RunMcpResourceAttachment(BaseModel):
    """
    A resource of an MCP server, by reference: the backend reads it
    (`resources/read`) from the server named by `serverId` — a cloud
    server of the workspace, or one of `localMcpServers` with its
    credential from `state`.

    """

    kind: Literal["mcpResource"]
    id: Annotated[str | None, Field(max_length=64)] = None
    """
    The cached resource row's id, if the client has one.
    """
    serverId: Annotated[str, Field(max_length=64, min_length=1)]
    uri: Annotated[str, Field(max_length=2000, min_length=1)]
    name: Annotated[str, Field(max_length=500, min_length=1)]
    mimeType: Annotated[str | None, Field(max_length=100)] = None


type RunAttachment = Annotated[
    RunFileAttachment | RunInlineFileAttachment | RunBookmarkAttachment | RunMcpResourceAttachment,
    Field(discriminator="kind"),
]
"""
One source attached to a turn (`RunForwardedProps.attachments`),
by `kind`. Mirrors the Next chat body's `AttachmentPayloadSchema`
(`lib/shared/api-schemas.ts`), except that a signed-in user's file
goes by id (Q44).

"""


type RunMode = Literal["interactive", "background"]
"""
`interactive`: runs in the API process that received `startRun`,
streamed to the caller (Q28). `background`: queued for a worker;
requires sign-in.

"""


class RunReferenceImage(BaseModel):
    """
    The reference image for image-to-image generation (the chat
    body's `referenceImage`, set by an image's Remix action): the
    model is told to call `generateImage` with `referenceImageUrl`
    when the user asks for a variation. Only with the `imageGen`
    skill.

    """

    url: Annotated[str, Field(max_length=4000, min_length=1)]


class RunResult(BaseModel):
    """
    A succeeded run's return value — also `RUN_FINISHED.result` on the
    wire. Open; keys are additive.

    """

    model_config = ConfigDict(
        extra="allow",
    )
    text: str | None = None
    """
    The run's final assistant text, when it produced one. For a
    background task's run, the whole answer across its runs (the
    root and each resume that answered it, Q78), not this run's
    text alone.

    """
    memoryTainted: bool | None = None
    """
    The run read third-party content (web, file, MCP or sandbox
    tools), so post-turn memory extraction must skip it. Absent
    means false.

    """
    stoppedAt: Literal["max_steps"] | None = None
    """
    Why the answer may be incomplete. `max_steps`: a background
    task stopped at its step limit and delivers what it has (Q81);
    `text` then ends with a visible "stopped at the step limit"
    note. Absent for a run that finished on its own.

    """
    verification: dict[str, Any] | None = None
    """
    A research run's citation check over `text` (Q78): the same
    object as its `hummingbird.verification` activity's content
    (`{ checks, summary }`). Absent when no check ran.

    """
    images: list[Image] | None = None
    """
    The images the answer carries (0.5.1, Q87): every image the
    task's runs generated (`generateImage`, `runCode` charts), in
    order, then its sub-agents' results' images — so a parent's
    answer carries what its sub-agents drew. Each is the
    `hummingbird.tool_image` image shape: a Storage URL with its
    `storagePath`, or a data URL when files are kept local.
    An empty list when there are none; absent only on a result
    written before 0.5.1 (a client then reads them from the
    run's `hummingbird.tool_image` activities). `listRuns` rows
    leave `images` out (a data-URL image can be megabytes and
    the list is polled): read them from `getRun`.

    """
    files: list[File] | None = None
    """
    The files the answer carries (0.5.2, Q94): every
    `hummingbird.tool_file` file of the task's runs (`runCode`'s
    `/tmp/outputs`), in order, then its sub-agents' results' files.
    Each a Storage URL with its `storagePath`, or a data URL when
    files are kept local. Like `images`: an empty list when there
    are none, absent on a result written before 0.5.2, and left
    out of `listRuns` rows.

    """
    codeResults: list[CodeResult] | None = None
    """
    The code output the answer carries (0.5.2, Q94): every
    `hummingbird.code_result` of the task's runs, in order, then
    its sub-agents' results'. Charts are in `images` (mode `code`).
    Like `images`: an empty list when there are none, absent on a
    result written before 0.5.2, and left out of `listRuns` rows.

    """


class RunRewindEventValue(BaseModel):
    """
    The `value` of the `CUSTOM` event named `hummingbird.rewind`: a
    background run's worker died and another resumed it from the
    checkpoint at `after`. Discard every event received from this
    run's stream whose cursor seq is greater than `after` (they were
    the dead attempt's); the events that follow replace them.

    """

    after: Annotated[int, Field(ge=0)]


class RunSandboxFile(BaseModel):
    """
    A file `runCode` may mount (`RunForwardedProps.sandboxFiles`).
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    name: Annotated[str, Field(max_length=500, min_length=1)]
    """
    The name the model passes to `runCode`'s `files`.
    """
    fileId: Annotated[str, Field(max_length=64, min_length=1)]
    dataBase64: Annotated[str | None, Field(max_length=13333336)] = None
    """
    The bytes, base64 — a signed-out user's local file only.
    """


type RunStatus = Literal["queued", "running", "interrupted", "succeeded", "failed", "cancelled"]
"""
A run's lifecycle. `queued` (background, not picked up yet) →
`running` → one of the four ends: `succeeded`, `failed`,
`cancelled`, or `interrupted` (waiting for answers to its open
interrupts — which a **new** run answers, Q24; an interrupted run
runs again only when it is answered in place: a sub-agent run's
question always is, through `answerRun` or the old task respond
route, Q59). `queued` ends
when a worker starts executing. A background run waiting on its own
sub-agent runs is still `running`. Mapping to the internal status
and `tasks.status`: `RUN_EVENTS.md` § Status.

"""


type RunToken = Annotated[str, Field(max_length=128, min_length=22, pattern="^[A-Za-z0-9_-]+$")]
"""
An anonymous run's capability: at least 128 random bits,
base64url without padding. Issued once, in `startRun`'s
`X-Run-Token` response header; the backend stores only a hash.

"""


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
    Model id. Nothing picks one at run time: a schedule that fires
    without a model fails "no model" (Q56). So a schedule created
    without one — or re-enabled while it has none (the update's
    `enabled: true`) — is given the backend's default task model
    (Haiku, Q67) when it is saved, and the response shows it
    (Q73, Q80). Schedules that had none were paused by migration
    0047 until their owners re-enable them.

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


class ServedModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    id: Annotated[str, Field(examples=["minimax/minimax-m3.1-flash"])]
    """
    The `config/models.json` id.
    """
    tasks: bool
    """
    Whether background tasks run on it here (it can call tools, Q117).
    """


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


class StartRunRequest(RunAgentInput):
    """
    An AG-UI 1.0 `RunAgentInput`, by reference into the pinned schema,
    narrowed: `threadId` and `runId` are UUIDs, and `forwardedProps`,
    when present, is a `RunForwardedProps`. (`mode` cannot be a
    top-level field: `RunAgentInput` is closed —
    `unevaluatedProperties: false` — so any extra key fails it.)

    `messages` is the thread's history up to and including the new
    user message (Q15 — the browser owns the history; the backend
    keeps nothing across runs). Messages with role `activity` are
    display state and are not sent to the model. `tools` are
    client-side tools; the backend's own tools come from
    `forwardedProps.skills`.

    **Attachments.** A user message's `content` may list `image` and
    `document` parts (AG-UI `ContentPart`) next to its `text`:

    | part | source | limit |
    |---|---|---|
    | `image` | `data` with `mimeType` `image/jpeg`, `image/png`, `image/gif` or `image/webp` | 5 MiB of base64 each |
    | `image` | `url` (`https://`) | — |
    | `document` | `data` with a `text/*` `mimeType` — the file's extracted text, UTF-8 | 1 MiB of text each |
    | `document` | `data` with `application/pdf` | 10 MiB of base64 each |
    | `document` | `url` (`https://`, a PDF) | — |

    At most 20 images and 40 documents per run, over all messages. A
    document's `metadata.name` is its title for the model, and
    `metadata.truncated: true` tells the model the text was cut.
    Anything else — `audio` / `video` parts, `file` (provider handle)
    sources, other media types, malformed base64, a part over its
    limit, more parts than allowed — is `400 invalid_attachment`.

    **`state`.** Hummingbird reads one key of AG-UI's `state`:
    `hummingbird.localMcp`, the credentials of the local MCP servers
    listed in `forwardedProps.localMcpServers` (`LocalMcpCredentials`:
    server id → `{type?, headers?}`, Q45). Credentials never go in
    `forwardedProps` (stored with a background run) or a header
    (reverse-proxy access logs record headers). The backend holds them
    only in memory for the run: never in the run row, its checkpoint,
    the event log, a log line or an error, and never echoed in a
    stream. So a resume — a new run — must send them again, and a
    background run never gets them. Other `state` keys are ignored.

    """

    threadId: UuidString
    runId: UuidString
    forwardedProps: RunForwardedProps | None = None


type State = Any
"""
Agent state. Any JSON value: the protocol carries state without interpreting it, so an object, an array, a string and a number are all valid.
"""


type SubagentRunId = str
"""
An opaque handle for one subagent invocation, not a reusable name for a subagent definition: two invocations of the same subagent carry two different values. Named to mirror runId one level down, the way the subagent's name mirrors agentId.
"""


class SystemMessage(BaseMessage):
    """
    Instructions from the system.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    role: Literal["system"]
    """
    Who the message is from. Each message definition narrows this to a single value.
    """
    content: str
    """
    The instructions. Required.
    """
    id: str
    """
    Identifies the message within the conversation.
    """


class Tavily(BaseModel):
    enabled: bool | None = None
    searchDepth: Literal["basic", "advanced"] | None = None


class TextPart(BaseModel):
    """
    A text part.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    type: Literal["text"]
    """
    Discriminator.
    """
    id: str | None = None
    """
    Identifies this part within its message. Optional, and nothing reads it yet: reserved so that a streamed part can be matched to its entry in history once assistant messages carry parts too.
    """
    text: str
    """
    The text.
    """
    metadata: Any | None = None
    """
    Extra information about this part. Unconstrained, as on the media parts. This is where a text search hit carries its source and title, rather than the protocol modelling a search-result part of its own.
    """


class Tool(BaseModel):
    """
    A tool the agent may call.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    name: str
    """
    The tool's name, as the agent will call it.
    """
    description: str
    """
    What the tool does, for the agent to decide when to use it.
    """
    parameters: Any | None = None
    """
    A JSON Schema describing the tool's arguments. Carried opaquely: the protocol does not constrain or validate it. Optional, because all three SDKs already treat it that way and a tool that takes no arguments has nothing to declare; an absent schema and an empty one mean the same thing to an agent.
    """
    metadata: Metadata | None = None
    """
    Extra information about the tool, for consumers that attach their own rendering or routing information to it.
    """


class ToolCall(BaseModel):
    """
    A call an assistant message made. Carries no subagent attribution of its own and inherits its containing message's, since several calls can share one parent.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    id: str
    """
    Identifies the call. The answering tool message carries this as its toolCallId.
    """
    type: Literal["function"]
    """
    The only kind of call the protocol models.
    """
    function: FunctionCall
    """
    What is being called, and with what.
    """
    encryptedValue: str | None = None
    """
    A provider's opaque artefact belonging to this call.
    """
    metadata: Metadata | None = None
    """
    Extra information attached to this call. Carried here rather than folded into the containing message, because several calls can share one parent and merging them would make the result depend on their order.
    """


class ToolMessage(Attributable):
    """
    What a tool returned, as a message in the conversation. Stands alone rather than composing BaseMessage, because it carries no name.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    id: str
    """
    Identifies the message.
    """
    role: Literal["tool"]
    """
    Fixed. Declared here rather than inherited, because this message does not compose BaseMessage.
    """
    content: str | list[ContentPart]
    """
    What the tool returned: either plain text, or an ordered list of parts. A tool returning structured data serialises it into text; media travel as parts of their own.
    """
    toolCallId: str
    """
    The call this answers.
    """
    error: str | None = None
    """
    Why the tool failed, when it did. Present alongside content rather than instead of it, so a partial result survives a failure.
    """
    encryptedValue: str | None = None
    """
    A provider's opaque artefact belonging to this message.
    """
    metadata: Metadata | None = None
    """
    Extra information attached to this message.
    """


class TypedColumnHint(BaseModel):
    label: Annotated[str, Field(max_length=60, min_length=1)]
    type: ColumnType | None = None


type ColumnHint = ColumnHint1 | TypedColumnHint


class UrlSource(BaseModel):
    """
    Bytes referenced by URL, fetched by whoever needs them.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    type: Literal["url"]
    """
    Discriminator.
    """
    value: str
    """
    The URL. Deliberately not constrained to a URI format, so a scheme a producer already uses is not rejected here.
    """
    mimeType: str | None = None
    """
    What the resource is, when the producer knows. Optional, because the response can say.
    """


type PartSource = DataSource | UrlSource | FileSource
"""
Where a media part's bytes come from: carried inline, referenced by URL, or already at the provider under a handle it issued.
"""


class UserMessage(BaseMessage):
    """
    A message from the person using the application.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    role: Literal["user"]
    """
    Who the message is from. Each message definition narrows this to a single value.
    """
    content: str | list[ContentPart]
    """
    What the person sent: either plain text, or an ordered list of parts for a multimodal message.
    """
    id: str
    """
    Identifies the message within the conversation.
    """


type Message = (
    DeveloperMessage
    | SystemMessage
    | AssistantMessage
    | UserMessage
    | ToolMessage
    | ActivityMessage
    | ReasoningMessage
)
"""
Any message in a conversation. Discriminated by role.
"""


type UuidString = Annotated[
    str,
    Field(
        examples=["8a6e0804-2bd0-4672-b79d-d97027f9071a"],
        pattern="^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    ),
]
"""
A UUID in its canonical text form. A pattern rather than
`format: uuid` where it narrows an AG-UI string field, so the
generated models keep the AG-UI field's `str` type.

"""


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


class VideoPart(BaseModel):
    """
    A video part.
    """

    model_config = ConfigDict(
        extra="forbid",
    )
    type: Literal["video"]
    """
    Discriminator.
    """
    id: str | None = None
    """
    Identifies this part within its message. Optional, and nothing reads it yet: reserved as on the text part.
    """
    source: PartSource
    """
    Where the video comes from.
    """
    metadata: Any | None = None
    """
    Extra information about this part. Unconstrained, as on the other media parts.
    """


type ContentPart = TextPart | ImagePart | AudioPart | VideoPart | DocumentPart
"""
One part of a message body: what a person sends in a user message, or what a tool returns in a tool message. Discriminated by type. Named by what the part is rather than by direction, because the same part travels into the model inside a user message and back out of the stream inside a tool result.
"""


class WebSearchSkillConfig(BaseModel):
    maxCalls: Annotated[int | None, Field(ge=1, le=50)] = None
    tavily: Tavily | None = None
    brave: Brave | None = None
    exa: Exa | None = None
