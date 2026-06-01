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
their `build_*_tool(context)` factory."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

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
class ToolDescriptor:
    """One tool the agent can call. Matches Anthropic's tool wire
    format on the `name` / `description` / `input_schema` fields so
    `tool_to_anthropic_param(desc)` is essentially a pick-and-rename."""

    name: str
    description: str
    input_schema: dict[str, Any]
    execute: ToolExecuteFn


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
    from .web_fetch import build_web_fetch_tool
    from .web_search import build_web_search_tool, is_web_search_configured

    out: dict[str, ToolDescriptor] = {
        "webFetch": build_web_fetch_tool(),
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
