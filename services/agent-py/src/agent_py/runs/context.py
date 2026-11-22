"""A run's attached context — files, MCP resources, URL bookmarks (wave 5b-B).

`forwardedProps.attachments` (`RunAttachment`, parsed into
`RunOptions.attachments`) rendered into the system prompt the way the Next
chat route does (`lib/server/attachments/render.ts`, `prompt-builders.ts`):
one character budget (`TOTAL_ATTACHMENT_BUDGET`) across files → MCP
resources → bookmarks, the same intros, headers, truncation markers,
omitted-list footers and meta-only footer.
`tests/fixtures/attachments_render_parity.json` (generated from the TS
renderer) pins the two to the same output.

| kind | where its content comes from |
|---|---|
| `file` | the caller's `files` row, read under RLS (`store._set_user_context`) **and** checked against `files.user_id` — `extracted_text`, `extraction_truncated`, `extracted_kind`; an image's `image_data_url` goes on the turn's user message (`TURN_CONTENT_KEY`). A row that is missing, deleted or not the caller's renders as meta-only. Signed-in runs with a database only: `check_attachment_input` refuses one otherwise (`400 invalid_attachment`) |
| `inlineFile` | its `text`; a `dataUrl` (an image / PDF / text file) goes on the turn's user message |
| `bookmark` | its `text` (the client caps it) |
| `mcpResource` | `resources/read` on the server `serverId`: a local server of the run (`forwardedProps.localMcpServers`, its credential from `RunInput.local_mcp_credentials`) or a cloud server of the run's workspace (credential decrypted under RLS). 5 s per read; a failure renders as an "unavailable" marker and is remembered for 30 s per caller + server (`inject-resources.ts` / `last-failures.ts`). A server outside `allowedMcpServerIds` (Q48) is not read |

**File ids (Q47).** A `file` attachment's header carries its id
(`fileId: …`); a RAG-mode file renders as a note telling the model to call
`searchFiles` with that id, and a truncated one says its full text is
searchable when `searchFiles` is offered. `rag_search_files` offers
`searchFiles` whenever a RAG-mode file is attached (Next force-enables the
skill the same way).

**Taint.** `attachment_context_taint` marks the turn as reading third-party
content when any attachment is present (Next's `requestTaint`), so the
memory tools refuse and `RUN_FINISHED.result.memoryTainted` is set.

Background runs refuse `attachments` (Q49), so this only runs for
interactive runs.

Budget lengths are Python code points; the TS renderer counts UTF-16 code
units, so the two differ only for text outside the BMP (emoji).
"""

from __future__ import annotations

import asyncio
import binascii
import contextlib
import hashlib
import math
import re
import time
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import structlog

from .. import store
from ..tools.search_files import build_search_files_tool
from .harness import RunInput
from .history import (
    IMAGE_MEDIA_TYPES,
    MAX_IMAGES,
    AttachmentRejected,
    _part_block,
    attachment_taint,
)
from .hook_types import TURN_CONTENT_KEY, HookContext, ToolsetDraft
from .options import (
    BookmarkAttachment,
    FileAttachment,
    InlineFileAttachment,
    McpResourceAttachment,
    RunAttachment,
    RunOptions,
)

logger = structlog.get_logger(__name__)

__all__ = [
    "READ_TIMEOUT_S",
    "TOTAL_ATTACHMENT_BUDGET",
    "BookmarkItem",
    "FileItem",
    "McpItem",
    "attachment_context",
    "attachment_context_taint",
    "check_attachment_input",
    "format_bytes",
    "rag_search_files",
    "render_attachments_prompt",
    "render_meta_only_files_prompt",
    "searchable_note",
]

#: The Next route's `TOTAL_ATTACHMENT_BUDGET` (`@/shared/attachments`).
TOTAL_ATTACHMENT_BUDGET = 300 * 1024
#: Per MCP `resources/read` (`inject-resources.ts`'s `READ_TIMEOUT_MS`).
READ_TIMEOUT_S = 5.0


# --- Resolved attachments (render.ts `ResolvedAttachment`) ------------------------------


@dataclass(frozen=True)
class FileItem:
    """A file as the renderer sees it (`FileSummary`)."""

    name: str
    size: int
    type: str
    text: str | None = None
    truncated: bool = False
    kind: str | None = None
    retrieval_mode: str = "inline"
    id: str | None = None
    """The cloud file's id (header + `searchFiles` notes); None for a
    browser-only file."""


@dataclass(frozen=True)
class McpItem:
    server_name: str
    resource_name: str
    text: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class BookmarkItem:
    title: str
    url: str
    content: str
    truncated: bool = False
    fetched_at: str | None = None


ResolvedItem = FileItem | McpItem | BookmarkItem


# --- Renderer (port of lib/server/attachments/render.ts) -------------------------------


def searchable_note(file_id: str) -> str:
    return (
        f'[The full text of this file is searchable: call `searchFiles` with fileId "{file_id}".]'
    )


def _file_intro(items: Sequence[ResolvedItem]) -> str:
    pdfs = [i.name for i in items if isinstance(i, FileItem) and i.kind == "pdf"]
    s = (
        "The user has attached these files. Their extracted text follows. "
        "Treat them as authoritative context for any question that references them."
    )
    if pdfs:
        s += (
            " When you reference content from a PDF, cite the page number inline using the "
            'marker `[p.N]` (e.g. "the discount applies after 30 days [p.4]"). The user can '
            "click these markers to open the PDF at that page. PDFs attached: "
            + ", ".join(f'"{n}"' for n in pdfs)
            + "."
        )
    return s


def _header(item: ResolvedItem) -> str:
    if isinstance(item, FileItem):
        notes = [n for n in (item.kind, f"fileId: {item.id}" if item.id else None) if n]
        kind_note = f" ({', '.join(notes)})" if notes else ""
        trunc_note = " (per-file truncated at extraction)" if item.truncated else ""
        return f"--- {item.name}{kind_note}{trunc_note} ---"
    if isinstance(item, McpItem):
        return f"--- {item.server_name}: {item.resource_name} ---"
    fetched = f" · fetched {item.fetched_at}" if item.fetched_at else ""
    return f"--- {item.title} ({item.url}){fetched} ---"


def _body(item: ResolvedItem) -> str | None:
    if isinstance(item, FileItem):
        if item.retrieval_mode == "rag":
            target = (
                f'`searchFiles` with fileId "{item.id}" and relevant query terms'
                if item.id
                else "`searchFiles` with relevant query terms"
            )
            return (
                "(RAG-mode attachment — body not inlined to save tokens. "
                f"Call {target} to retrieve matching sections from this file.)"
            )
        return item.text if item.text and item.text.strip() else None
    if isinstance(item, McpItem):
        return item.text if item.text else None
    return item.content


def _error_marker(item: ResolvedItem) -> str | None:
    if isinstance(item, McpItem) and item.error:
        return f'[MCP resource "{item.resource_name}" unavailable — {item.error}]'
    return None


def _label(item: ResolvedItem) -> str:
    if isinstance(item, FileItem):
        return item.name
    if isinstance(item, McpItem):
        return item.resource_name
    return item.title


_SECTIONS: tuple[tuple[type, str, str], ...] = (
    (FileItem, "files", ""),
    (
        McpItem,
        "MCP resources",
        "The user has attached these MCP resources. Their content follows. "
        "Treat them as authoritative context.",
    ),
    (
        BookmarkItem,
        "bookmarks",
        "The user has saved these web pages as bookmarks. Their cached text "
        "follows; if a fact appears outdated, the user may need to refresh the bookmark.",
    ),
)


def _render_section(
    items: Sequence[ResolvedItem],
    plural: str,
    intro: str,
    budget: int,
    *,
    search_files_enabled: bool,
) -> tuple[str | None, int]:
    if not any(_error_marker(i) is not None or _body(i) is not None for i in items):
        return None, 0
    if budget <= len(intro):
        return None, 0
    parts = [intro]
    used = len(intro)
    omitted: list[str] = []
    for item in items:
        header = _header(item)
        body = _body(item)
        marker = _error_marker(item)
        if marker:
            block = f"\n\n{header}\n{marker}"
            if used + len(block) > budget:
                omitted.append(_label(item))
                continue
            parts.append(block)
            used += len(block)
            continue
        if body is None:
            continue
        remaining = budget - used - len(header) - 4
        if remaining <= 0:
            omitted.append(_label(item))
            continue
        trimmed = body[:remaining]
        overflow = len(body) > len(trimmed)
        cut = overflow or (isinstance(item, FileItem) and item.truncated)
        note = (
            searchable_note(item.id)
            if cut and isinstance(item, FileItem) and item.id and search_files_enabled
            else None
        )
        parts.append(
            f"\n\n{header}\n"
            + trimmed
            + ("\n[truncated to fit overall budget]" if overflow else "")
            + (f"\n{note}" if note else "")
        )
        used += len(header) + len(trimmed) + 4
    if omitted:
        parts.append(f"\n\n[Additional {plural} omitted to fit budget: {', '.join(omitted)}]")
    return "".join(parts), used


def render_attachments_prompt(
    items: Sequence[ResolvedItem],
    total_budget: int = TOTAL_ATTACHMENT_BUDGET,
    *,
    search_files_enabled: bool = False,
) -> str | None:
    """`renderAttachmentsPrompt`: the attachment block, or None."""
    sections: list[str] = []
    used = 0
    for cls, plural, intro in _SECTIONS:
        group = [i for i in items if isinstance(i, cls)]
        if not group:
            continue
        fragment, n = _render_section(
            group,
            plural,
            _file_intro(group) if cls is FileItem else intro,
            max(0, total_budget - used),
            search_files_enabled=search_files_enabled,
        )
        if fragment:
            sections.append(fragment)
            used += n
    return "\n\n".join(sections) if sections else None


def format_bytes(n: int) -> str:
    """`formatBytes` (`lib/shared/utils.ts`): `parseFloat(x.toFixed(1))` —
    `toFixed` rounds a tie up, from the double's exact value."""
    if n == 0:
        return "0 B"
    sizes = ["B", "KB", "MB", "GB", "TB"]
    i = math.floor(math.log(n) / math.log(1024))
    value = Decimal(n / 1024**i).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    text = f"{value:f}".rstrip("0").rstrip(".")
    return f"{text} {sizes[i]}"


def render_meta_only_files_prompt(files: Sequence[FileItem]) -> str | None:
    """`renderMetaOnlyFilesPrompt`: files with no text (RAG-mode files are
    not meta-only — they point at `searchFiles`)."""
    meta = [f for f in files if f.retrieval_mode != "rag" and not (f.text and f.text.strip())]
    if not meta:
        return None
    lines = "\n".join(f"- {f.name} ({f.type or 'unknown'}, {format_bytes(f.size)})" for f in meta)
    return (
        "The user has also attached these files which we could not extract text from "
        "(filename + metadata only). Ask the user to paste any relevant portion if a "
        f"question requires their content:\n\n{lines}"
    )


# --- Input check (before the run exists) -------------------------------------------------

_DATA_URL = re.compile(r"^data:([^;,]+);base64,(.*)$", re.DOTALL)


def _data_url_part(data_url: str, name: str) -> dict[str, object]:
    """An inline file's `dataUrl` as an AG-UI media part (what
    `history._part_block` converts)."""
    m = _DATA_URL.match(data_url)
    if m is None:
        raise AttachmentRejected("the dataUrl is not a base64 data: URL.")
    mime, value = m.group(1), m.group(2)
    kind = "image" if mime.startswith("image/") else "document"
    return {
        "type": kind,
        "source": {"type": "data", "mimeType": mime, "value": value},
        "metadata": {"name": name},
    }


def check_attachment_input(
    options: Mapping[str, object], *, signed_in: bool, database: bool
) -> None:
    """Raise `AttachmentRejected` (`400 invalid_attachment`, before the run
    exists) for an attachment this run cannot give the model: a `file` (a
    cloud file by id) on an anonymous run or a backend without a database
    to read it from, or an `inlineFile` whose `dataUrl` the model cannot
    take (the media rules of `StartRunRequest`)."""
    raw = options.get("attachments")
    if not isinstance(raw, list):
        return
    images = 0
    for i, att in enumerate(raw):
        if not isinstance(att, Mapping):
            continue
        kind = att.get("kind")
        if kind == "file" and not signed_in:
            raise AttachmentRejected(
                f"attachments[{i}]: a cloud file (kind `file`) needs a signed-in run; "
                "send a browser-held file as `inlineFile`."
            )
        if kind == "file" and not database:
            raise AttachmentRejected(
                f"attachments[{i}]: this backend has no database to read cloud files from; "
                "send the file as `inlineFile`."
            )
        data_url = att.get("dataUrl")
        if kind == "inlineFile" and isinstance(data_url, str) and data_url:
            name = att.get("name")
            try:
                block = _part_block(_data_url_part(data_url, str(name or "file")))
            except AttachmentRejected as exc:
                raise AttachmentRejected(f"attachments[{i}].dataUrl: {exc}") from None
            if block is not None and block["type"] == "image":
                images += 1
    if images > MAX_IMAGES:
        raise AttachmentRejected(
            f"Too many images in attachments: {images} (at most {MAX_IMAGES} per run)."
        )


# --- MCP resource reads (inject-resources.ts + last-failures.ts) -------------------------

_FAILURE_TTL_S = 30.0
_FAILURE_MAX = 1000
_failures: OrderedDict[tuple[str, str, str], tuple[float, str]] = OrderedDict()


def _failure_key(caller: str, server_id: str, url: str) -> tuple[str, str, str]:
    return caller, server_id, hashlib.sha256(url.encode()).hexdigest()[:16]


def _recent_failure(key: tuple[str, str, str]) -> str | None:
    entry = _failures.get(key)
    if entry is None:
        return None
    if time.monotonic() - entry[0] > _FAILURE_TTL_S:
        _failures.pop(key, None)
        return None
    return entry[1]


def _record_failure(key: tuple[str, str, str], exc: BaseException) -> str:
    now = time.monotonic()
    for k in [k for k, (at, _) in _failures.items() if now - at > _FAILURE_TTL_S]:
        _failures.pop(k, None)
    reason = describe_mcp_failure(exc)
    _failures.pop(key, None)
    _failures[key] = (now, reason)
    while len(_failures) > _FAILURE_MAX:
        _failures.popitem(last=False)
    return reason


def _leaves(exc: BaseException) -> list[BaseException]:
    if isinstance(exc, BaseExceptionGroup):
        return [leaf for e in exc.exceptions for leaf in _leaves(e)]
    return [exc]


def describe_mcp_failure(exc: BaseException) -> str:
    """`describeMcpFailure`: a short generic reason safe for a prompt — a
    category and at most an HTTP status, never upstream text."""
    from ..mcp_client import McpUrlBlockedError

    leaf = _leaves(exc)[0]
    message = f"{type(leaf).__name__}: {leaf}"
    if isinstance(leaf, McpUrlBlockedError):
        reason = "server URL blocked by policy"
    elif isinstance(leaf, TimeoutError) or re.search(r"timed out|timeout|aborted", message, re.I):
        reason = "timed out"
    else:
        status = getattr(getattr(leaf, "response", None), "status_code", None)
        match = re.search(r"\bHTTP\s*(\d{3})\b", message, re.I)
        code = str(status) if isinstance(status, int) else (match.group(1) if match else None)
        if code in ("401", "403"):
            reason = f"authentication failed (HTTP {code})"
        elif code:
            reason = f"upstream returned HTTP {code}"
        elif re.search(r"connect|ECONNREFUSED|ENOTFOUND|network|resolve", message, re.I):
            reason = "connection failed"
        else:
            reason = "request failed"
    return reason[:80]


@dataclass(frozen=True)
class _Server:
    id: str
    name: str
    url: str
    credentials: dict[str, Any] | None
    cloud: bool


async def _load_servers(
    ri: RunInput, opts: RunOptions, ctx: HookContext, wanted: set[str]
) -> dict[str, _Server]:
    """The servers the run may read resources from, by id: its local
    servers (credential from `state`) and its workspace's cloud servers."""
    allowed = opts.allowed_mcp_server_ids
    if allowed is not None:
        wanted = wanted & set(allowed)
    out: dict[str, _Server] = {}
    for s in opts.local_mcp_servers:
        if s.id in wanted:
            cred = ri.local_mcp_credentials.get(s.id)
            out[s.id] = _Server(
                id=s.id,
                name=s.name,
                url=s.url,
                credentials={"headers": dict(cred.headers)} if cred and cred.headers else None,
                cloud=False,
            )
    context = ctx.tool_context
    missing = wanted - set(out)
    if missing and context is not None and context.workspace_id:
        from ..mcp_tools import load_workspace_cloud_servers

        rows = await load_workspace_cloud_servers(
            context.pool, user_id=context.user_id, workspace_id=context.workspace_id
        )
        for row in rows:
            if row.id in missing:
                out[row.id] = _Server(row.id, row.name, row.url, None, cloud=True)
    return out


async def _read_resources(
    ri: RunInput, opts: RunOptions, ctx: HookContext, refs: Sequence[McpResourceAttachment]
) -> list[McpItem]:
    if not refs:
        return []
    servers = await _load_servers(ri, opts, ctx, {r.server_id for r in refs})
    caller = f"user:{ri.user_id}" if ri.user_id else f"ip:{ri.client_key or 'unknown'}"
    creds: dict[str, dict[str, Any] | None] = {}

    async def credentials_of(server: _Server) -> dict[str, Any] | None:
        if not server.cloud:
            return server.credentials
        if server.id not in creds:
            from ..mcp_credentials import fetch_decrypted_credentials

            context = ctx.tool_context
            assert context is not None
            creds[server.id] = await fetch_decrypted_credentials(
                context.pool, user_id=context.user_id, server_id=server.id
            )
        return creds[server.id]

    async def read(ref: McpResourceAttachment) -> McpItem:
        from ..mcp_client import McpEndpoint, read_resource

        server = servers.get(ref.server_id)
        if server is None:
            return McpItem("unknown", ref.name, error="server not configured or not enabled")
        key = _failure_key(caller, server.id, server.url)
        cached = _recent_failure(key)
        if cached is not None:
            return McpItem(
                server.name,
                ref.name,
                error=f"{cached} (cached from a recent failure; retrying after 30s cooldown)",
            )
        try:
            credentials = await credentials_of(server)
            if server.cloud and credentials is None:
                return McpItem(server.name, ref.name, error="server credentials unavailable")
            endpoint = McpEndpoint(id=server.id, name=server.name, url=server.url)
            content = await asyncio.wait_for(
                read_resource(endpoint, credentials, ref.uri), READ_TIMEOUT_S
            )
        except Exception as exc:
            reason = _record_failure(key, exc)
            logger.warning(
                "run_context.mcp_read_failed",
                run_id=ri.run_id,
                server_id=server.id,
                error_type=type(exc).__name__,
                reason=reason,
            )
            return McpItem(server.name, ref.name, error=reason)
        return McpItem(server.name, ref.name, text=content.text)

    return list(await asyncio.gather(*(read(r) for r in refs)))


# --- Cloud files -----------------------------------------------------------------------

_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

_LOAD_FILES_SQL = """
SELECT id::text, user_id::text, name, size, type, extracted_text,
       extraction_truncated, extracted_kind, image_data_url
FROM public.files
WHERE id = ANY($1::uuid[]) AND user_id = $2::uuid AND deleted_at IS NULL;
"""


async def _load_file_rows(ctx: HookContext, ids: Sequence[str]) -> dict[str, Mapping[str, Any]]:
    """The caller's live `files` rows among `ids`, by id — read as the user
    (RLS) and filtered on `user_id` too. A DB error reads as no rows."""
    context = ctx.tool_context
    valid = sorted({i.lower() for i in ids if _UUID.match(i)})
    if context is None or not valid:
        return {}
    try:
        async with context.pool.acquire() as conn, conn.transaction():
            await store._set_user_context(conn, user_id=context.user_id)
            rows = await conn.fetch(_LOAD_FILES_SQL, valid, context.user_id)
    except Exception as exc:
        logger.warning("run_context.files_load_failed", error=str(exc))
        return {}
    return {
        str(r["id"]).lower(): r
        for r in rows
        if str(r["user_id"]).lower() == context.user_id.lower()
    }


def _history_images(messages: Sequence[Mapping[str, object]]) -> int:
    n = 0
    for m in messages:
        content = m.get("content")
        if m.get("role") == "user" and isinstance(content, list):
            n += sum(1 for p in content if isinstance(p, Mapping) and p.get("type") == "image")
    return n


def _image_block(data_url: str, name: str) -> dict[str, Any] | None:
    """A stored `image_data_url` as an Anthropic image block, or None when
    the model cannot take it (type, size, encoding)."""
    m = _DATA_URL.match(data_url)
    if m is None or m.group(1) not in IMAGE_MEDIA_TYPES:
        return None
    try:
        return _part_block(_data_url_part(data_url, name))
    except (AttachmentRejected, binascii.Error, ValueError):
        return None


# --- Resolution + the hooks ---------------------------------------------------------------


@dataclass(frozen=True)
class _Resolved:
    items: tuple[ResolvedItem, ...]
    blocks: tuple[dict[str, Any], ...]


async def _resolve(ri: RunInput, opts: RunOptions, ctx: HookContext) -> _Resolved:
    atts: tuple[RunAttachment, ...] = opts.attachments
    cloud_ids = [a.file_id for a in atts if isinstance(a, FileAttachment)]
    rows = await _load_file_rows(ctx, cloud_ids) if cloud_ids else {}
    mcp = await _read_resources(
        ri, opts, ctx, [a for a in atts if isinstance(a, McpResourceAttachment)]
    )
    image_room = max(0, MAX_IMAGES - _history_images(ri.messages))
    items: list[ResolvedItem] = []
    blocks: list[dict[str, Any]] = []

    def add_block(block: dict[str, Any] | None) -> None:
        nonlocal image_room
        if block is None:
            return
        if block.get("type") == "image":
            if image_room <= 0:
                return
            image_room -= 1
        blocks.append(block)

    for a in atts:
        if isinstance(a, FileAttachment):
            row = rows.get(a.file_id.lower())
            if row is None:
                # Not the caller's, deleted, or not synced yet: name only.
                items.append(FileItem(a.name, a.size_bytes or 0, a.mime_type or ""))
                continue
            kind = row["extracted_kind"] or a.extracted_kind
            items.append(
                FileItem(
                    name=row["name"] or a.name,
                    size=int(row["size"] or 0),
                    type=row["type"] or "",
                    text=None if a.retrieval_mode == "rag" else row["extracted_text"],
                    truncated=a.retrieval_mode != "rag" and bool(row["extraction_truncated"]),
                    kind=kind,
                    retrieval_mode=a.retrieval_mode,
                    id=str(row["id"]),
                )
            )
            data_url = row["image_data_url"]
            if isinstance(data_url, str) and data_url:
                add_block(_image_block(data_url, row["name"] or a.name))
        elif isinstance(a, InlineFileAttachment):
            items.append(
                FileItem(
                    name=a.name,
                    size=a.size_bytes or 0,
                    type=a.mime_type or "",
                    text=a.text,
                    truncated=a.truncated,
                    kind=a.extracted_kind,
                )
            )
            if a.data_url:
                # A bad one was refused at the API (`check_attachment_input`).
                with contextlib.suppress(AttachmentRejected):
                    add_block(_part_block(_data_url_part(a.data_url, a.name)))
        elif isinstance(a, BookmarkAttachment):
            items.append(BookmarkItem(a.title, a.url, a.text, a.truncated, a.fetched_at))
    items.extend(mcp)
    return _Resolved(tuple(items), tuple(blocks))


def _has_rag_file(opts: RunOptions) -> bool:
    return any(
        isinstance(a, FileAttachment) and a.retrieval_mode == "rag" for a in opts.attachments
    )


def _search_files_offered(opts: RunOptions, ctx: HookContext) -> bool:
    """Whether the run offers `searchFiles` (it needs a `ToolContext`): the
    skill was asked for, or a RAG-mode file switched it on."""
    return ctx.tool_context is not None and ("searchFiles" in opts.skill_ids or _has_rag_file(opts))


async def attachment_context(ri: RunInput, opts: RunOptions, ctx: HookContext) -> str | None:
    """`PromptSection`: the attachment block and the meta-only footer, as
    the Next route's `buildSystemPrompt` appends them. Media loaded on the
    way (a cloud image, an inline file's `dataUrl`) goes to
    `ctx.scratch[TURN_CONTENT_KEY]` for the harness."""
    if not opts.attachments:
        return None
    resolved = await _resolve(ri, opts, ctx)
    if resolved.blocks:
        existing = ctx.scratch.get(TURN_CONTENT_KEY)
        ctx.scratch[TURN_CONTENT_KEY] = [
            *(existing if isinstance(existing, list) else []),
            *resolved.blocks,
        ]
    block = render_attachments_prompt(
        resolved.items, search_files_enabled=_search_files_offered(opts, ctx)
    )
    meta = render_meta_only_files_prompt([i for i in resolved.items if isinstance(i, FileItem)])
    return "\n\n".join(p for p in (block, meta) if p) or None


_KINDS: Mapping[type, str] = {
    FileAttachment: "file",
    InlineFileAttachment: "inlineFile",
    BookmarkAttachment: "bookmark",
    McpResourceAttachment: "mcpResource",
}


def attachment_context_taint(
    _ri: RunInput,
    opts: RunOptions,
    _ctx: HookContext,
    _history: Sequence[Mapping[str, object]],
) -> str | None:
    """`TaintSeed`: any attachment is third-party content (Next's
    `requestTaint`: "an attached file", "an attached URL bookmark", "an
    attached MCP resource")."""
    return attachment_taint(_KINDS.get(type(a), "attachment") for a in opts.attachments)


def rag_search_files(
    _ri: RunInput, opts: RunOptions, ctx: HookContext, draft: ToolsetDraft
) -> None:
    """`ToolContributor`: offer `searchFiles` when a RAG-mode file is
    attached — its text is not in the prompt, so the tool is the only way
    to it (the Next route force-enables the skill the same way). Needs a
    signed-in run with a database (`ToolContext`)."""
    if ctx.tool_context is None or "searchFiles" in draft.tools or not _has_rag_file(opts):
        return
    draft.tools["searchFiles"] = build_search_files_tool(ctx.tool_context)
