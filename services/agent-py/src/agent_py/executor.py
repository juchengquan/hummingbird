"""Executor — wires claim → run_agent_loop → settle.

Phase 2a-2b of PLAN-agent-api. The poller hands a claimed `start` job
here; this module:

  1. Stamps `tasks.metadata.handler = 'python'` for postmortem audit.
  2. Loads the run's checkpoint (model / system / messages) and
     builds the step fn — Anthropic streaming when configured,
     stub when not.
  3. Builds a `RunEmitter` whose sink persists into `task_events`.
  4. Calls `run_agent_loop` with the step fn.
  5. Updates the `tasks` row to terminal status when the loop settles.

Phase 2a shipped the executor pattern with a stub step fn that emits
two canned tokens. Phase 2b-1 (this PR) wires `make_anthropic_step_fn`
in as the default when `ANTHROPIC_API_KEY` is set — text-only
streaming, no tools yet. Tools land in Phase 2b-2; HITL pause /
resume land in Phase 3.

The seam is `make_step_fn` — a `Callable[[StartActionPayload, dict],
RunStepFn]` so tests can swap a fake without touching the live
Anthropic SDK or the checkpoint loader.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import asyncpg
import structlog

from . import store
from .emitter import EventSink, RunEmitter
from .events import TaskEvent
from .providers.anthropic_provider import (
    AnthropicStepConfig,
    AsyncAnthropicClient,
    make_anthropic_step_fn,
)
from .runner import (
    AgentLoopResult,
    RunStepContext,
    RunStepFn,
    RunStepOutcome,
    run_agent_loop,
)
from .settings import get_settings

logger = structlog.get_logger(__name__)


# Step-fn factory signature: the executor loads the run's checkpoint
# (model + system + messages from `tasks.checkpoint`) and hands both
# the payload and the loaded checkpoint to the factory. Tests pass a
# fake that ignores the args and returns a canned `RunStepFn`.
MakeStepFn = Callable[["StartActionPayload", dict[str, Any]], RunStepFn]


@dataclass(frozen=True)
class StartActionPayload:
    """Minimum the executor needs to run a `start` action. The real
    run state — model, system prompt, message history, max_steps —
    lives on `tasks.checkpoint` and is read by the executor before
    building the step fn (Phase 2b)."""

    run_id: str
    user_id: str
    # Fallback max_steps when the checkpoint doesn't carry one. The
    # TS route always writes `maxSteps` so the fallback effectively
    # only fires in tests / dev seeds.
    max_steps: int = 25


@dataclass(frozen=True)
class ExecutorOutcome:
    """Result of executing one `start` action. Used by the poller to
    decide whether to `mark_job_done` or `mark_job_failed`."""

    settled: bool
    error: str | None = None


async def execute_start(
    pool: asyncpg.Pool,
    payload: StartActionPayload,
    *,
    make_step_fn: MakeStepFn | None = None,
) -> ExecutorOutcome:
    """Run a `start` action end-to-end.

    The contract the poller depends on:
      - On success → returns `ExecutorOutcome(settled=True)`. The
        `tasks` row is `status='done'`, `finished_at` set.
      - On model / tool / DB error → returns
        `ExecutorOutcome(settled=False, error=...)`. The poller
        marks the job failed; the row gets a synthetic
        `result: failed` event.

    Cancellation (`tasks.status='cancelled'` flipped out-of-band)
    is observed between steps; the loop emits `status: cancelled`
    and returns with `settled=True` (the cancel landed cleanly).
    """
    sink = _make_db_sink(pool, user_id=payload.user_id)
    emitter = RunEmitter(run_id=payload.run_id, sink=sink)

    try:
        await store.set_task_handler(
            pool,
            run_id=payload.run_id,
            user_id=payload.user_id,
            handler="python",
        )

        # Phase 2b: load the checkpoint that the TS route wrote when it
        # accepted this task. Carries the model id, system prompt, and
        # the user's message history that the step fn needs to call
        # the model. None = row missing or null checkpoint; fall back
        # to the stub so the run settles cleanly with a synthetic
        # answer instead of stalling.
        checkpoint = await store.load_checkpoint(
            pool,
            run_id=payload.run_id,
            user_id=payload.user_id,
        )
        if checkpoint is None:
            logger.warning(
                "executor.no_checkpoint",
                run_id=payload.run_id,
                user_id=payload.user_id,
            )
            checkpoint = {}

        step_fn = (make_step_fn or _default_make_step_fn)(payload, checkpoint)
        max_steps = _max_steps_from(checkpoint, payload.max_steps)

        async def is_cancelled() -> bool:
            return await store.is_run_cancelled(
                pool,
                run_id=payload.run_id,
                user_id=payload.user_id,
            )

        result: AgentLoopResult = await run_agent_loop(
            emitter=emitter,
            max_steps=max_steps,
            run_step=step_fn,
            is_cancelled=is_cancelled,
        )

        # Reflect terminal status into the `tasks` row. The emitter
        # already wrote the terminal event; this is just the table
        # state the UI reads when it doesn't want to fold events.
        if result.kind == "cancelled":
            await store.update_run(
                pool,
                run_id=payload.run_id,
                user_id=payload.user_id,
                status="cancelled",
                finished=True,
            )
        else:
            await store.update_run(
                pool,
                run_id=payload.run_id,
                user_id=payload.user_id,
                status="done",
                step=emitter.step,
                finished=True,
            )
        return ExecutorOutcome(settled=True)

    except Exception as exc:
        # Anything that escapes the loop is a fault in the executor
        # plumbing itself (the loop's own errors emit `result:
        # failed` via the step fn). Mark the row failed + emit a
        # synthetic terminal event so the UI doesn't show a stuck
        # `running`.
        logger.error(
            "executor.failed",
            run_id=payload.run_id,
            user_id=payload.user_id,
            error=str(exc),
        )
        try:
            if not emitter.settled:
                await emitter.result("failed", error=str(exc))
            await store.update_run(
                pool,
                run_id=payload.run_id,
                user_id=payload.user_id,
                status="failed",
                finished=True,
            )
        except Exception:
            # If even the cleanup writes fail, the job-fail path in
            # the poller will still leave the row recoverable.
            pass
        return ExecutorOutcome(settled=False, error=str(exc))


# --- internals -------------------------------------------------------------


def _make_db_sink(pool: asyncpg.Pool, *, user_id: str) -> EventSink:
    """Build an event sink that persists each event into task_events.

    Phase 2b can wrap this to also fan out to a Realtime stream so
    the chat panel sees events as they happen rather than via the
    DB Realtime publication. For now, the publication does the
    fan-out work.
    """

    async def sink(event: TaskEvent) -> None:
        await store.append_event(pool, event, user_id=user_id)

    return sink


# Lazy import + memo for the Anthropic client. Pulled in once per
# process, never if the API key is unset. Keeping the import lazy
# also avoids paying anthropic's import cost in test runs that use
# only the stub or a fake client.
_anthropic_client: AsyncAnthropicClient | None = None


def _resolve_anthropic_client() -> AsyncAnthropicClient | None:
    global _anthropic_client
    if _anthropic_client is not None:
        return _anthropic_client
    api_key = get_settings().ANTHROPIC_API_KEY
    if not api_key:
        return None
    # Real SDK import — only paid for when configured. Tests that
    # need a step fn bypass this via the `make_step_fn` injection
    # point, so this branch never runs under pytest.
    from anthropic import AsyncAnthropic

    # mypy doesn't see that the SDK satisfies our Protocol via
    # structural subtyping here — the Protocol's `messages.stream`
    # signature is intentionally narrower than the SDK's full
    # overload set.
    _anthropic_client = AsyncAnthropic(api_key=api_key)  # type: ignore[assignment]
    return _anthropic_client


def _default_make_step_fn(
    payload: StartActionPayload,
    checkpoint: dict[str, Any],
) -> RunStepFn:
    """Default step-fn picker.

    Phase 2b-1 strategy: prefer Anthropic streaming when configured;
    fall back to the Phase 2a stub when the API key is unset OR the
    checkpoint is incomplete (no model / no messages). The stub keeps
    development + CI runnable without any provider credentials.
    """
    client = _resolve_anthropic_client()
    model = _str_or_none(checkpoint.get("config", {}).get("model"))
    messages = _messages_from(checkpoint)
    system = _str_or_none(checkpoint.get("config", {}).get("workspaceSystemPrompt"))

    if client is None or not model or not messages:
        logger.info(
            "executor.using_stub_step_fn",
            run_id=payload.run_id,
            reason=(
                "no_api_key"
                if client is None
                else ("no_model" if not model else "no_messages")
            ),
        )
        return _stub_step_fn

    return make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model=model,
            system=system,
            messages=messages,
        )
    )


async def _stub_step_fn(ctx: RunStepContext) -> RunStepOutcome:
    """Canned step — emits two tokens of placeholder text and
    declares the step done. Used in dev / CI when no Anthropic key is
    configured AND when a checkpoint is missing fields. Phase 2b-2
    extends the default factory to also wire tools; the stub stays
    as the no-credential fallback."""
    await ctx.emitter.token("Phase 2a stub: ")
    await ctx.emitter.token("(set ANTHROPIC_API_KEY to enable real model streaming)")
    return RunStepOutcome(done=True)


# --- checkpoint coercion ----------------------------------------------------

def _max_steps_from(checkpoint: dict[str, Any], fallback: int) -> int:
    """Pull `config.maxSteps` from the checkpoint, falling back to the
    payload's value when missing. Bounded to a reasonable positive
    int to defend against a malformed jsonb."""
    cfg = checkpoint.get("config") if isinstance(checkpoint, dict) else None
    if not isinstance(cfg, dict):
        return fallback
    raw = cfg.get("maxSteps")
    if isinstance(raw, int) and raw > 0:
        return raw
    return fallback


def _messages_from(checkpoint: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract `messages` from the checkpoint as Anthropic-shaped
    dicts.

    The TS side stores `ModelMessage[]` from the AI SDK — a discriminated
    union with `role` + `content` (string or content-parts array). For
    Phase 2b-1 we only forward text content; multimodal (images, file
    parts) lands when tool support arrives in 2b-2. A part with no
    extractable text is dropped silently."""
    raw = checkpoint.get("messages")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        role = entry.get("role")
        if role not in ("user", "assistant"):
            # `system` is hoisted out (Anthropic takes it as a separate
            # `system=` arg); `tool` messages aren't in scope until
            # tool support lands.
            continue
        text = _entry_text(entry.get("content"))
        if not text:
            continue
        out.append({"role": role, "content": text})
    return out


def _entry_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if isinstance(p, dict) and p.get("type") == "text":
                t = p.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "".join(parts)
    return ""


def _str_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


# Re-export so callers (and the poller) can wire a custom step fn
# without depending on private internals.
__all__ = [
    "ExecutorOutcome",
    "MakeStepFn",
    "StartActionPayload",
    "execute_start",
]
