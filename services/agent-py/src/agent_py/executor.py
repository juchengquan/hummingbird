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

import asyncio
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import asyncpg
import structlog

from . import jobs, store
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
from .tools import ToolContext, default_tool_registry

logger = structlog.get_logger(__name__)


# Step-fn factory signature: the executor loads the run's checkpoint
# (model + system + messages from `tasks.checkpoint`) and hands both
# the payload and the loaded checkpoint to the factory. Tests pass a
# fake that ignores the args and returns a canned `RunStepFn`.
MakeStepFn = Callable[
    [
        "StartActionPayload",
        dict[str, Any],
        list[dict[str, Any]],
        "ToolContext | None",
    ],
    RunStepFn,
]


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
    """Run a `start` action end-to-end. See `_run_chunk` for the
    settle / cancel / yield contract — `start` is just the chunk-run
    path with `start_seq=0` / `start_step=0` (the runner auto-emits
    `status: running` at step==0)."""
    return await _run_chunk(
        pool,
        payload=payload,
        make_step_fn=make_step_fn,
        resume=False,
    )


async def execute_continue(
    pool: asyncpg.Pool,
    payload: StartActionPayload,
    *,
    make_step_fn: MakeStepFn | None = None,
) -> ExecutorOutcome:
    """Run a `continue` action — pick up after a chunk-break yield.

    Same shape as `execute_start` but seeds the emitter at the
    checkpoint's saved `seq` / `step`, so the resumed events follow
    the originals monotonically. The runner skips the
    `status: running` emit since `start` already wrote it on the
    original chunk.

    Settle / cancel / failure semantics are identical to `start`. A
    yielded chunk re-saves the checkpoint with the latest messages +
    step + seq and enqueues yet another `continue` job."""
    return await _run_chunk(
        pool,
        payload=payload,
        make_step_fn=make_step_fn,
        resume=True,
    )


async def _run_chunk(
    pool: asyncpg.Pool,
    *,
    payload: StartActionPayload,
    make_step_fn: MakeStepFn | None,
    resume: bool,
) -> ExecutorOutcome:
    """Shared body for `execute_start` + `execute_continue`.

    The contract the poller depends on:
      - On settle (`done`) → returns `ExecutorOutcome(settled=True)`.
        The `tasks` row is `status='done'`, `finished_at` set.
      - On cancel detected between steps → same outcome (the cancel
        landed cleanly, no need to mark the job failed).
      - On yield (time budget exhausted) → returns
        `ExecutorOutcome(settled=True)` too, BUT the `tasks` row is
        left `running`; the executor has already saved the
        checkpoint and enqueued a `continue` job that picks up.
      - On model / tool / DB error → returns
        `ExecutorOutcome(settled=False, error=...)`. The poller
        marks the job failed; the row gets a synthetic
        `result: failed` event.

    `resume=True` seeds the emitter at the checkpoint's saved
    `seq` / `step` so a re-tail picks up monotonically. `resume=False`
    seeds at zero, and the runner auto-emits `status: running`."""
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
            resume=resume,
        )
        checkpoint = {}

    start_seq = _int_or(checkpoint.get("seq"), 0) if resume else 0
    start_step = _int_or(checkpoint.get("step"), 0) if resume else 0

    sink = _make_db_sink(pool, user_id=payload.user_id)
    emitter = RunEmitter(
        run_id=payload.run_id,
        sink=sink,
        start_seq=start_seq,
        start_step=start_step,
    )

    # Track the mutable message history the step fn appends to —
    # `_default_make_step_fn` builds it from the checkpoint and hands
    # the SAME list to `AnthropicStepConfig.messages`, which the step
    # mutates in place when tools are called. On yield we need to read
    # the current state to persist; the closure captures it here so we
    # don't have to plumb a getter through the step-fn factory.
    live_messages: list[dict[str, Any]] = _messages_from(checkpoint)

    try:
        await store.set_task_handler(
            pool,
            run_id=payload.run_id,
            user_id=payload.user_id,
            handler="python",
        )

        tool_context = ToolContext(pool=pool, user_id=payload.user_id)
        step_fn = (make_step_fn or _default_make_step_fn)(
            payload, checkpoint, live_messages, tool_context
        )
        max_steps = _max_steps_from(checkpoint, payload.max_steps)

        async def is_cancelled() -> bool:
            return await store.is_run_cancelled(
                pool,
                run_id=payload.run_id,
                user_id=payload.user_id,
            )

        deadline_s = _chunk_deadline_s()

        def should_yield() -> bool:
            return deadline_s is not None and asyncio.get_event_loop().time() > deadline_s

        result: AgentLoopResult = await run_agent_loop(
            emitter=emitter,
            max_steps=max_steps,
            run_step=step_fn,
            is_cancelled=is_cancelled,
            should_yield=should_yield,
        )

        # Yield path: persist the latest state + enqueue a continue
        # job so another chunk picks up. The task row stays `running`
        # (no terminal event emitted). The poller marks THIS job done
        # because the chunk completed cleanly — there's just more work
        # to do on a later one.
        if result.kind == "yielded":
            next_checkpoint = _build_checkpoint(checkpoint, live_messages, emitter)
            await store.save_checkpoint(
                pool,
                run_id=payload.run_id,
                user_id=payload.user_id,
                checkpoint=next_checkpoint,
            )
            await jobs.enqueue_continue_job(
                pool,
                task_id=payload.run_id,
                user_id=payload.user_id,
            )
            logger.info(
                "executor.yielded",
                run_id=payload.run_id,
                step=emitter.step,
                seq=emitter.seq,
            )
            return ExecutorOutcome(settled=True)

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
    settings = get_settings()
    api_key = settings.ANTHROPIC_API_KEY
    if not api_key:
        return None
    # Real SDK import — only paid for when configured. Tests that
    # need a step fn bypass this via the `make_step_fn` injection
    # point, so this branch never runs under pytest.
    from anthropic import AsyncAnthropic

    # Optional `ANTHROPIC_BASE_URL` override lets a deploy point at
    # any Anthropic-compatible endpoint (proxy, self-hosted gateway,
    # Minimax's `/anthropic/v1` host, …). Only pass the kwarg when set
    # so the SDK falls back to its own default otherwise. mypy doesn't
    # see the SDK satisfies our Protocol via structural subtyping —
    # the Protocol's `messages.stream` signature is intentionally
    # narrower than the SDK's full overload set.
    base_url = settings.ANTHROPIC_BASE_URL.strip()
    if base_url:
        _anthropic_client = AsyncAnthropic(  # type: ignore[assignment]
            api_key=api_key,
            base_url=base_url,
        )
    else:
        _anthropic_client = AsyncAnthropic(api_key=api_key)  # type: ignore[assignment]
    return _anthropic_client


def _default_make_step_fn(
    payload: StartActionPayload,
    checkpoint: dict[str, Any],
    messages: list[dict[str, Any]],
    context: ToolContext | None = None,
) -> RunStepFn:
    """Default step-fn picker.

    Phase 2b-1 strategy: prefer Anthropic streaming when configured;
    fall back to the Phase 2a stub when the API key is unset OR the
    checkpoint is incomplete (no model / no messages). The stub keeps
    development + CI runnable without any provider credentials.

    `messages` is the live, mutable list the chunk-runner owns — the
    Anthropic step appends assistant + tool_result turns to it as it
    runs, and the runner's yield path reads from it to persist the
    checkpoint. Passing it in keeps the chunk-runner authoritative.

    `context` (Phase 3c-2) carries the asyncpg pool + user_id for
    tools that reach external systems on the user's behalf (currently
    just `searchFiles`). None = registry omits those tools — fine
    for tests / dev with no DB.
    """
    client = _resolve_anthropic_client()
    model = _str_or_none(checkpoint.get("config", {}).get("model"))
    system = _str_or_none(checkpoint.get("config", {}).get("workspaceSystemPrompt"))

    if client is None or not model or not messages:
        logger.info(
            "executor.using_stub_step_fn",
            run_id=payload.run_id,
            reason=(
                "no_api_key" if client is None else ("no_model" if not model else "no_messages")
            ),
        )
        return _stub_step_fn

    # Phase 2b-2: wire the default tool registry into every real
    # Anthropic run. The model may ignore tools entirely (in which
    # case the step settles on first call, identical to Phase 2b-1
    # behaviour) or call any of them. A future config flag on
    # `checkpoint.config` can narrow the visible set per run.
    tools = list(default_tool_registry(context=context).values())

    return make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model=model,
            system=system,
            messages=messages,
            tools=tools,
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


def _int_or(value: Any, fallback: int) -> int:
    """Coerce a checkpoint jsonb number to int, falling back when the
    field is missing / non-numeric. Both `seq` and `step` are read
    through this on resume."""
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return fallback


def _build_checkpoint(
    original: dict[str, Any],
    messages: list[dict[str, Any]],
    emitter: RunEmitter,
) -> dict[str, object]:
    """Build the jsonb body for `tasks.checkpoint` on a yield save.

    Shape matches `RunCheckpoint` on the TS side:
    `{messages, step, seq, config}`. `config` is the original loaded
    block (model / system / skills / maxSteps / mode / …); on a yield
    we keep it identical — the next chunk runs with the same setup."""
    cfg = original.get("config")
    return {
        "messages": list(messages),
        "step": emitter.step,
        "seq": emitter.seq,
        "config": cfg if isinstance(cfg, dict) else {},
    }


# Time budget for one chunk before the runner voluntarily yields. The
# TS side uses 45s as a default (Vercel Hobby cap is 60s; 15s headroom
# leaves room for the current step to finish + the checkpoint write +
# the enqueue). For self-host VMs there's no hard cap; we still chunk
# so a long run can't monopolise a worker process.
_DEFAULT_CHUNK_BUDGET_S = 45.0


def _chunk_deadline_s() -> float | None:
    """Compute an event-loop monotonic timestamp past which the runner
    should yield. None disables chunking entirely (set
    `WORKER_CHUNK_BUDGET_S=0` to opt out — useful in tests + when the
    deploy target has no execution cap and a single big chunk is
    fine). Reads the env var directly rather than threading it
    through `get_settings()` so test invocations don't have to clear
    the cached Settings singleton."""
    raw = os.environ.get("WORKER_CHUNK_BUDGET_S")
    if raw is not None:
        try:
            budget = float(raw)
        except ValueError:
            budget = _DEFAULT_CHUNK_BUDGET_S
    else:
        budget = _DEFAULT_CHUNK_BUDGET_S
    if budget <= 0:
        return None
    return asyncio.get_event_loop().time() + budget


# Re-export so callers (and the poller) can wire a custom step fn
# without depending on private internals.
__all__ = [
    "ExecutorOutcome",
    "MakeStepFn",
    "StartActionPayload",
    "execute_continue",
    "execute_start",
]
