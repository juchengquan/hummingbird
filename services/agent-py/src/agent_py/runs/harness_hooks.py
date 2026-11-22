"""Which hooks the native harness runs, in order — and today's built-ins.

The extension points themselves (types, how each list is combined) are
`hook_types.py`. `DEFAULT_HOOKS` at the bottom is the registration: the
native harness (`build_native_harness`) uses it unless a test passes its
own. Today it reproduces the harness as it was before wave 5a, byte for
byte (`tests/test_harness_hooks.py` pins the system prompt).

**Wave 5b hooks — where each workstream plugs in.** Each adds one import
and one entry below (or replaces the single resolver / post-success
hook), and writes its hook in its own module:

| 5b | what | hook | module |
|---|---|---|---|
| B | attached-file context (budget, RAG notes with file ids, Q47), MCP resources, bookmarks | a `PromptSection` after `application_context` (media for the turn via `TURN_CONTENT_KEY`); a `TaintSeed` after `history_taint` (every attachment kind taints); a `ToolContributor` after the skills (`searchFiles` for RAG-mode files) — done | `runs/context.py` |
| C | memory facts in the prompt (unless `memory_bypass`) | a `PromptSection` | memory module |
| C | remember / forget tools (unless `memory_bypass`; refuse when `RunToolContext.tainted_by`) | a `ToolContributor` | memory module |
| C | reference image (`buildRemixNote`, with `imageGen`) | a `PromptSection` | remix module |
| C | `localFilesOnly`, per-IP image / web-tool budgets | `RunToolContext.local_files_only` / `consume_budget` (wire `NativeHarness(consume_budget=…)`) | `native_harness.build_native_harness` |
| C | `auto` model routing | replace `resolve_model` (and accept `auto` in `options.validate_run_options`) | routing module |
| C | citation checks (`verify_citations`; `verify_client.py`) | replace `post_success` (emit `VerificationEvent`) | verify module |
| D | local MCP tools (credentials: `RunInput.local_mcp_credentials`) | a `ToolContributor` after `cloud_mcp_tools` (`draft.gated` for `requiresApproval`) | `runs/local_mcp.py` |
| A, D | `allowedMcpServerIds` (Q48) | filter in `cloud_mcp_tools` and D's contributor | — |
| D | MCP Apps | set `ToolInvocationResult.mcp_app` in the MCP tool; the loop emits it | `mcp_tools.py` |

Background runs (5b-A) do not go through this harness yet: they run in
`executor.py` from `tasks.checkpoint`.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

import structlog

from ..chat_loop import LoopResult
from ..events import RoutedModelEvent
from ..input_policy import ASK_USER_TOOL_NAME, RENDER_UI_TOOL_NAME
from ..model_allowlist import AUTO_MODEL_ID, get_model_allowlist, resolve_optional_model
from ..routing import RouteSignals, route_model
from ..tools import default_tool_registry
from ..tools.image_gen import remix_note_section
from ..tools.memory import memory_prompt_section, memory_tools
from ..verify_client import citation_sources, verify_turn
from .context import attachment_context, attachment_context_taint, rag_search_files
from .harness import RunInput
from .history import last_user_index, last_user_text, request_taint, system_texts
from .hook_types import (
    HarnessHooks,
    HookContext,
    PromptSection,
    ResolvedModel,
    TaintSeed,
    ToolContributor,
    ToolsetDraft,
)
from .local_mcp import local_mcp_tools
from .model import RunResultData
from .options import RunOptions

logger = structlog.get_logger(__name__)

__all__ = [
    "DEFAULT_HOOKS",
    "HITL_TOOLS",
    "PROMPT_SECTIONS",
    "SKILL_TOOLS",
    "TAINT_SEEDS",
    "TOOL_CONTRIBUTORS",
    "app_system_prompt",
    "application_context",
    "cloud_mcp_tools",
    "history_system_texts",
    "history_taint",
    "resolve_model",
    "skill_tools",
    "succeeded_result",
]

#: `forwardedProps.skills[].id` → the backend tool it offers.
SKILL_TOOLS: Mapping[str, str] = {
    "webSearch": "webSearch",
    "webFetch": "webFetch",
    "imageGen": "generateImage",
    "searchFiles": "searchFiles",
}

#: Offered on every run; they always wait for the user (no execute path).
HITL_TOOLS: frozenset[str] = frozenset({ASK_USER_TOOL_NAME, RENDER_UI_TOOL_NAME})


# --- System prompt sections ---------------------------------------------------------


def app_system_prompt(_ri: RunInput, opts: RunOptions, _ctx: HookContext) -> str | None:
    """`forwardedProps.systemPrompt` — the composed workspace /
    conversation / persona prompt."""
    return opts.system_prompt


def history_system_texts(ri: RunInput, _opts: RunOptions, _ctx: HookContext) -> str | None:
    """The text of the history's `system` / `developer` messages."""
    return "\n\n".join(system_texts(ri.messages)) or None


def application_context(ri: RunInput, _opts: RunOptions, _ctx: HookContext) -> str | None:
    """AG-UI `context` entries, one line each."""
    lines = [
        f"- {c.get('description')}: {c.get('value')}"
        for c in ri.context
        if isinstance(c.get("description"), str) and isinstance(c.get("value"), str)
    ]
    return "Context from the application:\n" + "\n".join(lines) if lines else None


# --- Tool contributors ---------------------------------------------------------------


def skill_tools(ri: RunInput, opts: RunOptions, ctx: HookContext, draft: ToolsetDraft) -> None:
    """The skills the run asked for (`SKILL_TOOLS`) + `HITL_TOOLS`, built by
    `default_tool_registry` — with the user-scoped tools (`searchFiles`)
    when the run has a `ToolContext`."""
    registry = default_tool_registry(context=ctx.tool_context, skill_configs=opts.skill_configs)
    wanted = {SKILL_TOOLS[s] for s in opts.skill_ids if s in SKILL_TOOLS} | HITL_TOOLS
    draft.tools.update({name: d for name, d in registry.items() if name in wanted})


async def cloud_mcp_tools(
    ri: RunInput, _opts: RunOptions, ctx: HookContext, draft: ToolsetDraft
) -> None:
    """The workspace's cloud MCP tools (signed-in runs with a
    `workspaceId`); servers marked for approval gate their tools.
    Discovery failures are logged and skipped, as on `/v1/chat`."""
    # TODO(5b-A/5b-D): Q48 — keep only the servers in
    # `opts.allowed_mcp_server_ids` when it is not None.
    context = ctx.tool_context
    if context is None or not context.workspace_id:
        return
    from ..mcp_tools import extend_registry_with_mcp

    try:
        await extend_registry_with_mcp(
            draft.tools,
            pool=context.pool,
            user_id=context.user_id,
            workspace_id=context.workspace_id,
            gated_out=draft.gated,
        )
    except Exception as exc:
        logger.warning("native_harness.mcp_discovery_failed", run_id=ri.run_id, error=str(exc))


# --- Taint seeds ----------------------------------------------------------------------


def history_taint(
    _ri: RunInput,
    _opts: RunOptions,
    _ctx: HookContext,
    history: Sequence[Mapping[str, object]],
) -> str | None:
    """Third-party content the history puts in context (`request_taint`:
    an uploaded image / document, a tool result after the last user
    message)."""
    return request_taint(history)


# --- Model, result -------------------------------------------------------------------


async def resolve_model(ri: RunInput, opts: RunOptions, ctx: HookContext) -> ResolvedModel:
    """The allow-listed model the run asked for, else the service default
    (`UnknownModelError` otherwise). `auto` is routed (`routing.route_model`,
    the Next chat route's smart routing) between the catalog's routing
    pair and reported as a `routed_model` part; without an allowed pair
    it is an unknown model.

    The route signals are the Next route's, read from the history up to
    its last user message — on a resume too, so the resumed turn routes
    as the turn it continues did: that message's text, whether the run
    carries attachments, the number of user / assistant messages."""
    if opts.model == AUTO_MODEL_ID:
        pair = get_model_allowlist().routing
        if pair is not None:
            history = ri.messages[: last_user_index(ri.messages) + 1]
            decision = route_model(
                RouteSignals(
                    text=last_user_text(history),
                    has_attachments=bool(opts.attachments),
                    message_count=sum(1 for m in history if m.get("role") in ("user", "assistant")),
                ),
                pair,
            )
            logger.info(
                "native_harness.routed",
                run_id=ri.run_id,
                model=decision.model_id,
                tier=decision.tier,
                reason=decision.reason,
            )
            await ctx.emitter.emit(RoutedModelEvent, model=decision.model_id)
            return ResolvedModel(
                catalog_id=decision.model_id, api_id=resolve_optional_model(decision.model_id)
            )
    return ResolvedModel(catalog_id=opts.model, api_id=resolve_optional_model(opts.model))


async def succeeded_result(
    ri: RunInput, opts: RunOptions, ctx: HookContext, result: LoopResult
) -> RunResultData:
    """The turn's text and whether it read third-party content — after the
    citation check when the run asked for one (`verify_client.verify_turn`
    emits the `verification` part)."""
    await verify_turn(ri, opts, ctx, result)
    return RunResultData(text=result.text or None, memory_tainted=result.tainted_by is not None)


# --- Registration ------------------------------------------------------------------------

PROMPT_SECTIONS: tuple[PromptSection, ...] = (
    app_system_prompt,
    history_system_texts,
    application_context,
    attachment_context,
    memory_prompt_section,
    remix_note_section,
)
TOOL_CONTRIBUTORS: tuple[ToolContributor, ...] = (
    skill_tools,
    cloud_mcp_tools,
    local_mcp_tools,
    rag_search_files,
    memory_tools,
    citation_sources,
)
TAINT_SEEDS: tuple[TaintSeed, ...] = (
    history_taint,
    attachment_context_taint,
)

DEFAULT_HOOKS = HarnessHooks(
    prompt_sections=PROMPT_SECTIONS,
    tool_contributors=TOOL_CONTRIBUTORS,
    taint_seeds=TAINT_SEEDS,
    resolve_model=resolve_model,
    post_success=succeeded_result,
)
