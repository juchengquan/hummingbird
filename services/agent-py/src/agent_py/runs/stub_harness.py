"""A model-free `HarnessAdapter` for the conformance suite and local dev.

Enabled by `RUNS_STUB_HARNESS=true` (never in production). It answers
every run without a model, so the contract's runs cases cost nothing,
and it can be steered per run through `forwardedProps.conformance` —
an open `RunForwardedProps` key that every other harness ignores:

    "conformance": {
      "outcome": "succeed" | "fail" | "interrupt",   # default "succeed"
      "interrupt": "approval" | "ui-part",            # default "approval"
      "steps": 1..20,                                 # default 1
      "stepDelayMs": 0..10000,                        # default 0
      "failBeforeApplying": true | false              # default false
    }

* `succeed` — `steps` steps, each one `step_start`, one `token`,
  `step_end`; then `Succeeded` with the text it streamed.
* `fail` — the same steps, then `Failed("provider", …)`.
* `interrupt` — the same steps, then `Interrupted` with one `approval`
  interrupt (id `<runId>:approve`), or with `"interrupt": "ui-part"` one
  `renderUI` confirm part (id `<runId>:ui`, props `{prompt: "Confirm the
  stub action?"}`). A run that answers it (`resume[]`) succeeds, saying
  how each interrupt was answered — after recording, as the native
  harness does, that it applies the answers (`RunInput.apply_answers`,
  Q63), so a resume steered to `fail` closes the question.
* `stepDelayMs` — a pause after each step (cancellable), so a run stays
  live long enough to cancel it or to rejoin it mid-flight.
* `failBeforeApplying` — a resume fails at once, before it applies its
  answers (as when no model can be called), so the interrupts stay
  answerable. A resume steered to `fail` without it fails after
  applying them, which closes them for good (Q63).
"""

from __future__ import annotations

import asyncio
import contextlib

from ..emitter import RunEmitter
from .harness import CancelSignal, HarnessResult, RunInput
from .history import last_user_text
from .model import (
    Cancelled,
    Failed,
    Interrupted,
    PendingInterrupt,
    RunResultData,
    Succeeded,
)

__all__ = ["StubHarness"]

_MAX_STEPS = 20
_MAX_DELAY_MS = 10_000


def _int(raw: object, default: int, lo: int, hi: int) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int):
        return default
    return max(lo, min(hi, raw))


class StubHarness:
    name = "stub"

    async def run(
        self, run_input: RunInput, emitter: RunEmitter, cancel: CancelSignal
    ) -> HarnessResult:
        raw = run_input.options.get("conformance")
        cfg = raw if isinstance(raw, dict) else {}
        outcome = cfg.get("outcome", "succeed")
        steps = _int(cfg.get("steps"), 1, 1, _MAX_STEPS)
        delay = _int(cfg.get("stepDelayMs"), 0, 0, _MAX_DELAY_MS) / 1000

        if run_input.resume and cfg.get("failBeforeApplying") is True:
            return HarnessResult(
                Failed("provider", "Stub harness failure before applying (requested).")
            )
        if run_input.resume and run_input.apply_answers is not None:
            if cancel.is_set():
                return HarnessResult(Cancelled())
            if not await run_input.apply_answers():
                return HarnessResult(Cancelled())
        if run_input.resume:
            first = "Resumed: " + ", ".join(
                f"{a.interrupt_id}={a.status}" for a in run_input.resume
            )
        else:
            first = f"Stub reply to: {last_user_text(run_input.messages)[:200]}"
        texts = [first] + [f" (step {i + 1})" for i in range(1, steps)]

        for text in texts:
            if cancel.is_set():
                return HarnessResult(Cancelled())
            await emitter.start_step()
            await emitter.token(text)
            await emitter.end_step()
            if delay:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(cancel.wait(), timeout=delay)
        if cancel.is_set():
            return HarnessResult(Cancelled())

        if outcome == "fail":
            return HarnessResult(Failed("provider", "Stub harness failure (requested)."))
        if outcome == "interrupt" and not run_input.resume and cfg.get("interrupt") == "ui-part":
            ui_props: dict[str, object] = {"prompt": "Confirm the stub action?"}
            return HarnessResult(
                Interrupted(
                    (
                        PendingInterrupt(
                            id=f"{run_input.run_id}:ui",
                            request_kind="ui-part",
                            tool="renderUI",
                            tool_call_id=f"{run_input.run_id}:ui",
                            args={"kind": "confirm", "props": ui_props},
                            ui_kind="confirm",
                            ui_props=ui_props,
                        ),
                    )
                )
            )
        if outcome == "interrupt" and not run_input.resume:
            return HarnessResult(
                Interrupted(
                    (
                        PendingInterrupt(
                            id=f"{run_input.run_id}:approve",
                            request_kind="approval",
                            tool="stubAction",
                            tool_call_id=f"{run_input.run_id}:call",
                            args={},
                            prompt="Approve the stub action?",
                        ),
                    )
                )
            )
        return HarnessResult(Succeeded(RunResultData(text="".join(texts))))
