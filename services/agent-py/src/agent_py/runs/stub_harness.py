"""A model-free `HarnessAdapter` for the conformance suite and local dev.

Enabled by `RUNS_STUB_HARNESS=true` (never in production). It answers
every run without a model, so the contract's runs cases cost nothing,
and it can be steered per run through `forwardedProps.conformance` —
an open `RunForwardedProps` key that every other harness ignores:

    "conformance": {
      "outcome": "succeed" | "fail" | "interrupt",   # default "succeed"
      "steps": 1..20,                                 # default 1
      "stepDelayMs": 0..10000                         # default 0
    }

* `succeed` — `steps` steps, each one `step_start`, one `token`,
  `step_end`; then `Succeeded` with the text it streamed.
* `fail` — the same steps, then `Failed("provider", …)`.
* `interrupt` — the same steps, then `Interrupted` with one `approval`
  interrupt (id `<runId>:approve`). A run that answers it (`resume[]`)
  succeeds, saying how each interrupt was answered.
* `stepDelayMs` — a pause after each step (cancellable), so a run stays
  live long enough to cancel it or to rejoin it mid-flight.
"""

from __future__ import annotations

import asyncio
import contextlib

from ..emitter import RunEmitter
from .harness import CancelSignal, HarnessResult, RunInput
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


def _last_user_text(messages: tuple[dict[str, object], ...]) -> str:
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return " ".join(
                str(p.get("text", ""))
                for p in content
                if isinstance(p, dict) and p.get("type") == "text"
            )
    return ""


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

        if run_input.resume:
            first = "Resumed: " + ", ".join(
                f"{a.interrupt_id}={a.status}" for a in run_input.resume
            )
        else:
            first = f"Stub reply to: {_last_user_text(run_input.messages)[:200]}"
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
