"""The agent runner — control flow only, model call injected.

Port of `runAgentLoop` from `lib/server/agent/runner.ts`. Pure
orchestration: status → per-step (cancel check → start → run_step →
end) → terminal. The model call is a `RunStepFn` injected at runtime
so the loop's control flow (step budget, cancellation, event
sequencing, settle-once) is unit-testable with a fake step, no live
model needed.

`make_stream_step` (the production `RunStepFn` that calls the real
model) is **not** in this PR — Phase 2a ships the loop + a stub
step fn that emits canned events. Phase 2b lands the real
model-streaming step fn alongside the first tool.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from .emitter import RunEmitter


@dataclass(frozen=True)
class RunStepContext:
    """Per-step inputs the step fn receives.

    Mirrors `RunStepContext` in `lib/server/agent/runner.ts`. `signal`
    is left as a `None | object` placeholder until Phase 2b wires
    real `asyncio.CancelledError` propagation through the model call —
    today's stub never blocks long enough to need it.
    """

    step: int
    emitter: RunEmitter
    signal: object | None = None


@dataclass(frozen=True)
class PendingInputDescriptor:
    """A no-execute gated tool call the step fn captured — the run
    suspends here for human input. Mirror of TS
    `PendingInputDescriptor` in `lib/server/agent/runner.ts`.

    `request_kind` is the classifier the executor pulls in from
    `input_policy.request_kind_for(tool, args)` — kept on the
    descriptor so the executor doesn't have to re-classify on the
    suspend path (and so a future step fn can override the default
    classification if needed). Optional / `None` → executor falls
    back to its own classification."""

    tool_call_id: str
    tool: str
    args: dict[str, object] | None = None
    request_kind: str | None = None


@dataclass(frozen=True)
class SpawnSpec:
    """One child to spawn: a persona slug (recorded for labelling; v1
    children run the parent config — see the PR-2 spec) + the subgoal it
    is pinned to."""

    persona_slug: str
    subgoal: str


@dataclass(frozen=True)
class SpawnDescriptor:
    """A no-execute `spawnSubagent` call the step fn captured. The
    executor fans out children + yields; the parent resumes when the
    barrier re-enqueues it, with aggregated results injected as the
    `tool_result` for `tool_call_id`."""

    tool_call_id: str
    tasks: list[SpawnSpec]


@dataclass(frozen=True)
class RunStepOutcome:
    """Result of running one step.

    `done=True` means the model produced a final answer; the loop
    settles. `done=False` + `pending_input=None` means the model
    called tools that the step fn executed and the loop should run
    again. `done=False` + `pending_input=...` means the model called
    a gated tool (no execute path) and the run suspends for human
    input — the runner returns `kind="suspended"` carrying the
    descriptor."""

    done: bool
    pending_input: PendingInputDescriptor | None = None
    spawn: SpawnDescriptor | None = None


class RunStepFn(Protocol):
    """The injected per-step driver. Stub for Phase 2a; real model
    in Phase 2b."""

    async def __call__(self, ctx: RunStepContext) -> RunStepOutcome: ...


AgentLoopResultKind = Literal["settled", "cancelled", "yielded", "suspended", "spawned"]


@dataclass(frozen=True)
class AgentLoopResult:
    """Loop outcome. Five non-terminal possibilities — the executor
    decides what to do next:

    - `settled`: terminal event emitted (`result: done|failed`),
      nothing more to do.
    - `cancelled`: cancel detected between steps; emitter emitted
      `status: cancelled`. Same handling as `settled` (the run is
      over), but distinguished so the executor doesn't ALSO call
      `mark_job_failed`.
    - `yielded`: time-budget gate fired between steps. No terminal
      event emitted; the executor saves the checkpoint and enqueues
      a `continue` job so another chunk picks up where this one left
      off. Mirrors the TS path's "settle without terminal" semantics.
    - `suspended`: a step fn returned `pending_input` (the model
      called a gated tool). No terminal event emitted; the executor
      saves the checkpoint, emits `approval: request` + `status:
      paused`, and waits for a `respond` job. `pending_input` is
      the descriptor for the gated call awaiting an answer.
    - `spawned`: a step fn returned `spawn` (the model called
      `spawnSubagent`). No terminal event emitted; the executor
      creates child task rows, saves the checkpoint, and yields —
      the parent resumes when the barrier re-enqueues it. `spawn`
      is the descriptor for the fan-out (children + their subgoals)."""

    kind: AgentLoopResultKind
    pending_input: PendingInputDescriptor | None = None
    spawn: SpawnDescriptor | None = None


IsCancelledFn = Callable[[], Awaitable[bool]]
ShouldYieldFn = Callable[[], bool]
#: Optional pre-settle hook. Awaited just before the terminal `result`
#: event on the settled path; returns a camelCase `verification` payload
#: to attach to the result (or None). Lets the executor run a citation
#: pass over the assembled report + sources before the emitter latches —
#: nothing can be emitted after `result`. See `agent_py.verify`.
FinalizeFn = Callable[[], Awaitable[dict[str, object] | None]]


async def run_agent_loop(
    *,
    emitter: RunEmitter,
    max_steps: int,
    run_step: RunStepFn,
    is_cancelled: IsCancelledFn,
    should_yield: ShouldYieldFn | None = None,
    finalize: FinalizeFn | None = None,
) -> AgentLoopResult:
    """Drive a run to completion or a chunk-break point. Emits exactly
    one terminal event (`status: cancelled` or `result: done|failed`)
    on `settled` / `cancelled`; emits nothing terminal on `yielded`
    (the executor persists the checkpoint and re-enqueues).

    Step counting mirrors the TS path: `emitter.step` starts at the
    seeded value (0 on fresh start, >0 on `continue` after resume).
    Each iteration:
      1. Check cancelled — if so, emit `status: cancelled`, return.
      2. Check `should_yield()` — if so, return `yielded` without
         emitting anything (the executor's checkpoint write + the
         re-enqueue do the rest).
      3. Run one step. Append `step_start` → `run_step` → `step_end`.
      4. If `outcome.done` → emit `result: done`, return.

    The yield gate fires BEFORE a step starts so we never abandon a
    step mid-flight; budget calibration assumes a step can run to
    completion within the headroom the executor leaves below the
    function cap.
    """
    # Only emit `status: running` on a fresh start. A continuation
    # (Phase 3 HITL resume, or a `continue` chunk after a yield) seeds
    # the emitter at the current step counter; the status event was
    # already emitted on the original `start` action.
    if emitter.step == 0:
        await emitter.status("running")

    while emitter.step < max_steps:
        if await is_cancelled():
            await emitter.status("cancelled")
            return AgentLoopResult(kind="cancelled")

        if should_yield is not None and should_yield():
            return AgentLoopResult(kind="yielded")

        await emitter.start_step()
        outcome = await run_step(RunStepContext(step=emitter.step, emitter=emitter))
        await emitter.end_step()

        if outcome.pending_input is not None:
            # Suspend point — the step fn captured a gated tool call
            # but didn't execute it. The executor owns the next-step
            # plumbing (save checkpoint, emit `approval: request` +
            # `status: paused`); the runner just hands the descriptor
            # back. No terminal event is emitted here.
            return AgentLoopResult(
                kind="suspended",
                pending_input=outcome.pending_input,
            )

        if outcome.spawn is not None:
            # Fan-out point — the step fn captured a `spawnSubagent`
            # call but didn't execute it. The executor creates child
            # task rows + yields; no terminal event here.
            return AgentLoopResult(kind="spawned", spawn=outcome.spawn)

        if outcome.done:
            await _settle(emitter, finalize)
            return AgentLoopResult(kind="settled")

    # Hit the step cap without a final answer. Settle anyway —
    # mirrors the TS path; the model's accumulated text is the
    # answer.
    await _settle(emitter, finalize)
    return AgentLoopResult(kind="settled")


async def _settle(emitter: RunEmitter, finalize: FinalizeFn | None) -> None:
    """Run the optional finalize hook, then emit the terminal
    `result: done`. The hook's failures are the hook's concern (it
    returns None) — settling never blocks on it."""
    verification = await finalize() if finalize is not None else None
    await emitter.result("done", verification=verification)
