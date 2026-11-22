"""HarnessAdapter — the seam between the run model and whatever runs the
agent (Q8, Q31).

The frontend never knows which harness runs. An adapter takes a run's
input, emits **internal** events through a `RunEmitter` while it works,
and returns how the run ended. Today's agent loop (`runner.py` +
`executor.py`'s step functions) becomes the first adapter in wave 3b-C;
LangChain `deepagents` or the Claude Agent SDK are later adapters
(Phase 6). `ScriptedHarness` below is the test fake.

**Who writes what.** The adapter emits only *progress*: tokens, steps,
tool input/output, parts, plans, step errors, handoffs. The **run
driver** (3b-B / 3b-C) owns the run's lifecycle and writes everything
terminal from the returned outcome — the adapter never emits a `result`,
a terminal or `paused` `status`, or an `approval` request:

| outcome        | driver appends to the log                         | `tasks` row (via `RunRepository.settle`) |
|----------------|---------------------------------------------------|------------------------------------------|
| `Succeeded`    | `result { status: done, final_text, memory_tainted, usage }` | `done`, outcome `success`      |
| `Interrupted`  | one `approval` request per interrupt, `status: paused` | `paused`, outcome `interrupt`       |
| `Failed`       | `result { status: failed, error, error_code, usage }` | `failed`, outcome `error`          |
| `Cancelled`    | `status: cancelled`                               | `cancelled`, outcome `cancelled`         |
| `Yielded`      | nothing (background only: persist `checkpoint`, re-enqueue) | unchanged                    |

so every run's log ends the same way whichever harness ran it. An
adapter wrapping a loop that emits terminal events itself (today's
`run_agent_loop`) translates them into the outcome instead — e.g. by
handing the loop an emitter whose sink captures `result` /
`status: cancelled` rather than appending them.

**Harness state (Q31)** stays opaque: the adapter gets the run's stored
`checkpoint` (if any) in `RunInput` and may return a new one; the driver
stores it in `tasks.checkpoint` without looking inside. A harness with
its own persistence (a LangGraph checkpointer) keys it by run / thread
in its own tables and may ignore both.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

from ..emitter import RunEmitter
from .credentials import LocalMcpCredential
from .model import Cancelled, RunMode, RunOutcome, Succeeded

__all__ = [
    "CancelSignal",
    "HarnessAdapter",
    "HarnessOutcome",
    "HarnessResult",
    "ResumeAnswer",
    "RunInput",
    "ScriptStep",
    "ScriptedHarness",
    "Yielded",
]


@dataclass(frozen=True)
class ResumeAnswer:
    """One AG-UI `ResumeEntry` (RUN_EVENTS.md § 4.2): the answer to one
    open interrupt of `RunInput.previous_run_id`, already checked by the
    API to cover exactly that run's open interrupts."""

    interrupt_id: str
    status: Literal["resolved", "cancelled"]
    payload: object | None = None
    """`{approved, args?}` | `{selection}` | `{value}` | `{uiAnswer}`;
    None for `cancelled`."""


@dataclass(frozen=True)
class RunInput:
    """What a run was asked to do: the validated `StartRunRequest`
    (AG-UI `RunAgentInput` + `forwardedProps`), as plain JSON, plus what
    the backend knows about the run. `messages` is the whole thread
    history the client sent (Q15); an adapter must skip `activity`
    messages (display state) when it builds model input."""

    run_id: str
    thread_id: str
    mode: RunMode
    user_id: str | None
    """None for an anonymous run (no user data may be read for it)."""
    messages: tuple[dict[str, object], ...]
    """AG-UI `Message` objects (`role`: user / assistant / tool / …)."""
    options: dict[str, object] = field(default_factory=dict)
    """`forwardedProps` (`RunForwardedProps`: `model`, `systemPrompt`,
    `skills`, `maxSteps`, `goal`, and keys later waves add)."""
    tools: tuple[dict[str, object], ...] = ()
    """Client-side AG-UI `Tool`s."""
    context: tuple[dict[str, object], ...] = ()
    state: object | None = None
    """AG-UI `state`, minus `hummingbird.localMcp` (taken out into
    `local_mcp_credentials` before the input is built)."""
    resume: tuple[ResumeAnswer, ...] = ()
    previous_run_id: str | None = None
    parent_run_id: str | None = None
    checkpoint: dict[str, object] | None = None
    """The harness state stored for this run (`tasks.checkpoint`): set
    for a background run's continuation, None for a fresh run."""
    previous_checkpoint: dict[str, object] | None = None
    """On a resume run (`resume` non-empty, Q24): the harness state the
    interrupted run `previous_run_id` returned with its `Interrupted`
    outcome (its `tasks.checkpoint`, or the anonymous store's copy) — what
    the answers continue from (Q31). None when that run stored none; an
    adapter then rebuilds what it can from `messages`."""
    client_key: str | None = None
    """The caller's rate-limit key (`rate_limit.rate_limit_key`: the
    client IP behind the trusted proxies) — what per-IP tool budgets
    count against, for anonymous and signed-in runs alike. None when the
    run was not started over HTTP (tests, background executor)."""
    local_mcp_credentials: Mapping[str, LocalMcpCredential] = field(
        default_factory=dict, repr=False, compare=False
    )
    """Local MCP server id → credential, from `state["hummingbird.localMcp"]`
    (Q45, `runs.credentials`). Interactive runs only; in memory only —
    never stored, logged or emitted, so not in the repr either."""


class CancelSignal(Protocol):
    """Set once the run is cancelled (a `cancelRun`, a lost lease, the
    client hanging up on an interactive run per the driver's policy).
    `asyncio.Event` satisfies it. The adapter checks it at least between
    model calls / tool executions and returns `Cancelled()` promptly; it
    may also `await wait()` to abort a long operation."""

    def is_set(self) -> bool: ...

    async def wait(self) -> Literal[True]: ...


@dataclass(frozen=True)
class Yielded:
    """Background runs only: the harness stopped at a step boundary —
    its time budget ran out, or it is waiting on its own sub-agent runs —
    and continues later from `HarnessResult.checkpoint` (today's
    `continue` job / fan-in). Not an end state: the run stays `running`
    (`paused` while `awaiting_children`). An interactive adapter never
    yields (Q28)."""

    reason: Literal["time_budget", "awaiting_children"]


HarnessOutcome = RunOutcome | Yielded


@dataclass(frozen=True)
class HarnessResult:
    outcome: HarnessOutcome
    checkpoint: dict[str, object] | None = None
    """Harness state to store (`tasks.checkpoint`), opaque to the driver.
    Required with `Yielded` and with `Interrupted` on a background run
    (the answer continues from it); None means "leave it as it is"."""


class HarnessAdapter(Protocol):
    """Runs one run's agent. Contract:

    * Emits progress events through `emitter` only (never terminal ones —
      see the module docstring); the emitter's seq / step bookkeeping is
      the driver's, seeded before the call.
    * Returns a `HarnessResult`; never raises for an agent-level failure
      (model / tool / budget errors are `Failed(code, message)` with an
      `ApiError` code). An exception escaping `run` is a bug: the driver
      fails the run with code `unknown`.
    * Honours `cancel` (`CancelSignal`) and then returns
      `HarnessResult(Cancelled())` — events already emitted stay.
    * Reads nothing of the user's beyond `run_input` unless
      `run_input.user_id` is set, and then only as that user (RLS).
    """

    name: str
    """Recorded on the run (`tasks.metadata.handler`), e.g. `loop-v1`."""

    async def run(
        self, run_input: RunInput, emitter: RunEmitter, cancel: CancelSignal
    ) -> HarnessResult: ...


# --- Fake ----------------------------------------------------------------------

ScriptStep = Callable[[RunEmitter], Awaitable[None]]
"""One scripted step: emit whatever progress events it likes."""


class ScriptedHarness:
    """A `HarnessAdapter` that plays a fixed script, for testing drivers,
    streams and the runs API without a model. Before each step it checks
    `cancel` and returns `Cancelled()` if set; after the last step it
    returns `result`. Records every `RunInput` it was given."""

    name = "scripted"

    def __init__(
        self,
        steps: Sequence[ScriptStep] = (),
        *,
        result: HarnessResult | None = None,
        step_delay: float = 0.0,
    ) -> None:
        self._steps = list(steps)
        self._result = result if result is not None else HarnessResult(Succeeded())
        self._step_delay = step_delay
        self.inputs: list[RunInput] = []

    async def run(
        self, run_input: RunInput, emitter: RunEmitter, cancel: CancelSignal
    ) -> HarnessResult:
        self.inputs.append(run_input)
        for step in self._steps:
            if cancel.is_set():
                return HarnessResult(Cancelled())
            await emitter.start_step()
            await step(emitter)
            await emitter.end_step()
            if self._step_delay:
                await asyncio.sleep(self._step_delay)
        if cancel.is_set():
            return HarnessResult(Cancelled())
        return self._result

    @staticmethod
    def say(text: str, *, channel: Literal["text", "reasoning"] = "text") -> ScriptStep:
        """A step that emits one token."""

        async def step(emitter: RunEmitter) -> None:
            await emitter.token(text, channel=channel)

        return step
