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
import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import asyncpg
import structlog

from . import jobs, store, verify
from .emitter import EventSink, RunEmitter
from .events import TaskEvent, TokenEvent, ToolOutputEvent
from .input_policy import (
    ALWAYS_GATED_TOOL_NAMES,
    request_kind_for,
)
from .mcp_tools import extend_registry_with_mcp
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
from .tools.registry import ToolDescriptor

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


@dataclass(frozen=True)
class RespondActionPayload:
    """User's answer to a HITL pending input. Mirrors the TS shape
    written by `POST /api/tasks/:id/respond` (`requestId`, optional
    `approved` / `selection` / `value` / `uiAnswer`, optional `args`
    edit).

    One of `approved` / `selection` / `value` / `ui_answer` is set
    based on the pending input's request kind (approval / choice /
    input / ui-part). All fields besides `request_id` are optional so
    a malformed job payload doesn't crash the executor —
    `_build_tool_result_text` falls back to a "no answer" message.

    `ui_answer` carries the structured answer from the generative-UI
    resolver (commit 3b of PLAN-generative-ui-parts). The back-compat
    `value` / `selection` are populated alongside by the wire shim
    (`respondBodyForUiAnswer` on the client) so the runner can stay
    `ui_answer`-agnostic for the actual tool result text — it just
    reads the formatted text out of `value`."""

    run_id: str
    user_id: str
    request_id: str
    approved: bool | None = None
    selection: list[str] | None = None
    value: str | None = None
    ui_answer: dict[str, Any] | None = None
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

    # Tap the sink to accumulate the assembled report text + web-search
    # sources as events flow, so the citation finalize hook (research
    # runs) can verify before the terminal `result` latches the emitter.
    # Only token(text) + tool_output(results) feed it; everything else
    # passes through to the DB sink. Web-search results arrive in the
    # cumulative order the model cites by (`[1]`, `[2]`, …).
    #
    # This accumulator is per-chunk, so it's only complete when the run
    # settles in THIS chunk — which is why verification runs on the
    # `execute_start` path only (a run that yields and finishes in a later
    # `continue` chunk simply gets no verification). See verify_answer's
    # no-op guards + `docs/PLAN-citation-verifiability.md`.
    verify_text_parts: list[str] = []
    verify_sources: list[tuple[str, str, str]] = []
    db_sink = _make_db_sink(pool, user_id=payload.user_id)

    async def sink(event: TaskEvent) -> None:
        if isinstance(event, TokenEvent) and event.channel == "text":
            verify_text_parts.append(event.text)
        elif isinstance(event, ToolOutputEvent) and event.results:
            verify_sources.extend((r.title, r.url, r.snippet) for r in event.results)
        await db_sink(event)

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

        # Phase 3f-2: pull `workspaceId` off the checkpoint config so
        # cloud-mode MCP discovery (`extend_registry_with_mcp`) knows
        # which workspace to enumerate. Absent → context.workspace_id
        # stays None and MCP tools are skipped entirely (Phase 2b-2
        # behaviour). The TS checkpoint always writes `workspaceId`;
        # missing field is the test/dev path.
        cfg = checkpoint.get("config")
        workspace_id = _str_or_none(cfg.get("workspaceId")) if isinstance(cfg, dict) else None
        tool_context = ToolContext(pool=pool, user_id=payload.user_id, workspace_id=workspace_id)
        # Phase 3f-2: discover cloud-mode MCP tools when we have a
        # workspace. Custom `make_step_fn` overrides (tests) skip this
        # — they don't go through `_default_make_step_fn`, so injecting
        # extra tools wouldn't reach them anyway.
        if make_step_fn is None:
            extra_tools: dict[str, ToolDescriptor] = {}
            mcp_gated: set[str] = set()
            if workspace_id:
                await extend_registry_with_mcp(
                    extra_tools,
                    pool=pool,
                    user_id=payload.user_id,
                    workspace_id=workspace_id,
                    gated_out=mcp_gated,
                )
            step_fn = _default_make_step_fn(
                payload,
                checkpoint,
                live_messages,
                tool_context,
                extra_tools=extra_tools or None,
                extra_gated_tool_names=mcp_gated or None,
            )
        else:
            step_fn = make_step_fn(payload, checkpoint, live_messages, tool_context)
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

        # Citation verification (research runs only). Runs at settle, just
        # before the terminal `result`, over the accumulated report text +
        # web-search sources. Advisory + non-blocking — `_maybe_verify`
        # swallows its own failures and returns None.
        #
        # `resume` (a `continue` chunk after a yield) re-aggregates the
        # report text + sources from the full `task_events` log: the
        # per-chunk in-memory accumulators only hold THIS chunk's slice,
        # so they're complete only when the run settles in the first
        # chunk. The DB is the source of truth for a multi-chunk run.
        run_mode = _str_or_none(cfg.get("mode")) if isinstance(cfg, dict) else None
        # Answerer provider is "anthropic" for every agent-py run today
        # (the only model family the executor wires). When agent-ts goes
        # live, read this from `cfg.get("provider", "anthropic")` so the
        # cross-family verifier picks a genuinely different family.
        answerer_provider = "anthropic"

        async def finalize() -> dict[str, object] | None:
            if resume:
                full_events = await store.load_run_events(
                    pool,
                    run_id=payload.run_id,
                    user_id=payload.user_id,
                )
                inputs = verify.aggregate_from_events(full_events)
                return await _maybe_verify(
                    mode=run_mode,
                    text=inputs.text,
                    sources=[(s.title, s.url or "", s.snippet) for s in inputs.sources],
                    answerer_provider=answerer_provider,
                )
            # Fast path: single-chunk run, the in-memory accumulators are
            # complete, so skip the DB round-trip.
            return await _maybe_verify(
                mode=run_mode,
                text="".join(verify_text_parts),
                sources=verify_sources,
                answerer_provider=answerer_provider,
            )

        result: AgentLoopResult = await run_agent_loop(
            emitter=emitter,
            max_steps=max_steps,
            run_step=step_fn,
            is_cancelled=is_cancelled,
            should_yield=should_yield,
            finalize=finalize,
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
            await _emit_pending_input_request(emitter, pending)
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


# Citation-verification cap — the verifier returns a small JSON object, so
# a tight budget is plenty.
_VERIFY_MAX_TOKENS = 800

# Process-local set of warning keys already fired by `_warn_once`.
# Reset in the test fixture (`test_cross_family_verifier._reset_warn_once`).
_warned_keys: set[str] = set()


def _warn_once(key: str, **fields: object) -> None:
    """Log a structlog warning the first time `key` is seen in this
    process. Keeps a startup-time misconfig (e.g. the cross-family
    provider being unavailable) from spamming the log on every research
    run."""
    if key in _warned_keys:
        return
    _warned_keys.add(key)
    logger.warning(key, **fields)


class _VerifierClient(Protocol):
    """The narrow surface `_maybe_verify` needs from a verifier: one
    non-streaming completion call returning concatenated text. Both the
    Anthropic and Google wrappers satisfy this structurally."""

    async def messages_create(
        self, *, model: str, max_tokens: int, messages: list[dict[str, object]]
    ) -> str: ...


class _AnthropicVerifierClient:
    """The legacy same-family path. Wraps the same `AsyncAnthropic` the
    run used, exposing the small `_VerifierClient` surface."""

    def __init__(self, client: Any) -> None:
        self._client = client

    async def messages_create(
        self, *, model: str, max_tokens: int, messages: list[dict[str, object]]
    ) -> str:
        resp = await self._client.messages.create(
            model=model,
            max_tokens=max_tokens,
            messages=messages,
        )
        parts: list[str] = []
        for block in getattr(resp, "content", None) or []:
            text = getattr(block, "text", None)
            if isinstance(text, str):
                parts.append(text)
        return "".join(parts)


class _GoogleVerifierClient:
    """Cross-family path via the google-generativeai SDK. Returns the
    joined text parts of a `generate_content_async` call. The caller-side
    prompt already requests strict JSON."""

    def __init__(self, model: Any) -> None:
        self._model = model

    async def messages_create(
        self, *, model: str, max_tokens: int, messages: list[dict[str, object]]
    ) -> str:
        target = self._model
        if getattr(target, "model_name", model) != model:
            # The factory built with VERIFY_MODEL; rebuild if the call
            # site asks for a different model. Uncommon.
            target = _build_google_model(model)
        user_text = "\n\n".join(
            str(m.get("content", "")) if isinstance(m, dict) else str(m) for m in messages
        )
        resp = await target.generate_content_async(user_text)
        parts: list[str] = []
        for cand in getattr(resp, "candidates", None) or []:
            content = getattr(cand, "content", None)
            for part in getattr(content, "parts", None) or []:
                text = getattr(part, "text", None)
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)


def _build_google_model(model: str) -> Any:
    """Build a `google.generativeai.GenerativeModel`. Caller is expected
    to have called `genai.configure(api_key=...)` first."""
    import google.generativeai as genai  # local import; optional dep

    # The SDK ships types but doesn't re-export these at the top level.
    return genai.GenerativeModel(model)  # type: ignore[attr-defined]


def _make_google_verifier_client() -> _GoogleVerifierClient | None:
    """Build the Google cross-family verifier client. Returns None if
    `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) is unset OR the
    `google-generativeai` SDK isn't installed — caller logs a one-shot
    warning and falls back to the Anthropic path."""
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    try:
        import google.generativeai as genai
    except ImportError:
        return None
    genai.configure(api_key=api_key)  # type: ignore[attr-defined]
    settings = get_settings()
    model = _build_google_model(settings.VERIFY_MODEL.strip() or "gemini-2.0-flash")
    return _GoogleVerifierClient(model)


def _make_anthropic_verifier_client() -> _AnthropicVerifierClient | None:
    """The legacy same-family Anthropic path. Returns None when no
    Anthropic client is configured (same condition that gates the live
    model call)."""
    client = _resolve_anthropic_client()
    if client is None:
        return None
    return _AnthropicVerifierClient(client)


def _resolve_verifier_client(*, answerer_provider: str) -> _VerifierClient | None:
    """Cross-family by default. Returns the configured provider's client,
    or the Anthropic fallback when the cross-family provider is missing.
    `_warn_once` keeps the same-family / unavailable warnings from
    spamming the log on every research run."""
    settings = get_settings()
    verifier_provider = settings.VERIFY_PROVIDER.strip().lower()
    if not verifier_provider:
        return None
    same_family = verifier_provider == answerer_provider
    client: _VerifierClient | None
    if verifier_provider == "google":
        client = _make_google_verifier_client()
        if client is None:
            _warn_once(
                "executor.verifier_google_unavailable",
                recommendation=(
                    "set GOOGLE_API_KEY to enable cross-family "
                    "verification; falling back to Anthropic"
                ),
            )
    elif verifier_provider == "anthropic":
        client = _make_anthropic_verifier_client()
    else:
        return None
    if same_family and client is not None:
        _warn_once(
            "executor.verifier_same_family",
            answerer_provider=answerer_provider,
            recommendation=(
                "set VERIFY_PROVIDER to a different family for stronger cross-checking"
            ),
        )
    return client or _make_anthropic_verifier_client()  # safe fallback


async def _maybe_verify(
    *,
    mode: str | None,
    text: str,
    sources: list[tuple[str, str, str]],
    answerer_provider: str = "anthropic",
) -> dict[str, object] | None:
    """Run the citation verifier for a research run, returning the wire
    payload for the `result` event (or None). Gated on research mode + a
    configured `VERIFY_MODEL` + a resolvable verifier client;
    `verify_answer` handles the no-claims / no-sources / failure → None
    cases.

    Cross-family by default: `_resolve_verifier_client` picks a different
    provider family than the answerer (a model is a weak judge of its own
    output), falling back to the answerer's family with a one-shot
    warning when the cross-family provider is unavailable."""
    if mode != "research":
        return None
    settings = get_settings()
    model = settings.VERIFY_MODEL.strip()
    if not model:
        return None
    client = _resolve_verifier_client(answerer_provider=answerer_provider)
    if client is None:
        return None

    async def run(prompt: str) -> str:
        return await client.messages_create(
            model=model,
            max_tokens=_VERIFY_MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}],
        )

    result = await verify.verify_answer(
        text,
        verify.gather_sources(sources),
        run_verifier=run,
    )
    return result.to_payload() if result is not None else None


def _default_make_step_fn(
    payload: StartActionPayload,
    checkpoint: dict[str, Any],
    messages: list[dict[str, Any]],
    context: ToolContext | None = None,
    *,
    extra_tools: dict[str, ToolDescriptor] | None = None,
    extra_gated_tool_names: set[str] | None = None,
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

    `extra_tools` (Phase 3f-2) is the pre-discovered cloud-mode MCP
    tool set — the chunk-runner builds it via `extend_registry_with_mcp`
    before calling us. Kwarg-only so existing `MakeStepFn` callers
    (tests) don't need to know it exists.
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
    tools_dict = default_tool_registry(context=context)
    if extra_tools:
        tools_dict.update(extra_tools)
    tools = list(tools_dict.values())

    # Phase 3b: read the run's gated-tool allow-list. Names match
    # `tools[].name` (skill names + prefixed MCP tool names). When
    # the model calls one of these the step fn captures it as a
    # `pending_input` instead of executing — the runner suspends and
    # the executor emits an approval request.
    gated = _gated_tools_from(checkpoint)
    if extra_gated_tool_names:
        gated = gated | extra_gated_tool_names

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
    """Pull `config.requireApprovalFor` from the checkpoint and union
    with `ALWAYS_GATED_TOOL_NAMES` (the no-execute HITL tools —
    `askUser` + `renderUI`). Matches the TS path's union of the
    explicit allow-list with the always-gated names — both runners
    agree on which tools suspend instead of executing."""
    explicit: set[str] = set()
    cfg = checkpoint.get("config")
    if isinstance(cfg, dict):
        raw = cfg.get("requireApprovalFor")
        if isinstance(raw, list):
            explicit = {item for item in raw if isinstance(item, str) and item}
    return explicit | ALWAYS_GATED_TOOL_NAMES


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

    # Classify the request kind from the pending tool name + args.
    # `approval` is the binary gate (any other gated tool); `choice`
    # / `input` come off `askUser`'s args shape; `ui-part` is
    # `renderUI`. The classifier is the single source of truth — same
    # one the suspend path uses — so the respond side never disagrees
    # with what the user actually saw.
    request_kind = request_kind_for(pending["tool_name"], pending["args"])
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
            ui_answer=payload.ui_answer,
        )
        await emitter.status("running")

        step_fn = (make_step_fn or _default_make_step_fn)(
            start_payload,
            checkpoint,
            live_messages,
            ToolContext(pool=pool, user_id=payload.user_id),
        )
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
            await _emit_pending_input_request(emitter, re_pending)
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
    if request_kind == "ui-part":
        # The client's `respondBodyForUiAnswer` shim populates
        # `value` with the formatted text (or `selection` for a
        # `choice` answer) so the runner doesn't have to re-port
        # `formatAnswerForChat`. Prefer the formatted text; fall back
        # to the joined selection; finally a neutral marker so the
        # model still gets a parseable tool_result.
        if isinstance(value, str) and value:
            return value
        sel = selection or []
        if sel:
            return ", ".join(sel)
        return "(User submitted no answer.)"
    # input
    if isinstance(value, str) and value:
        return value
    return "(User submitted no value.)"


async def _emit_pending_input_request(
    emitter: RunEmitter,
    pending: Any,
) -> None:
    """Shared suspend emit. Classifies `request_kind` from the
    pending tool name + args (single source of truth via
    `request_kind_for`), and pulls out the kind-specific fields:

    - `askUser` → `prompt` / `options` / `multi` come from args.
    - `renderUI` → `ui_kind` + `ui_props` come from args.
    - approval (anything else gated) → just tool + args.

    Used by both the original suspend path in `_run_chunk` and the
    re-suspend path in `_run_respond` so they emit identical shapes."""
    args = pending.args if isinstance(pending.args, dict) else {}
    kind = request_kind_for(pending.tool, args)

    prompt: str | None = None
    options: list[Any] | None = None
    multi: bool | None = None
    ui_kind: str | None = None
    ui_props: dict[str, Any] | None = None

    if kind in ("choice", "input"):
        raw_prompt = args.get("prompt")
        if isinstance(raw_prompt, str):
            prompt = raw_prompt
        raw_multi = args.get("multi")
        if isinstance(raw_multi, bool):
            multi = raw_multi
        if kind == "choice":
            from .events import InputRequestOption  # local import — avoid cycle

            raw_options = args.get("options")
            if isinstance(raw_options, list):
                built: list[InputRequestOption] = []
                for opt in raw_options:
                    if not isinstance(opt, dict):
                        continue
                    opt_id = opt.get("id")
                    opt_label = opt.get("label")
                    if isinstance(opt_id, str) and isinstance(opt_label, str):
                        built.append(InputRequestOption(id=opt_id, label=opt_label))
                if built:
                    options = built
    elif kind == "ui-part":
        raw_kind = args.get("kind")
        raw_props = args.get("props")
        if isinstance(raw_kind, str):
            ui_kind = raw_kind
        if isinstance(raw_props, dict):
            ui_props = raw_props

    await emitter.input_request(
        approval_id=pending.tool_call_id,
        request_kind=kind,
        tool=pending.tool,
        tool_call_id=pending.tool_call_id,
        args=args,
        prompt=prompt,
        options=options,
        multi=multi,
        ui_kind=ui_kind,
        ui_props=ui_props,
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

    The checkpoint stores a list of `{role, content}` entries where
    `content` is either a string OR a list of content blocks
    (`text`, `tool_use`, `tool_result`, …). Phase 3b preserves the
    block list verbatim when it's Anthropic-shaped so a suspended +
    resumed run keeps its tool_use ↔ tool_result chain intact.

    A run started TS-side stores AI-SDK-shaped content blocks
    (`type: 'tool-call'`, `'tool-result'`, `'image'`, `'file'`,
    `'reasoning'` and `role: 'tool'` messages). The
    `_translate_block` / `_translate_ai_sdk_message` helpers below
    convert those to Anthropic shapes before this function returns
    its output. Runs that mix TS-suspend with Python-respond keep
    their tool context as of this change. Same-worker Python flows
    (start → suspend → respond, all Python) work today because
    Python writes Anthropic-shaped blocks both ways."""
    raw = checkpoint.get("messages")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        if entry.get("role") == "tool":
            # AI SDK v5 ToolModelMessage → Anthropic user + tool_result blocks.
            # See _translate_ai_sdk_message for the role-remap + block translation.
            translated = _translate_ai_sdk_message(entry)
            if translated is not None:
                out.append(translated)
            continue
        role = entry.get("role")
        if role not in ("user", "assistant"):
            # `system` is hoisted out (Anthropic takes it as a separate
            # `system=` arg); `developer` is not used by AI SDK v5 by default.
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


# Sentinel for redacted_thinking blocks. Anthropic accepts the `data` field
# as opaque — the actual reasoning text is intentionally lost in the
# AI SDK → Anthropic translation.
_REDACTED_THINKING_SENTINEL = "redacted-by-translator"

# Process-local set tracking which unknown block kinds we've already
# warned about. Mirrors the `_warn_once` pattern at verify.py (per-block-kind).
_warned_unknown_block_kinds: set[str] = set()


def _warn_unknown_block_kind(block_type: object) -> None:
    key = str(block_type)
    if key in _warned_unknown_block_kinds:
        return
    _warned_unknown_block_kinds.add(key)
    structlog.get_logger().warning(
        "executor.unknown_ai_sdk_block_kind",
        block_type=key,
    )


def _normalise_content_blocks(content: list[Any]) -> list[dict[str, Any]]:
    """Translate a content array (any source: Anthropic-shape or AI-SDK-shape)
    into Anthropic-shape blocks. Pure; drops unknown block kinds. Replaces
    the old pass-through filter — the AI SDK translator is the canonical
    path. A pass-through-only path would silently drop tool-call/tool-result
    blocks when a TS-suspended run is resumed by Python."""
    return [b for b in (_translate_block(c) for c in content) if b is not None]


def _translate_block(block: Any) -> dict[str, Any] | None:
    """One content block (any source: AI-SDK v5 or Anthropic) → one
    Anthropic content block (or None when the block is dropped). Pure;
    no I/O. The single source of truth for the wire translation. Drops
    unknown block kinds silently; a per-kind warn-once fires so a new
    AI SDK release that adds a block type we don't translate becomes
    visible without crashing the run.

    Pass-through: blocks already in Anthropic shape (detected by their
    field set, not the `type` string) are copied as-is. This is what
    makes same-stack Python resumes (Anthropic in, Anthropic out)
    byte-identical to the pre-translator behaviour, and what keeps
    the response flow working while a TS-suspended run is being
    resumed — Python writes Anthropic-shape blocks, and the
    translator must not corrupt them on the way back to the model.
    """
    if not isinstance(block, dict):
        return None
    block_type = block.get("type")

    if block_type == "text":
        text = block.get("text")
        return {"type": "text", "text": text} if isinstance(text, str) else None

    if block_type == "image":
        if "source" in block:
            return dict(block)
        return _translate_image_block(block)

    if block_type == "file":
        return _translate_file_block(block)

    if block_type == "tool-call":
        return _translate_tool_call_block(block)

    if block_type == "tool-result":
        return _translate_tool_result_block(block)

    if block_type == "tool_use":
        if "id" in block and "name" in block:
            return dict(block)
        _warn_unknown_block_kind("tool_use:missing-fields")
        return None

    if block_type == "tool_result":
        if "tool_use_id" in block:
            return dict(block)
        _warn_unknown_block_kind("tool_result:missing-tool_use_id")
        return None

    if block_type == "reasoning":
        return {"type": "redacted_thinking", "data": _REDACTED_THINKING_SENTINEL}

    _warn_unknown_block_kind(block_type)
    return None


def _translate_image_block(block: dict[str, Any]) -> dict[str, Any] | None:
    """AI SDK {type:'image', image:...} → Anthropic {type:'image', source:...}.
    Supports URL strings and `data:<media>;base64,<data>` URIs. Other
    shapes (binary buffers) drop with a warn-once."""
    image = block.get("image")
    if isinstance(image, str):
        if image.startswith("data:"):
            head, _, data = image.partition(",")
            media_type = head.split(";", 1)[0].removeprefix("data:") or "application/octet-stream"
            return {
                "type": "image",
                "source": {"type": "base64", "media_type": media_type, "data": data},
            }
        return {"type": "image", "source": {"type": "url", "url": image}}
    _warn_unknown_block_kind("image:non-string")
    return None


def _translate_file_block(block: dict[str, Any]) -> dict[str, Any] | None:
    """AI SDK {type:'file', ...} → Anthropic {type:'document', source:...}
    for PDF mediaType only. Non-PDF mediaType drops with a warn-once."""
    media_type = block.get("mediaType")
    if media_type != "application/pdf":
        _warn_unknown_block_kind(f"file:mediaType={media_type}")
        return None
    data = block.get("data")
    if isinstance(data, str):
        if data.startswith("data:"):
            head, _, payload = data.partition(",")
            mt = head.split(";", 1)[0].removeprefix("data:") or "application/pdf"
            return {
                "type": "document",
                "source": {"type": "base64", "media_type": mt, "data": payload},
            }
        return {"type": "document", "source": {"type": "url", "url": data}}
    _warn_unknown_block_kind("file:non-string-data")
    return None


def _translate_tool_call_block(block: dict[str, Any]) -> dict[str, Any]:
    """AI SDK {type:'tool-call', toolCallId, toolName, input}
    → Anthropic {type:'tool_use', id, name, input}."""
    tool_call_id = block.get("toolCallId")
    if not isinstance(tool_call_id, str) or not tool_call_id:
        _warn_unknown_block_kind("tool-call:empty-id")
        tool_call_id = "unknown"
    return {
        "type": "tool_use",
        "id": tool_call_id,
        "name": block.get("toolName", ""),
        "input": block.get("input", {}),
    }


def _translate_tool_result_block(block: dict[str, Any]) -> dict[str, Any] | None:
    """AI SDK {type:'tool-result', toolCallId, output:{type, value}}
    → Anthropic {type:'tool_result', tool_use_id, content, is_error}.
    Five `output.type` variants: 'text', 'json', 'error-text', 'error-json',
    'content'. Anything else drops with a warn-once."""
    tool_call_id = block.get("toolCallId")
    if not isinstance(tool_call_id, str) or not tool_call_id:
        tool_call_id = "unknown"
    output = block.get("output")
    if not isinstance(output, dict):
        _warn_unknown_block_kind("tool-result:no-output")
        return None
    out_type = output.get("type")
    if out_type == "text":
        return {
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": output.get("value", ""),
            "is_error": False,
        }
    if out_type == "json":
        return {
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": json.dumps(output.get("value")),
            "is_error": False,
        }
    if out_type == "error-text":
        return {
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": output.get("value", ""),
            "is_error": True,
        }
    if out_type == "error-json":
        return {
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": json.dumps(output.get("value")),
            "is_error": True,
        }
    if out_type == "content":
        inner = output.get("value")
        if not isinstance(inner, list):
            return None
        translated: list[dict[str, Any]] = []
        for ib in inner:
            if not isinstance(ib, dict) or ib.get("type") != "text":
                _warn_unknown_block_kind("tool-result:content:non-text-inner")
                continue
            translated.append({"type": "text", "text": ib.get("text", "")})
        if not translated:
            return None
        return {
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": translated,
            "is_error": False,
        }
    _warn_unknown_block_kind(f"tool-result:output-type={out_type}")
    return None


def _translate_ai_sdk_message(message: dict[str, Any]) -> dict[str, Any] | None:
    """Convert one AI SDK v5 ModelMessage to an Anthropic-shaped
    `{role, content}`. Returns None when the message carries no usable
    content after translation. Handles the `role: 'tool'` →
    `role: 'user'` remap (Anthropic has no 'tool' role) and delegates
    block-level translation to _translate_block."""
    role = message.get("role")
    content = message.get("content")
    if isinstance(content, str):
        if not content:
            return None
        if role in ("user", "assistant"):
            return {"role": role, "content": content}
        return None
    if not isinstance(content, list):
        return None
    blocks = [b for b in (_translate_block(b) for b in content) if b is not None]
    if not blocks:
        return None
    if role == "tool":
        return {"role": "user", "content": blocks}
    if role in ("user", "assistant"):
        return {"role": role, "content": blocks}
    return None


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
