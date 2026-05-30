"""Executor — wires claim → run_agent_loop → settle.

Phase 2a of PLAN-agent-api. The poller hands a claimed `start` job
here; this module:

  1. Stamps `tasks.metadata.handler = 'python'` for postmortem audit.
  2. Builds a `RunEmitter` whose sink persists into `task_events`.
  3. Calls `run_agent_loop` with an injected `RunStepFn`.
  4. Updates the `tasks` row to terminal status when the loop settles.

The injected step fn is **stubbed** in Phase 2a: it emits two tokens
plus signals `done`, producing a valid event stream the frontend can
project + display. Phase 2b replaces `_stub_step_fn` with the real
model + tool-call loop. Everything else here stays the same.

Why ship a stub: the executor pattern (claim → loop → persist →
settle) is a meaningful, reviewable piece on its own. Folding it in
with provider abstraction + tool registry + streaming-format work
would produce a PR too big to grok. The seam is `make_step_fn` —
swap one parameter to enable real model execution.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import asyncpg
import structlog

from . import store
from .emitter import EventSink, RunEmitter
from .events import TaskEvent
from .runner import (
    AgentLoopResult,
    RunStepContext,
    RunStepFn,
    RunStepOutcome,
    run_agent_loop,
)

logger = structlog.get_logger(__name__)


# Phase 2a step-fn factory signature: callers can plug in their own.
# Phase 2b will provide a `make_real_step_fn(model_id, tools)`
# implementation that calls the model + executes tools; today the
# default is `_stub_step_fn` which emits a canned event stream.
MakeStepFn = Callable[[], RunStepFn]


@dataclass(frozen=True)
class StartActionPayload:
    """Minimum the executor needs to run a `start` action. Mirrors
    the shape the route writes into `tasks` before enqueueing the
    job (the route owns `messages`, `system`, `skills`, etc; this
    PR keeps the executor signature minimal so the next PR can
    extend it without churn)."""

    run_id: str
    user_id: str
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
    step_fn = (make_step_fn or _default_make_step_fn)()
    sink = _make_db_sink(pool, user_id=payload.user_id)

    emitter = RunEmitter(run_id=payload.run_id, sink=sink)

    try:
        await store.set_task_handler(
            pool,
            run_id=payload.run_id,
            user_id=payload.user_id,
            handler="python",
        )

        async def is_cancelled() -> bool:
            return await store.is_run_cancelled(
                pool,
                run_id=payload.run_id,
                user_id=payload.user_id,
            )

        result: AgentLoopResult = await run_agent_loop(
            emitter=emitter,
            max_steps=payload.max_steps,
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


def _default_make_step_fn() -> RunStepFn:
    """Phase 2a stub. Emits a two-token canned response and signals
    `done` after one step. Lets us prove the end-to-end pipeline
    (claim → execute → events → settle) without committing to a
    provider SDK or streaming-format choice in the same PR.

    Phase 2b replaces this with a real model-call step fn that
    streams tokens and tool calls. The runner control flow doesn't
    change.
    """
    return _stub_step_fn


async def _stub_step_fn(ctx: RunStepContext) -> RunStepOutcome:
    """Canned step — emits two tokens of placeholder text and
    declares the step done. Removed in Phase 2b when the real
    model-call step fn lands; the runner doesn't care."""
    await ctx.emitter.token("Phase 2a stub: ")
    await ctx.emitter.token("(real model call lands in Phase 2b)")
    return RunStepOutcome(done=True)


# Re-export so callers (and the poller) can wire a custom step fn
# without depending on private internals.
__all__ = [
    "ExecutorOutcome",
    "MakeStepFn",
    "StartActionPayload",
    "execute_start",
]
