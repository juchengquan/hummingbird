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
class RunStepOutcome:
    """Result of running one step.

    `done=True` means the model produced a final answer; the loop
    settles. `done=False` means the model called tools; loop again.
    """

    done: bool


class RunStepFn(Protocol):
    """The injected per-step driver. Stub for Phase 2a; real model
    in Phase 2b."""

    async def __call__(self, ctx: RunStepContext) -> RunStepOutcome: ...


AgentLoopResultKind = Literal["settled", "cancelled"]


@dataclass(frozen=True)
class AgentLoopResult:
    """Loop outcome. Phase 2a only emits `settled` (happy path) or
    `cancelled` (cancel detected between steps). `suspended` (HITL)
    + `yielded` (chunk break) land in Phase 3+ when the executor
    needs them."""

    kind: AgentLoopResultKind


IsCancelledFn = Callable[[], Awaitable[bool]]


async def run_agent_loop(
    *,
    emitter: RunEmitter,
    max_steps: int,
    run_step: RunStepFn,
    is_cancelled: IsCancelledFn,
) -> AgentLoopResult:
    """Drive a run to completion. Emits exactly one terminal event
    (`status: cancelled` or `result: done|failed`) — the emitter
    drops anything after, so a late callback can't append past the
    end.

    Step counting mirrors the TS path: `emitter.step` starts at 0 on
    a fresh run; the first iteration calls `start_step` which bumps
    to 1, runs the step fn, then `end_step`. The loop iterates until
    the step fn returns `done=True` or we hit `max_steps`.
    """
    # Only emit `status: running` on a fresh start. A continuation
    # (Phase 3 HITL resume) seeds the emitter at the current step
    # counter; the first status emit is the route's job before
    # calling back in.
    if emitter.step == 0:
        await emitter.status("running")

    while emitter.step < max_steps:
        if await is_cancelled():
            await emitter.status("cancelled")
            return AgentLoopResult(kind="cancelled")

        await emitter.start_step()
        outcome = await run_step(RunStepContext(step=emitter.step, emitter=emitter))
        await emitter.end_step()

        if outcome.done:
            await emitter.result("done")
            return AgentLoopResult(kind="settled")

    # Hit the step cap without a final answer. Settle anyway —
    # mirrors the TS path; the model's accumulated text is the
    # answer.
    await emitter.result("done")
    return AgentLoopResult(kind="settled")
