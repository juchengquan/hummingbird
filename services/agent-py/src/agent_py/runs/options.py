"""A run's options — `forwardedProps` (`RunForwardedProps`), parsed.

The API has already validated the contract's keys (`models.StartRunRequest`),
so parsing here is lenient: a value of the wrong shape is skipped, unknown
keys are ignored. `RunInput.options` holds the JSON (camelCase); every
consumer — the native harness and its hooks (`harness_hooks.py`), the
background start state (`run_input.background_checkpoint`) — reads it
through `parse_run_options`.

Contract 0.4.0 added the options of the Phase 3 catch-up (Q32). They are
parsed and typed here and reach the harness hooks, but nothing acts on
them yet — wave 5b does:

| key | field | 5b |
|---|---|---|
| `research` | `research` | A (background research prompt, Q46) |
| `allowedMcpServerIds` | `allowed_mcp_server_ids` | A + D (Q48) |
| `attachments[]` | `attachments` (`FileAttachment` / `InlineFileAttachment` / `BookmarkAttachment` / `McpResourceAttachment`) | B |
| `memoryBypass` | `memory_bypass` | C |
| `verifyCitations` | `verify_citations` | C |
| `referenceImage` | `reference_image` | C |
| `localFilesOnly` | `local_files_only` | C |
| `localMcpServers[]` | `local_mcp_servers` (`LocalMcpServer`) | D |
| `sandboxFiles[]` (0.5.2) | `sandbox_files` (`MountManifestEntry`) | wave 8: `runCode`'s mounts |

Local MCP **credentials** are not options: they ride in `state`
(`runs.credentials`).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from ..chat_loop import DEFAULT_MAX_STEPS
from ..code_sandbox.mount_files import MountManifestEntry
from ..model_allowlist import (
    AUTO_MODEL_ID,
    TaskModelError,
    get_model_allowlist,
    resolve_optional_model,
)
from ..reasoning_effort import ReasoningEffort, parse_reasoning_effort
from ..tools import SkillConfigs

__all__ = [
    "MAX_STEPS_CAP",
    "BookmarkAttachment",
    "FileAttachment",
    "InlineFileAttachment",
    "LocalMcpServer",
    "LocalMcpTool",
    "McpResourceAttachment",
    "ReferenceImage",
    "RunAttachment",
    "RunOptions",
    "parse_run_options",
    "validate_run_options",
]

MAX_STEPS_CAP = 50


# --- Attachments (`RunAttachment`, Q44) ------------------------------------------------


@dataclass(frozen=True)
class FileAttachment:
    """`kind: file` — a cloud file by id; the backend loads its text after
    checking the caller owns it (signed-in runs only)."""

    file_id: str
    name: str
    mime_type: str | None = None
    size_bytes: int | None = None
    extracted_kind: str | None = None
    retrieval_mode: Literal["inline", "rag"] = "inline"


@dataclass(frozen=True)
class InlineFileAttachment:
    """`kind: inlineFile` — a browser-only file by value (its extracted
    text, or a small file's bytes as a `data:` URL)."""

    name: str
    mime_type: str | None = None
    size_bytes: int | None = None
    extracted_kind: str | None = None
    text: str | None = field(default=None, repr=False)
    truncated: bool = False
    data_url: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class BookmarkAttachment:
    """`kind: bookmark` — a URL bookmark with its fetched text (capped)."""

    url: str
    title: str
    text: str = field(default="", repr=False)
    truncated: bool = False
    fetched_at: str | None = None
    id: str | None = None


@dataclass(frozen=True)
class McpResourceAttachment:
    """`kind: mcpResource` — read from the server `server_id` (a cloud
    server of the workspace, or one of `local_mcp_servers`)."""

    server_id: str
    uri: str
    name: str
    mime_type: str | None = None
    id: str | None = None


RunAttachment = FileAttachment | InlineFileAttachment | BookmarkAttachment | McpResourceAttachment


# --- Local MCP servers (Q42) ------------------------------------------------------------


@dataclass(frozen=True)
class LocalMcpTool:
    name: str
    description: str | None = None
    input_schema: dict[str, Any] | None = None
    ui_resource_uri: str | None = None


@dataclass(frozen=True)
class LocalMcpServer:
    """A local-mode server and its cached tools. Its credential, if any,
    is `RunInput.local_mcp_credentials[id]`."""

    id: str
    name: str
    url: str
    requires_approval: bool = False
    tools: tuple[LocalMcpTool, ...] = ()


@dataclass(frozen=True)
class ReferenceImage:
    """The image-to-image reference (`buildRemixNote` on Next)."""

    url: str


# --- Options ----------------------------------------------------------------------------


@dataclass(frozen=True)
class RunOptions:
    """`forwardedProps`, parsed leniently (the API validated the
    contract's keys; unknown keys are ignored)."""

    model: str | None = None
    system_prompt: str | None = None
    skill_ids: tuple[str, ...] = ()
    skill_configs: SkillConfigs = field(default_factory=SkillConfigs)
    max_steps: int = DEFAULT_MAX_STEPS
    require_approval_for: frozenset[str] = frozenset()
    workspace_id: str | None = None
    reasoning_effort: ReasoningEffort | None = None
    # Contract 0.4.0 — parsed, not acted on yet (see the module docstring).
    research: bool = False
    allowed_mcp_server_ids: tuple[str, ...] | None = None
    """None: no restriction; `()`: no MCP tools at all."""
    attachments: tuple[RunAttachment, ...] = ()
    memory_bypass: bool = False
    verify_citations: bool = False
    reference_image: ReferenceImage | None = None
    local_files_only: bool = False
    local_mcp_servers: tuple[LocalMcpServer, ...] = ()
    sandbox_files: tuple[MountManifestEntry, ...] = ()
    """The files `runCode` may mount (wave 8): cloud ones by id, a
    signed-out caller's with their bytes."""


def _sandbox_file(raw: object) -> MountManifestEntry | None:
    if not isinstance(raw, Mapping):
        return None
    name, file_id = _str(raw.get("name")), _str(raw.get("fileId"))
    if name is None or file_id is None:
        return None
    data = raw.get("dataBase64")
    return MountManifestEntry(
        name=name, file_id=file_id, data_base64=data if isinstance(data, str) else None
    )


def _str(value: object, *, max_len: int | None = None) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value if max_len is None else value[:max_len]


def _opt_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _flag(value: object) -> bool:
    return value is True


def _attachment(raw: object) -> RunAttachment | None:
    if not isinstance(raw, Mapping):
        return None
    kind = raw.get("kind")
    if kind == "file":
        file_id, name = _str(raw.get("fileId")), _str(raw.get("name"))
        if file_id is None or name is None:
            return None
        return FileAttachment(
            file_id=file_id,
            name=name,
            mime_type=_opt_str(raw.get("mimeType")),
            size_bytes=_int(raw.get("sizeBytes")),
            extracted_kind=_opt_str(raw.get("extractedKind")),
            retrieval_mode="rag" if raw.get("retrievalMode") == "rag" else "inline",
        )
    if kind == "inlineFile":
        name = _str(raw.get("name"))
        if name is None:
            return None
        return InlineFileAttachment(
            name=name,
            mime_type=_opt_str(raw.get("mimeType")),
            size_bytes=_int(raw.get("sizeBytes")),
            extracted_kind=_opt_str(raw.get("extractedKind")),
            text=_opt_str(raw.get("text")),
            truncated=_flag(raw.get("truncated")),
            data_url=_opt_str(raw.get("dataUrl")),
        )
    if kind == "bookmark":
        url, title = _str(raw.get("url")), _str(raw.get("title"))
        if url is None or title is None:
            return None
        text = raw.get("text")
        return BookmarkAttachment(
            url=url,
            title=title,
            text=text if isinstance(text, str) else "",
            truncated=_flag(raw.get("truncated")),
            fetched_at=_opt_str(raw.get("fetchedAt")),
            id=_opt_str(raw.get("id")),
        )
    if kind == "mcpResource":
        server_id, uri, name = (
            _str(raw.get("serverId")),
            _str(raw.get("uri")),
            _str(raw.get("name")),
        )
        if server_id is None or uri is None or name is None:
            return None
        return McpResourceAttachment(
            server_id=server_id,
            uri=uri,
            name=name,
            mime_type=_opt_str(raw.get("mimeType")),
            id=_opt_str(raw.get("id")),
        )
    return None


def _local_server(raw: object) -> LocalMcpServer | None:
    if not isinstance(raw, Mapping):
        return None
    sid, name, url = _str(raw.get("id")), _str(raw.get("name")), _str(raw.get("url"))
    if sid is None or name is None or url is None:
        return None
    caps = raw.get("capabilities")
    raw_tools = caps.get("tools") if isinstance(caps, Mapping) else None
    tools: list[LocalMcpTool] = []
    for t in raw_tools if isinstance(raw_tools, list) else []:
        if not isinstance(t, Mapping) or _str(t.get("name")) is None:
            continue
        schema = t.get("inputSchema")
        tools.append(
            LocalMcpTool(
                name=str(t["name"]),
                description=_opt_str(t.get("description")),
                input_schema=dict(schema) if isinstance(schema, Mapping) else None,
                ui_resource_uri=_opt_str(t.get("uiResourceUri")),
            )
        )
    return LocalMcpServer(
        id=sid,
        name=name,
        url=url,
        requires_approval=_flag(raw.get("requiresApproval")),
        tools=tuple(tools),
    )


def _list(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def parse_run_options(options: Mapping[str, object]) -> RunOptions:
    skill_ids: list[str] = []
    web_search: dict[str, Any] | None = None
    web_fetch: dict[str, Any] | None = None
    image_gen: dict[str, Any] | None = None
    for entry in _list(options.get("skills")):
        if not isinstance(entry, Mapping):
            continue
        skill_id = _str(entry.get("id"))
        if skill_id is not None:
            skill_ids.append(skill_id)
        for key, setter in (
            ("webSearchConfig", "web_search"),
            ("webFetchConfig", "web_fetch"),
            ("imageGenConfig", "image_gen"),
        ):
            cfg = entry.get(key)
            if isinstance(cfg, dict) and cfg:
                if setter == "web_search":
                    web_search = cfg
                elif setter == "web_fetch":
                    web_fetch = cfg
                else:
                    image_gen = cfg
    max_steps = options.get("maxSteps")
    gated = options.get("requireApprovalFor")
    allowed = options.get("allowedMcpServerIds")
    ref = options.get("referenceImage")
    ref_url = _str(ref.get("url")) if isinstance(ref, Mapping) else None
    return RunOptions(
        model=_str(options.get("model")),
        system_prompt=_str(options.get("systemPrompt")),
        skill_ids=tuple(skill_ids),
        skill_configs=SkillConfigs(web_search=web_search, web_fetch=web_fetch, image_gen=image_gen),
        max_steps=(
            min(max_steps, MAX_STEPS_CAP)
            if isinstance(max_steps, int) and not isinstance(max_steps, bool) and max_steps >= 1
            else DEFAULT_MAX_STEPS
        ),
        require_approval_for=frozenset(
            g for g in (gated if isinstance(gated, list) else []) if isinstance(g, str) and g
        ),
        workspace_id=_str(options.get("workspaceId"), max_len=64),
        reasoning_effort=parse_reasoning_effort(options.get("reasoningEffort")),
        research=_flag(options.get("research")),
        allowed_mcp_server_ids=(
            tuple(dict.fromkeys(s for s in allowed if isinstance(s, str) and s))
            if isinstance(allowed, list)
            else None
        ),
        attachments=tuple(
            a for a in (_attachment(r) for r in _list(options.get("attachments"))) if a is not None
        ),
        memory_bypass=_flag(options.get("memoryBypass")),
        verify_citations=_flag(options.get("verifyCitations")),
        reference_image=None if ref_url is None else ReferenceImage(ref_url),
        local_files_only=_flag(options.get("localFilesOnly")),
        local_mcp_servers=tuple(
            s
            for s in (_local_server(r) for r in _list(options.get("localMcpServers")))
            if s is not None
        ),
        sandbox_files=tuple(
            f
            for f in (_sandbox_file(r) for r in _list(options.get("sandboxFiles")))
            if f is not None
        ),
    )


def validate_run_options(options: Mapping[str, object]) -> None:
    """Raise `UnknownModelError` (`code = "unknown_model"`) for a model
    outside the allow-list — lets the API answer 400 before creating the
    run, as `/v1/chat` does. The adapter re-checks and fails the run.
    `auto` passes on an interactive run when the catalog's routing pair
    is allowed here.

    The shapes of the other options are the contract's (`StartRunRequest`
    validation, 422). Checks that depend on the run — local MCP on a
    background run (Q42) — are the router's (`routers/runs.py`)."""
    model = parse_run_options(options).model
    # `auto` is routed by the interactive harness's model resolver
    # (`harness_hooks.resolve_model`) — allowed when the catalog's
    # routing pair is (both entries `anthropic/*`). The background
    # executor has no router, so there it stays unknown.
    if (
        model == AUTO_MODEL_ID
        and options.get("mode") != "background"
        and get_model_allowlist().routing is not None
    ):
        return
    resolve_optional_model(model)
    if options.get("mode") == "background":
        # Q117: a task calls tools; a model that can't is refused up front.
        allowlist = get_model_allowlist()
        if not allowlist.supports_tools(model):
            raise TaskModelError(model or allowlist.default_model)
