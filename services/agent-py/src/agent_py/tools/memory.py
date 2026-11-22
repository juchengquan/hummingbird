"""Cross-conversation memory on interactive runs — the remembered facts in
the system prompt and the `rememberFact` / `forgetFact` tools.

A port of what the Next chat route does with memory (`app/api/chat/route.ts`,
`lib/server/memory/{load-facts,render,tools,forget-match,untrusted-content-policy}.ts`):

* **State.** For a signed-in run with a database, one read gives
  `profiles.memory_enabled` and, when on, the user's active
  `user_memories` facts (newest first). `forwardedProps.memoryBypass`
  (the conversation's "memory off" mode) skips the read entirely, and an
  anonymous run has no memory — both see no facts and no tools. Any
  failure reads as "memory off" (never throws).
* **Prompt** (`memory_prompt_section`). When memory is on: the facts
  block (`render_memory_block`) and `MEMORY_TOOLS_NOTE`, so "remember"
  works with zero facts too.
* **Tools** (`memory_tools`). `rememberFact` inserts a fact
  (`source_conversation_id` null, as on Next — an interactive run's
  conversation may not have synced); `forgetFact` deletes the active
  facts `match_facts_to_forget` picks. Every query runs as the user
  (`store._set_user_context`), so the tables' RLS applies.
* **Prompt-injection guard.** Both tools refuse on a tainted turn — one
  whose context already holds third-party content (the request's, or an
  untrusted tool that ran earlier in the turn: the loop hands each call
  `RunToolContext.tainted_by` as it stands then) — with Next's refusal
  results (`remember_refusal` / `forget_refusal`). The refusal lives in
  the tools, so the loop needs no memory-specific code.

The tools' results are Next's JSON objects, verbatim (the model reads
them); the UI summary is the object's `error`, else `"done"` — the Next
route's tool-result summary rule.

The hook functions take the harness types only for annotations, so this
module imports nothing from `runs` at runtime (`runs` imports `tools`).
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import structlog

from .registry import (
    RunToolContext,
    ToolContext,
    ToolDescriptor,
    ToolError,
    ToolInvocationResult,
)

if TYPE_CHECKING:
    import asyncpg

    from ..runs.harness import RunInput
    from ..runs.hook_types import HookContext, ToolsetDraft
    from ..runs.options import RunOptions

logger = structlog.get_logger(__name__)

__all__ = [
    "FORGET_FACT_TOOL",
    "MEMORY_TOOLS_NOTE",
    "REMEMBER_FACT_TOOL",
    "MemoryFact",
    "MemoryState",
    "build_memory_tools",
    "delete_facts",
    "forget_refusal",
    "insert_fact",
    "load_active_facts_for_forget",
    "load_memory_state",
    "match_facts_to_forget",
    "memory_prompt_section",
    "memory_tools",
    "remember_refusal",
    "render_memory_block",
]

REMEMBER_FACT_TOOL = "rememberFact"
FORGET_FACT_TOOL = "forgetFact"

#: System-prompt nudge shown whenever the tools are offered (even with no
#: facts yet, so "remember" works from empty) — `MEMORY_TOOLS_NOTE`.
MEMORY_TOOLS_NOTE = (
    "When the user asks you to remember something about them, call `rememberFact`. "
    "When they ask you to forget something, call `forgetFact` with the exact text "
    "of the listed memory."
)

MAX_FACT_CHARS = 500
MAX_CATEGORY_CHARS = 40

_SCRATCH_KEY = "memory.state"


@dataclass(frozen=True)
class MemoryFact:
    fact: str
    category: str | None = None


@dataclass(frozen=True)
class MemoryState:
    enabled: bool
    facts: tuple[MemoryFact, ...] = ()


MEMORY_OFF = MemoryState(enabled=False)


# --- Pure helpers (render.ts, forget-match.ts, untrusted-content-policy.ts) ---------


def render_memory_block(facts: Sequence[MemoryFact]) -> str | None:
    """The always-on memory block, or None when there are no facts."""
    if not facts:
        return None
    lines = [f"- {f.fact}" for f in facts]
    return "\n".join(
        [
            "What you know about this user (they can view/edit/remove these in Settings → Memory):",
            *lines,
        ]
    )


def _norm(s: str) -> str:
    return s.strip().lower()


def match_facts_to_forget(facts: Sequence[tuple[str, str]], text: str) -> list[str]:
    """Which `(id, fact)` ids a forget request targets: exact
    (normalised) matches win; otherwise any fact that contains the text
    or is contained by it; otherwise none."""
    t = _norm(text)
    if not t:
        return []
    exact = [fid for fid, fact in facts if _norm(fact) == t]
    if exact:
        return exact
    return [fid for fid, fact in facts if t in _norm(fact) or _norm(fact) in t]


def remember_refusal(tainted_by: str) -> dict[str, object]:
    """Returned instead of saving on a tainted turn (`rememberRefusal`)."""
    return {
        "ok": False,
        "refused": True,
        "error": (
            f"Not saved: this turn already includes external content (via {tainted_by}), "
            "and memory can't be written in the same turn as attachments, web, file or "
            "tool lookups (protection against prompt injection from that content). Tell "
            "the user the fact was NOT remembered, and that they can ask you to remember "
            "it in a new message without attachments if they want it saved."
        ),
    }


def forget_refusal(tainted_by: str) -> dict[str, object]:
    """`forgetFact` counterpart of `remember_refusal` (`forgetRefusal`)."""
    return {
        "ok": False,
        "refused": True,
        "removed": 0,
        "error": (
            f"Not removed: this turn already includes external content (via {tainted_by}), "
            "and memory can't be changed in the same turn (protection against prompt "
            "injection from that content). Tell the user nothing was forgotten, and that "
            "they can ask again in a new message without attachments."
        ),
    }


# --- Database ----------------------------------------------------------------------


async def load_memory_state(pool: asyncpg.Pool, user_id: str) -> MemoryState:
    """`loadMemoryState`: memory on/off plus the active facts, newest
    first. Never throws — any failure is "memory off"."""
    from ..store import _set_user_context

    try:
        async with pool.acquire() as conn, conn.transaction():
            await _set_user_context(conn, user_id=user_id)
            enabled = await conn.fetchval(
                "SELECT memory_enabled FROM public.profiles WHERE id = $1::text::uuid", user_id
            )
            if not enabled:
                return MEMORY_OFF
            rows = await conn.fetch(
                "SELECT fact, category FROM public.user_memories "
                "WHERE status = 'active' AND user_id = $1::text::uuid "
                "ORDER BY updated_at DESC",
                user_id,
            )
    except Exception as exc:
        logger.info("memory.load_failed", error=str(exc)[:300])
        return MEMORY_OFF
    return MemoryState(
        enabled=True,
        facts=tuple(MemoryFact(fact=r["fact"], category=r["category"]) for r in rows),
    )


async def insert_fact(pool: asyncpg.Pool, user_id: str, fact: str, category: str | None) -> bool:
    """One `user_memories` insert as the user; False on any failure."""
    from ..store import _set_user_context

    try:
        async with pool.acquire() as conn, conn.transaction():
            await _set_user_context(conn, user_id=user_id)
            await conn.execute(
                "INSERT INTO public.user_memories "
                "(user_id, fact, category, source_conversation_id) "
                "VALUES ($1::text::uuid, $2, $3, NULL)",
                user_id,
                fact,
                category,
            )
    except Exception as exc:
        logger.info("memory.insert_failed", error=str(exc)[:300])
        return False
    return True


async def load_active_facts_for_forget(
    pool: asyncpg.Pool, user_id: str
) -> list[tuple[str, str]] | None:
    """The user's active `(id, fact)` rows, or None on failure."""
    from ..store import _set_user_context

    try:
        async with pool.acquire() as conn, conn.transaction():
            await _set_user_context(conn, user_id=user_id)
            rows = await conn.fetch(
                "SELECT id::text AS id, fact FROM public.user_memories "
                "WHERE status = 'active' AND user_id = $1::text::uuid",
                user_id,
            )
    except Exception as exc:
        logger.info("memory.forget_select_failed", error=str(exc)[:300])
        return None
    return [(r["id"], r["fact"]) for r in rows]


async def delete_facts(pool: asyncpg.Pool, user_id: str, ids: Sequence[str]) -> bool:
    """Delete these `user_memories` rows as the user; False on failure."""
    from ..store import _set_user_context

    try:
        async with pool.acquire() as conn, conn.transaction():
            await _set_user_context(conn, user_id=user_id)
            await conn.execute(
                "DELETE FROM public.user_memories "
                "WHERE id = ANY($1::text[]::uuid[]) AND user_id = $2::text::uuid",
                list(ids),
                user_id,
            )
    except Exception as exc:
        logger.info("memory.delete_failed", error=str(exc)[:300])
        return False
    return True


# --- Tools (tools.ts + the write policy) ----------------------------------------------


def _result(obj: dict[str, object]) -> ToolInvocationResult:
    error = obj.get("error")
    return ToolInvocationResult(
        text=json.dumps(obj, separators=(",", ":"), ensure_ascii=False),
        summary=error if isinstance(error, str) else "done",
    )


def _no_run_context(name: str) -> Any:
    async def execute(_args: dict[str, Any]) -> ToolInvocationResult:
        # Only the interactive loop (which passes the turn's taint) may
        # write memory; anything else is refused rather than unguarded.
        raise ToolError(f"{name} is only available in an interactive chat.")

    return execute


REMEMBER_FACT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "fact": {"type": "string", "minLength": 1, "maxLength": MAX_FACT_CHARS},
        "category": {"type": "string", "maxLength": MAX_CATEGORY_CHARS},
    },
    "required": ["fact"],
    "additionalProperties": False,
}

FORGET_FACT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"fact": {"type": "string", "minLength": 1, "maxLength": MAX_FACT_CHARS}},
    "required": ["fact"],
    "additionalProperties": False,
}


def _fact_arg(name: str, args: dict[str, Any]) -> str:
    fact = args.get("fact")
    if not isinstance(fact, str) or not fact or len(fact) > MAX_FACT_CHARS:
        raise ToolError(f"{name}: `fact` must be 1 to {MAX_FACT_CHARS} characters.")
    return fact


def build_memory_tools(context: ToolContext) -> tuple[ToolDescriptor, ToolDescriptor]:
    """`rememberFact` and `forgetFact` for the signed-in user of
    `context`, refusing on a tainted turn."""

    async def remember(args: dict[str, Any], run_ctx: RunToolContext) -> ToolInvocationResult:
        fact = _fact_arg(REMEMBER_FACT_TOOL, args)
        category = args.get("category")
        if category is not None and (
            not isinstance(category, str) or len(category) > MAX_CATEGORY_CHARS
        ):
            raise ToolError(
                f"{REMEMBER_FACT_TOOL}: `category` must be at most {MAX_CATEGORY_CHARS} characters."
            )
        if run_ctx.tainted_by is not None:
            return _result(remember_refusal(run_ctx.tainted_by))
        if not await insert_fact(context.pool, context.user_id, fact, category):
            return _result({"ok": False, "error": "could not save"})
        return _result({"ok": True})

    async def forget(args: dict[str, Any], run_ctx: RunToolContext) -> ToolInvocationResult:
        fact = _fact_arg(FORGET_FACT_TOOL, args)
        if run_ctx.tainted_by is not None:
            return _result(forget_refusal(run_ctx.tainted_by))
        rows = await load_active_facts_for_forget(context.pool, context.user_id)
        if rows is None:
            return _result({"ok": False, "removed": 0, "error": "could not remove"})
        ids = match_facts_to_forget(rows, fact)
        if not ids:
            return _result({"ok": True, "removed": 0, "note": "No matching memory found."})
        if not await delete_facts(context.pool, context.user_id, ids):
            return _result({"ok": False, "removed": 0, "error": "could not remove"})
        return _result({"ok": True, "removed": len(ids)})

    return (
        ToolDescriptor(
            name=REMEMBER_FACT_TOOL,
            description=(
                "Save a durable fact about the user to long-term memory (used across future "
                "chats). Call when the user asks you to remember something."
            ),
            input_schema=REMEMBER_FACT_SCHEMA,
            execute=_no_run_context(REMEMBER_FACT_TOOL),
            side_effecting=True,
            run_execute=remember,
        ),
        ToolDescriptor(
            name=FORGET_FACT_TOOL,
            description=(
                "Remove a remembered fact from long-term memory. Pass the exact text of the "
                "memory as shown in the listed memories."
            ),
            input_schema=FORGET_FACT_SCHEMA,
            execute=_no_run_context(FORGET_FACT_TOOL),
            side_effecting=True,
            run_execute=forget,
        ),
    )


# --- Harness hooks ---------------------------------------------------------------------


async def _memory_state(opts: RunOptions, ctx: HookContext) -> MemoryState:
    """The run's memory state, read once and shared by the contributor
    and the prompt section (`HookContext.scratch`)."""
    cached = ctx.scratch.get(_SCRATCH_KEY)
    if isinstance(cached, MemoryState):
        return cached
    context = ctx.tool_context
    if opts.memory_bypass or context is None:
        return MEMORY_OFF
    state = await load_memory_state(context.pool, context.user_id)
    ctx.scratch[_SCRATCH_KEY] = state
    return state


async def memory_tools(
    _ri: RunInput, opts: RunOptions, ctx: HookContext, draft: ToolsetDraft
) -> None:
    """`ToolContributor`: the remember / forget tools when memory is on
    for this run (signed in with a database, `memory_enabled`, no
    `memoryBypass`)."""
    state = await _memory_state(opts, ctx)
    if not state.enabled or ctx.tool_context is None:
        return
    for descriptor in build_memory_tools(ctx.tool_context):
        draft.tools[descriptor.name] = descriptor


async def memory_prompt_section(_ri: RunInput, opts: RunOptions, ctx: HookContext) -> str | None:
    """`PromptSection`: the facts block + `MEMORY_TOOLS_NOTE` when memory
    is on for this run, else nothing."""
    state = await _memory_state(opts, ctx)
    if not state.enabled:
        return None
    parts = [render_memory_block(state.facts), MEMORY_TOOLS_NOTE]
    return "\n\n".join(p for p in parts if p)
