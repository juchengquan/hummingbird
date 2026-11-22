"""Tool registry — descriptor + dispatch.

Each `ToolDescriptor` bundles the Anthropic-wire-format JSON schema
with an async `execute` callable. The executor lists descriptors when
calling `messages.stream(tools=[...])` and invokes `execute` itself
after the model emits a `tool_use` block (the SDK doesn't run tools
for us).

`ToolInvocationResult.text` is fed back to the model as the
`tool_result.content`; `summary` is the UI-pill text;
`source_results` is the optional Sources-strip rows (search-shaped
outputs use it, fetch-shaped don't).

`ToolContext` (Phase 3c-2) carries the per-run state any tool needs
to reach external systems on the user's behalf — today just the
asyncpg pool + the user_id (for RLS impersonation in `searchFiles`).
Tools that don't need it ignore it; tools that do close over it via
their `build_*_tool(context)` factory. It exists only for signed-in runs
with a database.

`RunToolContext` (wave 5a) is the run-scoped context that is always
there — anonymous runs included: the caller's `client_key`, a
`consume_budget(kind)` callback for per-IP tool budgets, the
`local_files_only` preference and the turn's memory taint so far. The
interactive loop (`chat_loop.execute_tool`) hands it to every tool that
declares `run_execute`; other tools keep their plain `execute`."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from ..events import ToolCallResult

if TYPE_CHECKING:
    import asyncpg


@dataclass(frozen=True)
class ToolInvocationResult:
    """What a tool's execute returns.

    `text` is what gets fed back to the model as the `tool_result.content`
    so it can reason over the output on the next step. `summary` is a
    one-line UI pill description. `source_results` is the optional
    structured rows that populate the Sources strip — set only when
    the tool's output is list-shaped (`webSearch`)."""

    text: str
    summary: str
    source_results: list[ToolCallResult] | None = None
    images: tuple[dict[str, object], ...] = ()
    """Images the tool produced, for the user (not the model): each
    `{url, storagePath?, width, height, format, prompt}`. The loop emits
    them as one `tool_image` part (`ToolImageEvent`), giving each an `id`
    (`<toolCallId>-<i>`) and `mode` (`image_mode`)."""
    image_mode: Literal["t2i", "i2i", "code"] = "t2i"
    files: tuple[dict[str, object], ...] = ()
    """Files the tool produced (`{name, sizeBytes, mimeType, url,
    storagePath?}` each), emitted as one `tool_file` part with ids
    `<toolCallId>-file-<i>` when absent."""
    mcp_app: McpAppPayload | None = None
    """An MCP App the tool renders (its `ui://` resource, read), emitted
    as one `mcp_app` part after the tool result (`McpAppEvent`,
    `hummingbird.mcp_app`). Set by MCP tools whose descriptor declares a
    `uiResourceUri` (wave 5b-D); None for every other tool."""


@dataclass(frozen=True)
class McpAppPayload:
    """What `McpAppEvent` carries besides the tool call id: the server, the
    bundled HTML (capped by the producer — `truncated` then says so) and
    the `ui://` resource it was read from (lets the client refresh it)."""

    server_id: str
    html: str = field(repr=False)
    resource_uri: str | None = None
    truncated: bool = False


@dataclass(frozen=True)
class ToolError(Exception):
    """Distinct from a raw exception so the executor can map it to a
    structured `step_error` event with a meaningful message instead of
    leaking a stack trace string. The `message` is what the model sees
    in the tool_result; the executor emits a step_error with the same
    text so the UI shows it too."""

    message: str

    def __str__(self) -> str:
        return self.message


# Async callable signature for `execute`. Receives the input dict the
# model sent (already validated by the SDK against `input_schema`),
# returns either a success result or raises `ToolError` on a
# user-friendly failure (anything else gets caught + wrapped).
ToolExecuteFn = Callable[[dict[str, Any]], Awaitable[ToolInvocationResult]]


@dataclass(frozen=True)
class BudgetVerdict:
    """What `RunToolContext.consume_budget` answers: whether the unit was
    taken, and when to retry if not. Truthy when allowed, so
    `if not ctx.consume_budget(kind)` reads naturally."""

    allowed: bool
    retry_after_sec: int = 0

    def __bool__(self) -> bool:
        return self.allowed


_ALLOWED = BudgetVerdict(allowed=True)


def _always(_kind: str) -> BudgetVerdict:
    return _ALLOWED


@dataclass(frozen=True)
class RunToolContext:
    """Run-scoped state for tools, present on every interactive run —
    signed in or anonymous (unlike `ToolContext`, which needs a database
    and a user). The native harness builds one per run
    (`hook_types.HookContext.run_tools`) and the loop hands it to each
    call, with `tainted_by` as it stands at that call. Defaults describe a
    run with no limits and no caller (tests, `/v1/chat`)."""

    run_id: str | None = None
    user_id: str | None = None
    """None for an anonymous run."""
    client_key: str | None = None
    """The caller's rate-limit key (client IP behind the trusted
    proxies, `rate_limit.rate_limit_key`); what per-IP budgets count."""
    local_files_only: bool = False
    """`forwardedProps.localFilesOnly`: return generated files as data
    URLs, never upload them to Storage."""
    consume_budget: Callable[[str], BudgetVerdict] = _always
    """Take one unit of the caller's per-IP budget `kind` (`"imageGen"`,
    or `"webTool"` for webSearch / webFetch / searchFiles, as the Next
    chat route buckets them); a falsy verdict means over the limit — the
    tool refuses with a `ToolError` naming `retry_after_sec`. The native
    harness wires the limiter (`rate_limit.ToolBudgets`); the default
    allows everything (tests, `/v1/chat`)."""
    tainted_by: str | None = None
    """The first untrusted tool (or other third-party content) in the
    turn before this call, else None — memory tools refuse to write
    when set."""


RunToolExecuteFn = Callable[[dict[str, Any], RunToolContext], Awaitable[ToolInvocationResult]]


@dataclass(frozen=True)
class ToolDescriptor:
    """One tool the agent can call. Matches Anthropic's tool wire
    format on the `name` / `description` / `input_schema` fields so
    `tool_to_anthropic_param(desc)` is essentially a pick-and-rename."""

    name: str
    description: str
    input_schema: dict[str, Any]
    execute: ToolExecuteFn
    # True when running the tool acts on the outside world (sends,
    # writes, deletes …) so running it twice is not harmless. A reclaimed
    # run never silently re-runs such a tool whose execution was
    # interrupted — see `agent_py.tool_ledger`. Every MCP tool sets it;
    # the built-in tools are read-only.
    side_effecting: bool = False
    run_execute: RunToolExecuteFn | None = None
    """Called instead of `execute`, with the run's `RunToolContext`, by
    the interactive loop (`chat_loop.execute_tool`). The background
    executor still calls `execute`, so a tool that sets this keeps
    `execute` working too (with no budget, no client key)."""


def tool_to_anthropic_param(tool: ToolDescriptor) -> dict[str, Any]:
    """Convert a descriptor to the dict the Anthropic SDK accepts in
    `messages.stream(tools=[...])`. Pure: doesn't call out, doesn't
    own the executor's invocation path — just shape mapping."""
    return {
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.input_schema,
    }


@dataclass(frozen=True)
class ToolContext:
    """Per-run state tools need to reach external systems on the user's
    behalf. Today: the asyncpg pool + the user's id (for RLS
    impersonation via `store._set_user_context`). Future tools (MCP
    cloud-mode, image storage) will read additional fields from this.

    `None` context means "no per-user state available" — tools that
    require it (e.g. `searchFiles`) are omitted from the registry.

    `workspace_id` (Phase 3f-2) opts the registry into cloud-mode MCP
    tool discovery — `extend_registry_with_mcp` walks the workspace's
    `mcp_servers` rows and registers each cached tool under
    `mcp__<server>__<tool>`. Tools that don't need it ignore it."""

    pool: asyncpg.Pool
    user_id: str
    workspace_id: str | None = None


@dataclass(frozen=True)
class SkillConfigs:
    """Per-skill overrides from the request body. Maps the TS
    `ChatRequestSchema.skills` array shape to the Python registry.

    Each field is a dict (or None) shaped like the matching TS sub-
    object — e.g. `web_search` ≈ `{maxCalls, tavily, brave, exa}`,
    `image_gen` ≈ `{maxCalls, aspectRatio}`. Each tool factory reads
    its own fields lazily; unknown keys are ignored so the wire
    contract can grow without coordination.

    Phase 4-3 follow-up — pre-existing chat requests omit it and
    every tool falls back to its built-in default cap."""

    web_search: dict[str, Any] | None = None
    web_fetch: dict[str, Any] | None = None
    image_gen: dict[str, Any] | None = None


def default_tool_registry(
    *,
    context: ToolContext | None = None,
    skill_configs: SkillConfigs | None = None,
) -> dict[str, ToolDescriptor]:
    """Process-wide default registry. The executor passes either the
    full list or a filtered subset (e.g. by checkpoint config) to the
    step fn factory.

    Tool inclusion is config-aware:
    - `webFetch` is unconditional — no upstream credential needed.
    - `webSearch` registers only when `TAVILY_API_KEY` is set (mirrors
      the TS skill-cascade behaviour where a missing provider hides
      the skill rather than surfacing a per-call error).
    - `searchFiles` registers only when `context` is provided (needs
      pool + user_id for the per-user RLS-impersonated RPC call).
      Tests + dev code that pass `context=None` see the same registry
      shape they did pre-Phase-3c-2.
    - `generateImage` registers only when `MINIMAX_CN_API_KEY` is set
      (mirrors the TS side's `isImageGenConfigured()` gate). Absent
      key → tool is omitted; the model is told as much by the
      prompt fragment when it ports. The tool reads the optional
      `context` so generated images can be persisted into Supabase
      Storage under the user's folder (Phase 3d-2). Without context
      it still works but URLs come back inline from Minimax.

    `skill_configs` (Phase 4-3 follow-up) threads the per-request
    skill overrides — `imageGenConfig.maxCalls` lands on
    `generateImage`'s per-turn cap, etc. Each factory clamps its
    own field; out-of-range values fall back to the built-in default
    (same defensive behaviour as the TS side's `clampMaxImageGenerations`).
    """
    # Lazy imports keep registry construction cheap and avoid
    # circular imports if a tool ever needs to read the registry.
    from .ask_user import build_ask_user_tool
    from .render_ui import build_render_ui_tool
    from .spawn_subagent import build_spawn_subagent_tool
    from .web_fetch import build_web_fetch_tool
    from .web_search import build_web_search_tool, is_web_search_configured

    out: dict[str, ToolDescriptor] = {
        "webFetch": build_web_fetch_tool(),
        # `askUser` + `renderUI` are no-execute HITL tools — they
        # always register and are always gated (see
        # `executor._gated_tools_from` + `input_policy.ALWAYS_GATED_
        # TOOL_NAMES`). The model can call them any turn; the runner
        # suspends instead of executing.
        "askUser": build_ask_user_tool(),
        "renderUI": build_render_ui_tool(),
        # `spawnSubagent` is a no-execute gated-shape tool — the executor
        # captures it as a SpawnDescriptor and fans out child tasks.
        "spawnSubagent": build_spawn_subagent_tool(),
    }
    if is_web_search_configured():
        out["webSearch"] = build_web_search_tool()
    if context is not None:
        from .search_files import build_search_files_tool

        out["searchFiles"] = build_search_files_tool(context)

    from .image_gen import build_image_gen_tool, is_image_gen_configured

    if is_image_gen_configured():
        image_cfg = skill_configs.image_gen if skill_configs else None
        out["generateImage"] = build_image_gen_tool(
            context=context,
            max_calls_per_turn=_clamp_max_calls(
                image_cfg.get("maxCalls") if image_cfg else None,
                default=2,
                lo=1,
                hi=50,
            ),
        )
    return out


def _clamp_max_calls(raw: Any, *, default: int, lo: int, hi: int) -> int:
    """Mirror of the TS side's `clamp*` helpers in
    `lib/shared/skills/image-gen-config.ts`. Coerces a client-side
    value (which might be a stringified number, a float, or absent)
    to a safe integer in [lo, hi], falling back to `default` for
    anything not parseable."""
    if raw is None:
        return default
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return default
    if n < lo:
        return lo
    if n > hi:
        return hi
    return n
