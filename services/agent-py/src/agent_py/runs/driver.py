"""The run driver — executes interactive runs in the API process (Q28).

An interactive run runs in the process that received `POST /v1/runs`
(`RunDriver.start`), detached from the HTTP request: the caller's
stream is just a reader of the run's event log (replay from `0` + live
tail, the same mechanism as a rejoin), so a dropped connection does not
stop the run, and a retry or reconnect behaves exactly like the first
response. Lifecycle of one run:

    created (repo.create — row `running`, leased)
      → previous run's checkpoint → RunInput.previous_checkpoint (resume)
      → harness.run(run_input, emitter, cancel)    progress → log
      → emitter.aclose()                             buffered deltas get their seq
      → terminal entries from the outcome (harness.py's table)
      → repo.settle(outcome, checkpoint)             row ends
      → log.seal                                     streams drain + stop
      → post_settle(run)                             optional hook

**Emitter.** The harness emits through a `CoalescingEmitter` (Q30):
consecutive text deltas are merged before they get a seq, so the log
holds one entry per ~150 ms of text rather than one per model chunk.

**Log caps.** The anonymous memory log refuses appends past its caps
(`RunLogFull`). The driver then stops the harness and fails the run
`limit_reached`; the terminal entries are always accepted.

**Resume checkpoint (Q24, Q31).** An `Interrupted` outcome's
`HarnessResult.checkpoint` is stored with the settle (`tasks.checkpoint`,
or the memory store's copy). A resume run (`resume[]` + previous run)
gets it back as `RunInput.previous_checkpoint`, read as the run's own
owner — RLS for a signed-in owner, the run token's runs for an anonymous
one — so a run never continues from someone else's state.

**Ordering.** Terminal entries are appended *before* the row settles, so
a stream that ends on the row (RUN_EVENTS.md § 6.4) has already seen
the `result` (and its usage). If a cancel or a reap ends the row first,
the driver writes the entry matching the row instead (`status:
cancelled`, or the reaper's `result: failed`) — the row is the truth,
and the driver, holding the run's emitter, is the only writer of its
log while it runs (a second writer could reuse a seq, and the log
silently keeps the first of two entries with the same seq).

**Lease + heartbeat.** Every `heartbeat_seconds` the driver extends the
run's lease (`repo.heartbeat`). A heartbeat answering False means the
row is no longer live — cancelled by a request served by another
process, or reaped — and the driver signals the harness to stop.

**Cancel.** `signal_cancel(run_id)` reaches a run executing in this
process at once (the cancel route calls it after `repo.cancel`); a run
executing elsewhere learns of it on its next heartbeat — the
cross-process path, at most `heartbeat_seconds` late. Either way the
streams close as soon as the row is cancelled.

**Reaper.** `reap_interactive_runs` fails live interactive runs whose
lease lapsed (their process died — Q28: fail, never hand over), writes
each one's terminal `result` and seals its log. A lapsed run that is
still executing here (a stalled event loop) is left to its own driver.

**Shutdown.** `shutdown()` stops every local run; they end `failed /
worker_lost` (the process is going away; nothing will resume them).
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Literal

import structlog

from ..emitter import RunEmitter
from ..events import ResultEvent, TaskEvent
from .coalescer import CoalescingEmitter
from .event_log import RunEventLog
from .event_log_memory import RunLogFull
from .harness import HarnessAdapter, RunInput, Yielded
from .model import Cancelled, Failed, Interrupted, RunOutcome, RunRecord, Succeeded
from .repository import RunRepository

__all__ = [
    "LOG_FULL_MESSAGE",
    "SHUTDOWN_MESSAGE",
    "WORKER_LOST_MESSAGE",
    "PostSettleHook",
    "RunDriver",
    "reap_interactive_runs",
]

logger = structlog.get_logger(__name__)

PostSettleHook = Callable[[RunRecord], Awaitable[None]]
"""Called once a run executed here has settled and its log is sealed
(compaction scheduling, wave 3b-A). Errors are logged, never raised."""

WORKER_LOST_MESSAGE = "The run's process stopped unexpectedly."
SHUTDOWN_MESSAGE = "The server restarted while the run was in progress."
UNEXPECTED_MESSAGE = "The run failed unexpectedly."
LOG_FULL_MESSAGE = "The run produced more output than this server keeps for it."

_StopReason = Literal["cancelled", "lease_lost", "shutdown", "log_full"]


@dataclass
class _Active:
    run: RunRecord
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    reason: _StopReason | None = None
    task: asyncio.Task[None] | None = None

    def stop(self, reason: _StopReason) -> None:
        if self.reason is None:
            self.reason = reason
        self.cancel.set()


class RunDriver:
    def __init__(
        self,
        *,
        lease_seconds: float,
        heartbeat_seconds: float,
        post_settle: PostSettleHook | None = None,
    ) -> None:
        self._lease_s = lease_seconds
        self._heartbeat_s = max(0.05, heartbeat_seconds)
        self._post_settle = post_settle
        self._active: dict[str, _Active] = {}

    # -- registry --

    def is_local(self, run_id: str) -> bool:
        """Whether `run_id` is executing in this process."""
        return run_id in self._active

    def signal_cancel(self, run_id: str) -> bool:
        """Stop a local run after its row was cancelled. False when the
        run is not executing here."""
        active = self._active.get(run_id)
        if active is None:
            return False
        active.stop("cancelled")
        return True

    def signal_lease_lost(self, run_id: str) -> bool:
        active = self._active.get(run_id)
        if active is None:
            return False
        active.stop("lease_lost")
        return True

    # -- execution --

    def start(
        self,
        *,
        run: RunRecord,
        run_input: RunInput,
        repo: RunRepository,
        log: RunEventLog,
        harness: HarnessAdapter,
    ) -> asyncio.Task[None]:
        """Execute `run` (just created, `running`) in the background and
        return its task. Idempotent per run id while it executes."""
        existing = self._active.get(run.id)
        if existing is not None and existing.task is not None:
            return existing.task
        active = _Active(run=run)
        self._active[run.id] = active
        active.task = asyncio.create_task(
            self._drive(active, run_input, repo, log, harness), name=f"agent-py.run.{run.id}"
        )
        return active.task

    async def _drive(
        self,
        active: _Active,
        run_input: RunInput,
        repo: RunRepository,
        log: RunEventLog,
        harness: HarnessAdapter,
    ) -> None:
        run = active.run
        hb: asyncio.Task[None] | None = None
        interrupted_by_cancel = False
        try:

            async def sink(event: TaskEvent) -> None:
                try:
                    await log.append(event)
                except RunLogFull:
                    logger.warning("runs.driver.log_full", run_id=run.id, seq=event.seq)
                    active.stop("log_full")
                    raise

            emitter: RunEmitter = CoalescingEmitter(
                run_id=run.id, sink=sink, start_seq=await log.last_seq(run.id)
            )
            hb = asyncio.create_task(
                self._heartbeat(active, repo), name=f"agent-py.run.hb.{run.id}"
            )
            outcome: RunOutcome
            checkpoint: dict[str, object] | None = None
            try:
                run_input = await _with_previous_checkpoint(run_input, run, repo)
                result = await harness.run(run_input, emitter, active.cancel)
                if isinstance(result.outcome, Yielded):
                    logger.error("runs.driver.interactive_yield", run_id=run.id)
                    outcome = Failed("unknown", UNEXPECTED_MESSAGE)
                else:
                    outcome = result.outcome
                    if isinstance(outcome, Interrupted):
                        checkpoint = result.checkpoint
            except asyncio.CancelledError:
                # Hard stop (shutdown past its grace): finish the run's
                # bookkeeping below, then let the cancellation through.
                interrupted_by_cancel = True
                active.reason = active.reason or "shutdown"
                outcome = Failed("worker_lost", SHUTDOWN_MESSAGE)
            except Exception:
                logger.exception("runs.driver.harness_raised", run_id=run.id, harness=harness.name)
                outcome = Failed("unknown", UNEXPECTED_MESSAGE)
            if active.reason == "shutdown" and not isinstance(outcome, Failed):
                outcome = Failed("worker_lost", SHUTDOWN_MESSAGE)
            if hb is not None:
                hb.cancel()
            # Give buffered deltas their seq before any terminal entry.
            try:
                if isinstance(emitter, CoalescingEmitter):
                    await emitter.aclose()
            except RunLogFull:
                pass  # recorded by the sink (active.reason == "log_full")
            except Exception as exc:
                logger.warning("runs.driver.flush_failed", run_id=run.id, error=str(exc))
            if active.reason == "log_full":
                usage = () if isinstance(outcome, Interrupted) else outcome.usage
                outcome = Failed("limit_reached", LOG_FULL_MESSAGE, usage=usage)
                checkpoint = None

                # The coalescer keeps the refused entry queued (it would
                # retry it first); the terminal entries take the next seq
                # after what the log actually holds.
                async def terminal_sink(event: TaskEvent) -> None:
                    await log.append(event)

                emitter = RunEmitter(
                    run_id=run.id,
                    sink=terminal_sink,
                    start_seq=await log.last_seq(run.id),
                    start_step=emitter.step,
                )
            await self._finish(active, outcome, emitter, repo, log, checkpoint=checkpoint)
        except Exception:
            logger.exception("runs.driver.failed", run_id=run.id)
        finally:
            if hb is not None:
                hb.cancel()
            self._active.pop(run.id, None)
        if interrupted_by_cancel:
            raise asyncio.CancelledError()

    async def _heartbeat(self, active: _Active, repo: RunRepository) -> None:
        while not active.cancel.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(active.cancel.wait(), timeout=self._heartbeat_s)
            if active.cancel.is_set():
                return
            try:
                alive = await repo.heartbeat(active.run.id, lease_seconds=self._lease_s)
            except Exception as exc:
                # A DB blip must not kill the run; the lease has slack.
                logger.warning("runs.driver.heartbeat_failed", run_id=active.run.id, error=str(exc))
                continue
            if not alive:
                logger.info("runs.driver.lease_lost", run_id=active.run.id)
                active.stop("lease_lost")
                return

    async def _finish(
        self,
        active: _Active,
        outcome: RunOutcome,
        emitter: RunEmitter,
        repo: RunRepository,
        log: RunEventLog,
        *,
        checkpoint: dict[str, object] | None = None,
    ) -> None:
        run = active.run
        current: RunRecord | None = None
        if active.reason in ("cancelled", "lease_lost"):
            # Someone else ended the row (a cancel, the reaper): the log's
            # terminal entry follows the row, not the harness.
            current = await repo.get(run.owner, run.id)
        if current is not None and not current.is_live:
            await _safely(run.id, _append_for_row(emitter, current))
        else:
            await _safely(run.id, _append_terminal(emitter, outcome))
            # False → a cancel / reap won the race after our entry; the
            # row is the truth and the stream's closing event follows it.
            await repo.settle(run.id, outcome, checkpoint=checkpoint)
        await _safely(run.id, log.seal(run.id))
        if self._post_settle is not None:
            final = await repo.get(run.owner, run.id)
            if final is not None:
                try:
                    await self._post_settle(final)
                except Exception:
                    logger.exception("runs.driver.post_settle_failed", run_id=run.id)

    # -- shutdown --

    async def shutdown(self, *, grace_s: float) -> None:
        """Stop every local run (they settle `failed / worker_lost`), wait
        up to `grace_s` for their bookkeeping, then cancel what is left."""
        actives = list(self._active.values())
        for active in actives:
            active.stop("shutdown")
        tasks = [a.task for a in actives if a.task is not None]
        if not tasks:
            return
        _done, pending = await asyncio.wait(tasks, timeout=max(0.0, grace_s))
        for task in pending:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task


async def _with_previous_checkpoint(
    run_input: RunInput, run: RunRecord, repo: RunRepository
) -> RunInput:
    """A resume run's `previous_checkpoint`: the harness state its
    previous run stored when it was interrupted, read as this run's
    owner (a run the owner cannot read yields None — the API checked the
    previous run is theirs on this thread already)."""
    previous = run_input.previous_run_id
    if not run_input.resume or previous is None or run_input.previous_checkpoint is not None:
        return run_input
    try:
        checkpoint = await repo.load_checkpoint(run.owner, previous)
    except Exception as exc:
        # The harness falls back to the browser's history.
        logger.warning("runs.driver.checkpoint_load_failed", run_id=run.id, error=str(exc))
        return run_input
    if checkpoint is None:
        return run_input
    return replace(run_input, previous_checkpoint=checkpoint)


async def _append_terminal(emitter: RunEmitter, outcome: RunOutcome) -> None:
    """harness.py's table: the log's terminal entries for `outcome`."""
    if isinstance(outcome, Succeeded):
        await emitter.result(
            "done",
            final_text=outcome.result.text,
            memory_tainted=outcome.result.memory_tainted,
            usage=outcome.usage,
        )
    elif isinstance(outcome, Interrupted):
        for i in outcome.interrupts:
            await emitter.input_request(
                approval_id=i.id,
                request_kind=i.request_kind,
                tool=i.tool,
                tool_call_id=i.tool_call_id,
                args=i.args,
                prompt=i.prompt,
                options=None if i.options is None else list(i.options),
                multi=i.multi,
                ui_kind=i.ui_kind,
                ui_props=i.ui_props,
            )
        await emitter.status("paused")
    elif isinstance(outcome, Failed):
        await emitter.result(
            "failed", error=outcome.message, error_code=outcome.code, usage=outcome.usage
        )
    elif isinstance(outcome, Cancelled):
        await emitter.status("cancelled")


async def _append_for_row(emitter: RunEmitter, run: RunRecord) -> None:
    """The terminal entry matching a row someone else ended."""
    if run.internal_status == "cancelled":
        await emitter.status("cancelled")
    elif run.internal_status == "failed":
        error = run.error or {}
        await emitter.result(
            "failed",
            error=str(error.get("message", WORKER_LOST_MESSAGE)),
            error_code=str(error.get("code", "worker_lost")),
        )


async def _safely(run_id: str, op: Awaitable[None]) -> None:
    try:
        await op
    except Exception as exc:
        # E.g. the reaper sealed the log first: the run is already over.
        logger.warning("runs.driver.log_write_failed", run_id=run_id, error=str(exc))


async def reap_interactive_runs(
    repo: RunRepository,
    log: RunEventLog,
    *,
    driver: RunDriver | None = None,
    limit: int = 50,
) -> int:
    """Fail live interactive runs whose lease lapsed (Q28) and close their
    logs: one `result { status: failed, error_code: worker_lost }` entry
    after the last one, then `seal`. Returns how many were reaped."""
    reaped = await repo.reap_expired(limit=limit)
    for run in reaped:
        logger.warning("runs.reaper.reaped", run_id=run.id)
        if driver is not None and driver.signal_lease_lost(run.id):
            continue  # still executing here: its driver writes the entry
        error = run.error or {}
        try:
            last = await log.last_seq(run.id)
            tail = await log.read(run.id, after_seq=max(0, last - 1))
            step = tail[-1].step if tail else 0
            await log.append(
                ResultEvent(
                    run_id=run.id,
                    seq=last + 1,
                    step=step,
                    created_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                    status="failed",
                    error=str(error.get("message", WORKER_LOST_MESSAGE)),
                    error_code=str(error.get("code", "worker_lost")),
                )
            )
            await log.seal(run.id)
        except Exception as exc:
            logger.warning("runs.reaper.log_failed", run_id=run.id, error=str(exc))
    return len(reaped)
