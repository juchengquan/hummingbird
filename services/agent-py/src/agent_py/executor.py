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
from .tools import default_tool_registry

logger = structlog.get_logger(__name__)


# Step-fn factory signature: the executor loads the run's checkpoint
# (model + system + messages from `tasks.checkpoint`) and hands both
# the payload and the loaded checkpoint to the factory. Tests pass a
# fake that ignores the args and returns a canned `RunStepFn`.
MakeStepFn = Callable[
    ["StartActionPayload", dict[str, Any], list[dict[str, Any]]],
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


@dataclass(frozen=True)
class RespondActionPayload:
    """User's answer to a HITL pending input. Mirrors the TS shape
    written by `POST /api/tasks/:id/respond` (`requestId`, optional
    `approved` / `selection` / `value`, optional `args` edit).

    One of `approved` / `selection` / `value` is set based on the
    pending input's request kind (approval / choice / input). All
    fields besides `request_id` are optional so a malformed job
    payload doesn't crash the executor — `_build_tool_result_text`
    falls back to a "no answer" message."""

    run_id: str
    user_id: str
    request_id: str
    approved: bool | None = None
    selection: list[str] | None = None
    value: str | None = None
    args: dict[str, Any] | None = None


async def execute_respond(
    pool: asyncpg.Pool,
    payload: RespondActionPayload,
    *,
    make_step_fn: MakeStepFn | None = None,
) -> ExecutorOutcome:
    """Run a `respond` action — resume a suspended run with the user's
    answer to a HITL approval / choice / input request.

    Loads the checkpoint, finds the pending tool_use block matching
    `request_id`, builds a `tool_result` block from the answer, appends
    it as a user turn, emits an `input_response` event so the client
    clears its pending-input state, then runs a chunk (same yield /
    settle / re-suspend semantics as `continue`).

    Settle / cancel / yield / re-suspend semantics are identical to
    `continue` after the result message is appended."""
    return await _run_respond(pool, payload, make_step_fn)


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

        step_fn = (make_step_fn or _default_make_step_fn)(payload, checkpoint, live_messages)
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

        # Suspend path (Phase 3b): the step fn detected a gated tool
        # call and stopped before running it. Persist the latest state
        # (including the assistant turn with the pending tool_use),
        # emit `approval: request` + `status: paused`, update the
        # `tasks` row to paused. The poller marks the job done; a
        # `respond` action arrives later and resumes the loop with the
        # user's answer appended as a tool_result.
        if result.kind == "suspended":
            assert result.pending_input is not None
            pending = result.pending_input
            next_checkpoint = _build_checkpoint(checkpoint, live_messages, emitter)
            await store.save_checkpoint(
                pool,
                run_id=payload.run_id,
                user_id=payload.user_id,
                checkpoint=next_checkpoint,
            )
            await emitter.input_request(
                approval_id=pending.tool_call_id,
                request_kind="approval",
                tool=pending.tool,
                tool_call_id=pending.tool_call_id,
                args=pending.args,
            )
            await emitter.status("paused")
            await store.update_run(
                pool,
                run_id=payload.run_id,
                user_id=payload.user_id,
                status="paused",
            )
            logger.info(
                "executor.suspended",
                run_id=payload.run_id,
                tool=pending.tool,
                tool_call_id=pending.tool_call_id,
            )
            return ExecutorOutcome(settled=True)

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
    tools = list(default_tool_registry().values())

    # Phase 3b: read the run's gated-tool allow-list. Names match
    # `tools[].name` (skill names + prefixed MCP tool names). When
    # the model calls one of these the step fn captures it as a
    # `pending_input` instead of executing — the runner suspends and
    # the executor emits an approval request.
    gated = _gated_tools_from(checkpoint)

    return make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model=model,
            system=system,
            messages=messages,
            tools=tools,
            gated_tool_names=gated,
        )
    )


def _gated_tools_from(checkpoint: dict[str, Any]) -> set[str]:
    """Pull `config.requireApprovalFor` from the checkpoint as a set
    of tool names. Empty / missing → no gated tools (everything
    executes inline). Matches the TS path's union of `askUser` +
    explicit allow-list; the Python service hasn't ported `askUser`
    yet (lands with the rest of HITL polish) so for now only the
    explicit list applies."""
    cfg = checkpoint.get("config")
    if not isinstance(cfg, dict):
        return set()
    raw = cfg.get("requireApprovalFor")
    if not isinstance(raw, list):
        return set()
    return {item for item in raw if isinstance(item, str) and item}


async def _run_respond(
    pool: asyncpg.Pool,
    payload: RespondActionPayload,
    make_step_fn: MakeStepFn | None,
) -> ExecutorOutcome:
    """Implementation of `execute_respond`. Kept separate from
    `_run_chunk` because the pre-loop setup is different — we have
    to find the pending tool call and append its result before the
    loop resumes."""
    start_payload = StartActionPayload(
        run_id=payload.run_id,
        user_id=payload.user_id,
    )
    checkpoint = await store.load_checkpoint(
        pool,
        run_id=payload.run_id,
        user_id=payload.user_id,
    )
    if checkpoint is None:
        logger.error(
            "executor.respond.no_checkpoint",
            run_id=payload.run_id,
            user_id=payload.user_id,
        )
        return ExecutorOutcome(settled=False, error="respond: no checkpoint for run")

    live_messages = _messages_from(checkpoint)
    pending = _find_pending_tool_call(live_messages, payload.request_id)
    if pending is None:
        logger.error(
            "executor.respond.pending_not_found",
            run_id=payload.run_id,
            request_id=payload.request_id,
        )
        return ExecutorOutcome(
            settled=False,
            error=f"respond: pending tool call {payload.request_id} not found",
        )

    # Determine the request kind from the pending tool. For Phase 3b
    # the only kind we natively support is `approval` (binary
    # gate); `choice` + `input` ride on the same wire shape and will
    # land when the `askUser` tool ports.
    request_kind = "approval"
    final_args = payload.args if payload.args is not None else pending["args"]
    tool_result_text = await _build_tool_result_text(
        request_kind=request_kind,
        tool_name=pending["tool_name"],
        approved=payload.approved,
        selection=payload.selection,
        value=payload.value,
        final_args=final_args,
    )

    # Append the user turn carrying the tool_result.
    live_messages.append(
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": pending["tool_call_id"],
                    "content": tool_result_text,
                }
            ],
        }
    )

    start_seq = _int_or(checkpoint.get("seq"), 0)
    start_step = _int_or(checkpoint.get("step"), 0)
    sink = _make_db_sink(pool, user_id=payload.user_id)
    emitter = RunEmitter(
        run_id=payload.run_id,
        sink=sink,
        start_seq=start_seq,
        start_step=start_step,
    )

    # Persist BEFORE emitting so a crash between emit + save can't
    # lose the appended tool_result. Mirrors the TS path.
    interim_checkpoint = _build_checkpoint(checkpoint, live_messages, emitter)
    await store.save_checkpoint(
        pool,
        run_id=payload.run_id,
        user_id=payload.user_id,
        checkpoint=interim_checkpoint,
    )

    try:
        await store.set_task_handler(
            pool,
            run_id=payload.run_id,
            user_id=payload.user_id,
            handler="python",
        )
        # Emit input_response (clears pending_input on the projection)
        # then status:running before stepping again.
        await emitter.input_response(
            approval_id=payload.request_id,
            approved=payload.approved,
            selection=payload.selection,
            value=payload.value,
        )
        await emitter.status("running")

        step_fn = (make_step_fn or _default_make_step_fn)(start_payload, checkpoint, live_messages)
        max_steps = _max_steps_from(checkpoint, start_payload.max_steps)

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

        if result.kind == "suspended":
            # Re-suspended (the user's answer unblocked the model and
            # it called another gated tool). Same handling as the
            # original suspend path in `_run_chunk`.
            assert result.pending_input is not None
            re_pending = result.pending_input
            next_checkpoint = _build_checkpoint(checkpoint, live_messages, emitter)
            await store.save_checkpoint(
                pool,
                run_id=payload.run_id,
                user_id=payload.user_id,
                checkpoint=next_checkpoint,
            )
            await emitter.input_request(
                approval_id=re_pending.tool_call_id,
                request_kind="approval",
                tool=re_pending.tool,
                tool_call_id=re_pending.tool_call_id,
                args=re_pending.args,
            )
            await emitter.status("paused")
            await store.update_run(
                pool,
                run_id=payload.run_id,
                user_id=payload.user_id,
                status="paused",
            )
            return ExecutorOutcome(settled=True)

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
            return ExecutorOutcome(settled=True)

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
        logger.error(
            "executor.respond.failed",
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
            pass
        return ExecutorOutcome(settled=False, error=str(exc))


def _find_pending_tool_call(
    messages: list[dict[str, Any]],
    request_id: str,
) -> dict[str, Any] | None:
    """Walk the messages back-to-front looking for an assistant turn
    that contains a `tool_use` block with id == request_id. Returns
    `{tool_call_id, tool_name, args}` or None.

    Mirrors `findPendingToolCall` in `lib/server/agent/worker.ts`.
    Back-to-front so we find the most recent unmatched call first;
    a tool_use only "matches" until a tool_result with the same id
    is appended, so by the time `respond` runs there should be
    exactly one unmatched call (the one the user is responding to)."""
    for entry in reversed(messages):
        if entry.get("role") != "assistant":
            continue
        content = entry.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") != "tool_use":
                continue
            if block.get("id") != request_id:
                continue
            args = block.get("input")
            if not isinstance(args, dict):
                args = {}
            return {
                "tool_call_id": str(block.get("id") or ""),
                "tool_name": str(block.get("name") or ""),
                "args": dict(args),
            }
    return None


async def _build_tool_result_text(
    *,
    request_kind: str,
    tool_name: str,
    approved: bool | None,
    selection: list[str] | None,
    value: str | None,
    final_args: Any,
) -> str:
    """Build the text fed back to the model as the `tool_result.content`.

    Mirrors `buildToolResult` in `lib/server/agent/worker.ts` shape:
      - approval rejected → "User declined ..."
      - approval approved → execute the matching tool when we have
        a descriptor; placeholder otherwise (MCP tools land in Phase 3f)
      - choice → "User selected: <ids>" or "(no selection)"
      - input → the raw value or "(no value)" """
    if request_kind == "approval":
        if approved is False:
            return (
                "User declined to run this action. "
                "Consider an alternative or ask the user how to proceed."
            )
        descriptor = default_tool_registry().get(tool_name)
        if descriptor is None:
            return (
                f'(Approved, but the tool "{tool_name}" is not registered '
                "in the Python service yet. MCP tools land in Phase 3f of "
                "PLAN-agent-api.)"
            )
        try:
            args = final_args if isinstance(final_args, dict) else {}
            result = await descriptor.execute(args)
            return result.text
        except Exception as exc:
            return f"Tool error: {exc}"
    if request_kind == "choice":
        sel = selection or []
        if not sel:
            return "(User submitted no selection.)"
        return f"User selected: {', '.join(sel)}"
    # input
    if isinstance(value, str) and value:
        return value
    return "(User submitted no value.)"


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

    The checkpoint stores a list of `{role, content}` entries where
    `content` is either a string OR a list of content blocks
    (`text`, `tool_use`, `tool_result`, …). Phase 3b preserves the
    block list verbatim when it's Anthropic-shaped so a suspended +
    resumed run keeps its tool_use ↔ tool_result chain intact.

    A run started TS-side stores AI-SDK-shaped blocks (`type:
    'text' | 'tool-call' | 'tool-result'` with `toolCallId` etc.)
    which Phase 2b-1 flattened to text-only. The translator from
    AI-SDK → Anthropic wire format is a Phase 3c+ port — until it
    lands, runs that mix TS-suspend with Python-respond may lose
    tool context. Same-worker Python flows (start → suspend →
    respond, all Python) work today because Python writes
    Anthropic-shaped blocks both ways."""
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
            # `system=` arg); `tool` role is the AI-SDK shape that the
            # Python provider doesn't emit.
            continue
        content = entry.get("content")
        if isinstance(content, str):
            if content:
                out.append({"role": role, "content": content})
            continue
        if isinstance(content, list):
            blocks = _normalise_content_blocks(content)
            if blocks:
                out.append({"role": role, "content": blocks})
            continue
    return out


def _normalise_content_blocks(content: list[Any]) -> list[dict[str, Any]]:
    """Pass Anthropic-shape content blocks through, dropping anything
    we don't recognise. Future work: translate AI-SDK shapes
    (`type: 'tool-call'`, `'tool-result'`) into Anthropic ones."""
    out: list[dict[str, Any]] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type in ("text", "tool_use", "tool_result", "image"):
            out.append(dict(block))
    return out


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
    "RespondActionPayload",
    "StartActionPayload",
    "execute_continue",
    "execute_respond",
    "execute_start",
]
