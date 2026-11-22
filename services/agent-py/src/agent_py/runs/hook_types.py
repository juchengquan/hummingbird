"""The native harness's extension points — their types and how they run.

Wave 5a of `docs/PLAN-frontend-backend-split.md`. The native harness
(`native_harness.py`) builds a run from an ordered set of hooks
(`HarnessHooks`) instead of fixed code, so wave 5b's workstreams each add
their part without editing the same functions. *Which* hooks run, in
which order, is `harness_hooks.py`; this module only defines them (it
imports no hook, so a hook module can import it freely).

| hook | signature | combined |
|---|---|---|
| `PromptSection` | `(RunInput, RunOptions, HookContext) -> str \\| None` (sync or async) | in order; `None` / empty skipped; joined by a blank line |
| `ToolContributor` | `(RunInput, RunOptions, HookContext, ToolsetDraft) -> None` (sync or async) | in order, each adds to `draft.tools` / `draft.gated` |
| `TaintSeed` | `(RunInput, RunOptions, HookContext, history) -> str \\| None` | first non-None wins |
| `ModelResolver` | `async (RunInput, RunOptions, HookContext) -> ResolvedModel` | one |
| `PostSuccess` | `async (RunInput, RunOptions, HookContext, LoopResult) -> RunResultData` | one |

`HookContext` is built once per run, before the model is resolved, and
shared by every hook; `scratch` lets hooks of one workstream hand values
to each other (resolve attachments once, read them in a prompt section
and a taint seed).
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from ..chat_loop import LoopResult, UsageMeter
from ..emitter import RunEmitter
from ..tools import RunToolContext, ToolContext, ToolDescriptor
from .harness import CancelSignal, RunInput
from .model import RunResultData
from .options import RunOptions

__all__ = [
    "TURN_CONTENT_KEY",
    "HarnessHooks",
    "HookContext",
    "ModelResolver",
    "PostSuccess",
    "PromptSection",
    "ResolvedModel",
    "TaintSeed",
    "ToolContributor",
    "Toolset",
    "ToolsetDraft",
    "add_turn_content",
    "build_system_prompt",
    "build_toolset",
    "seed_taint",
]


@dataclass
class HookContext:
    """Per-run state every hook gets."""

    emitter: RunEmitter
    """The run's emitter — a hook may emit progress events (parts), never
    lifecycle ones (see `harness.py`)."""
    cancel: CancelSignal
    usage: UsageMeter
    """Count the tokens of any model call a hook makes (e.g. a verifier)."""
    pool: Any | None
    """The asyncpg pool for a signed-in run with a database, else None."""
    tool_context: ToolContext | None
    """User-scoped tool state (`pool` + `user_id` + `workspace_id`): set
    only for a signed-in run with a database."""
    run_tools: RunToolContext
    """Run-scoped tool state, always set (anonymous runs too): client key,
    per-IP budget, `localFilesOnly`. The loop hands it to every tool."""
    scratch: dict[str, object] = field(default_factory=dict)
    """Free for hooks: values one hook computes for another. One key is
    read by the harness itself: `TURN_CONTENT_KEY`."""


#: `HookContext.scratch` key: Anthropic content blocks (images, documents)
#: a prompt section loaded for the turn — e.g. a cloud file's image read
#: from its `files` row (`runs/context.py`). The harness puts them at the
#: start of the newest user message, after every prompt section has run
#: (`add_turn_content`). A list of dicts; absent = none.
TURN_CONTENT_KEY = "turn_content"


def add_turn_content(
    messages: list[dict[str, Any]], user_index: int, blocks: object
) -> list[dict[str, Any]]:
    """`messages` with `blocks` (see `TURN_CONTENT_KEY`) before the content
    of `messages[user_index]` — the turn's user message. Unchanged when
    there are no blocks or that message is not the user's. Copies the one
    message it changes."""
    if not isinstance(blocks, list) or not blocks:
        return messages
    if not 0 <= user_index < len(messages) or messages[user_index].get("role") != "user":
        return messages
    target = messages[user_index]
    content = target.get("content")
    existing: list[Any] = (
        list(content)
        if isinstance(content, list)
        else ([{"type": "text", "text": content}] if isinstance(content, str) and content else [])
    )
    out = list(messages)
    out[user_index] = {**target, "content": [*blocks, *existing]}
    return out


@dataclass(frozen=True)
class Toolset:
    """The backend tools a run may call, and which of them wait for
    approval because their server says so (MCP)."""

    tools: Mapping[str, ToolDescriptor]
    gated: frozenset[str] = frozenset()


@dataclass
class ToolsetDraft:
    """What the tool contributors build, in order (a later contributor
    sees — and may replace — what an earlier one added)."""

    tools: dict[str, ToolDescriptor] = field(default_factory=dict)
    gated: set[str] = field(default_factory=set)
    """Tool names that wait for the user's approval (on top of the run's
    `requireApprovalFor` and the always-gated HITL / client tools)."""

    def freeze(self) -> Toolset:
        return Toolset(tools=dict(self.tools), gated=frozenset(self.gated))


@dataclass(frozen=True)
class ResolvedModel:
    catalog_id: str | None
    """The catalog id (`config/models.json`) the run uses — what
    capability lookups (`supportsReasoningEffort`) key on; None = the
    service default."""
    api_id: str
    """What is sent to the provider."""


PromptSection = Callable[[RunInput, RunOptions, HookContext], "str | None | Awaitable[str | None]"]
ToolContributor = Callable[
    [RunInput, RunOptions, HookContext, ToolsetDraft], "None | Awaitable[None]"
]
TaintSeed = Callable[
    [RunInput, RunOptions, HookContext, Sequence[Mapping[str, object]]], "str | None"
]
"""`history` is the AG-UI messages the model input is built from — the
whole history, or on a resume from a checkpoint the part up to the last
user message (the interrupted turn's own taint is in the checkpoint)."""
ModelResolver = Callable[[RunInput, RunOptions, HookContext], Awaitable[ResolvedModel]]
"""Raises `model_allowlist.UnknownModelError` to fail the run
`unknown_model`."""
PostSuccess = Callable[[RunInput, RunOptions, HookContext, LoopResult], Awaitable[RunResultData]]
"""After the loop succeeded (its step closed), before the run ends: the
run's result. May emit parts (e.g. `VerificationEvent`)."""


@dataclass(frozen=True)
class HarnessHooks:
    prompt_sections: tuple[PromptSection, ...]
    tool_contributors: tuple[ToolContributor, ...]
    taint_seeds: tuple[TaintSeed, ...]
    resolve_model: ModelResolver
    post_success: PostSuccess


async def _settle[T](value: T | Awaitable[T]) -> T:
    if inspect.isawaitable(value):
        return await value
    return value


async def build_system_prompt(
    sections: Sequence[PromptSection], run_input: RunInput, opts: RunOptions, ctx: HookContext
) -> str | None:
    parts: list[str] = []
    for section in sections:
        text = await _settle(section(run_input, opts, ctx))
        if text:
            parts.append(text)
    return "\n\n".join(parts) or None


async def build_toolset(
    contributors: Sequence[ToolContributor],
    run_input: RunInput,
    opts: RunOptions,
    ctx: HookContext,
) -> Toolset:
    draft = ToolsetDraft()
    for contribute in contributors:
        await _settle(contribute(run_input, opts, ctx, draft))
    return draft.freeze()


def seed_taint(
    seeds: Sequence[TaintSeed],
    run_input: RunInput,
    opts: RunOptions,
    ctx: HookContext,
    history: Sequence[Mapping[str, object]],
) -> str | None:
    for seed in seeds:
        label = seed(run_input, opts, ctx, history)
        if label is not None:
            return label
    return None
