"""The agent service's poll loop.

Runs as a background asyncio task started from FastAPI's lifespan.
On each tick:
  1. (Live mode) reap jobs whose lease expired on their last attempt —
     fail the job and settle its task (`_reap_expired`).
  2. Try to claim the next ready job (`jobs.claim_next_job`). Live mode
     also reclaims `running` jobs whose lease expired (dead worker).
  3. If nothing's claimed, sleep.
  4. If a job's claimed, decide what to do with it:
     - `WORKER_DRY_RUN=True` (default) → log + release. The TS worker
       picks it up. This was the Phase 1 happy path.
     - `WORKER_DRY_RUN=False` + user flagged (Phase 2+) → execute via
       the executor while heartbeating the job's lease; settle the job
       done / failed when it returns (`_execute_claimed`).
     - `WORKER_DRY_RUN=False` + user not flagged → release. The TS
       worker stays canonical for unflagged users until Phase 5.

Lease + settlement (migration 0032): a claim holds a lease that a
heartbeat task extends every `JOB_HEARTBEAT_SECONDS` while the executor
runs. Whatever happens, the job is settled exactly one way:
  - executor returns → `mark_job_done` / `mark_job_failed`, shielded so
    a shutdown cancel can't interrupt the write half-way;
  - an exception escapes the executor → job failed AND the task settled
    failed (`executor.settle_stranded_task`) so it can't strand;
  - the job is cancelled (shutdown grace ran out) → handed back
    (`jobs.hand_back_job`): its lease is expired on the spot so the next
    worker reclaims it immediately;
  - the process dies outright → the lease lapses and another worker
    reclaims it (or `_reap_expired` fails it once `max_attempts` is
    spent);
  - the heartbeat finds the claim gone (reclaimed underneath us), or
    the lease runs out while the DB is unreachable → the run stops at
    its next lease check (`lease.py`: every emit, step and tool call)
    and the job is abandoned unsettled — its new owner settles it.
A reclaimed job doesn't blindly re-run: `reclaim_decision` looks at the
task first (already settled? superseded by a later job? paused on the
user?) — see there.

Stopping:
  - `main.py`'s lifespan sets the `stop` event: the loop finishes the
    in-flight job (if any) and exits without claiming another.
  - If that takes longer than `SHUTDOWN_GRACE_SECONDS`, the lifespan
    cancels the task; the in-flight job is handed back (above).
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import time
from collections.abc import Awaitable, Callable
from typing import Any, Literal

import asyncpg
import structlog

from . import db, executor, feature_flag, jobs, store
from . import lease as lease_mod
from .jobs import ClaimedJob, JobTaskState
from .settings import Settings

logger = structlog.get_logger(__name__)

# Sleep is parameterised so tests can inject a fake clock without
# touching asyncio internals.
SleepFn = Callable[[float], Awaitable[None]]

# Upper bound on how long a settle / hand-back write may keep running
# after the surrounding task was cancelled.
_SHIELDED_WRITE_TIMEOUT_S = 5.0

_TERMINAL_TASK_STATUSES = ("done", "failed", "cancelled")


async def _default_sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


def _respond_payload_from_job(job: ClaimedJob) -> executor.RespondActionPayload | None:
    """Parse a `respond` job's payload into a typed RespondActionPayload.

    The TS route writes `{requestId, approved?, selection?, value?,
    uiAnswer?, args?}` into `task_jobs.payload`. Missing `requestId`
    is fatal (no way to find the pending tool call); the other fields
    are kind-specific and any subset may be set or none."""
    payload_raw = job.payload or {}
    request_id = payload_raw.get("requestId")
    if not isinstance(request_id, str) or not request_id:
        return None
    out = executor.RespondActionPayload(
        run_id=job.task_id,
        user_id=job.user_id,
        request_id=request_id,
    )
    approved_raw = payload_raw.get("approved")
    selection_raw = payload_raw.get("selection")
    value_raw = payload_raw.get("value")
    ui_answer_raw = payload_raw.get("uiAnswer")
    args_raw = payload_raw.get("args")
    # Frozen dataclass — clone with `dataclasses.replace` for each
    # optional field that's set. Explicit per-field replace keeps
    # mypy happy without a `**kwargs` cast.
    if isinstance(approved_raw, bool):
        out = dataclasses.replace(out, approved=approved_raw)
    if isinstance(selection_raw, list):
        out = dataclasses.replace(
            out,
            selection=[s for s in selection_raw if isinstance(s, str)],
        )
    if isinstance(value_raw, str):
        out = dataclasses.replace(out, value=value_raw)
    if isinstance(ui_answer_raw, dict):
        out = dataclasses.replace(out, ui_answer=ui_answer_raw)
    if isinstance(args_raw, dict):
        out = dataclasses.replace(out, args=args_raw)
    return out


async def run_poll_loop(
    settings: Settings,
    *,
    sleep: SleepFn = _default_sleep,
    stop_after_iterations: int | None = None,
    stop: asyncio.Event | None = None,
) -> int:
    """Drive the poll loop until cancelled or `stop` is set.

    `stop_after_iterations` exists only for tests — production calls
    leave it `None` so the loop runs forever. Returns the number of
    iterations completed (useful for the tests' invariants).

    `stop` is the graceful-shutdown signal: once set, the loop lets the
    current tick (and its in-flight job) finish, then returns instead
    of claiming again. An idle sleep is cut short.

    Steady-state behaviour:
      - No DB pool → tick is a no-op, just sleep. Lets the service
        boot in dev without `SUPABASE_DB_URL`.
      - Pool present, no job → log nothing (a job-empty log every
        tick would be noisy), sleep.
      - Job claimed → see the module docstring.
      - Claim raises → log error, sleep. We don't crash the loop on
        a transient error.
    """
    interval = settings.POLL_INTERVAL_SECONDS
    iterations = 0

    while stop is None or not stop.is_set():
        try:
            await _tick(settings)
        except asyncio.CancelledError:
            logger.info("poller.cancelled", iterations=iterations)
            raise
        except Exception as exc:
            # Loop must survive transient errors. Log with the
            # exception payload so monitoring catches it; sleep, retry.
            logger.error("poller.tick.failed", error=str(exc))

        iterations += 1
        if stop_after_iterations is not None and iterations >= stop_after_iterations:
            return iterations

        try:
            await _sleep_unless_stopped(sleep, interval, stop)
        except asyncio.CancelledError:
            logger.info("poller.cancelled", iterations=iterations)
            raise

    logger.info("poller.stopped", iterations=iterations)
    return iterations


async def _sleep_unless_stopped(
    sleep: SleepFn, interval: float, stop: asyncio.Event | None
) -> None:
    """`sleep(interval)`, returning early if `stop` gets set."""
    if stop is None:
        await sleep(interval)
        return
    if stop.is_set():
        return
    sleeper = asyncio.ensure_future(sleep(interval))
    stopper = asyncio.ensure_future(stop.wait())
    try:
        await asyncio.wait({sleeper, stopper}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        sleeper.cancel()
        stopper.cancel()


async def _tick(settings: Settings) -> None:
    """One poll iteration. Extracted so tests can drive it directly
    without juggling sleep timing."""
    if not db.has_pool():
        # Boot mode — no Postgres configured. The lifespan still
        # started us so the rest of the app stays consistent, but
        # there's nothing to poll.
        return

    pool = db.get_pool()
    live = not settings.WORKER_DRY_RUN
    if live:
        await _reap_expired(pool)

    # Dry-run is a passive observer: it only ever takes (and releases)
    # fresh `queued` jobs, never a dead worker's expired lease.
    # `claim_sent_at` anchors the local lease estimate (see `JobLease`).
    claim_sent_at = time.monotonic()
    job = await jobs.claim_next_job(
        pool,
        lease_seconds=settings.JOB_LEASE_SECONDS,
        reclaim_expired=live,
    )
    if job is None:
        return

    # Phase 1 contract: log every claim. The shape mirrors the TS
    # worker's structured logs so dashboards can union them.
    logger.info(
        "poller.claimed",
        job_id=job.id,
        task_id=job.task_id,
        user_id=job.user_id,
        action=job.action,
        attempts=job.attempts,
        reclaimed=job.reclaimed,
        payload_keys=sorted(job.payload.keys()) if job.payload else [],
    )

    if settings.WORKER_DRY_RUN:
        released = await jobs.release_job_to_queue(pool, job.id)
        logger.info(
            "poller.released",
            job_id=job.id,
            released=released,
            reason="dry_run",
        )
        return

    # Live mode. Per-user feature flag gates whether Python executes
    # this user's runs vs. releases for the TS worker. The flag is
    # `auth.users.raw_app_meta_data->>'agent_backend' == 'python'`
    # (app metadata — only the service role can write it); see
    # `feature_flag.py` for the contract.
    flagged = await feature_flag.is_user_flagged_to_python(pool, job.user_id)
    if not flagged:
        released = await jobs.release_job_to_queue(pool, job.id)
        logger.info(
            "poller.released",
            job_id=job.id,
            released=released,
            reason="user_not_flagged",
        )
        return

    # Phase 3b: `start`, `continue`, and `respond` all dispatch to
    # the Python executor. No other actions exist today.
    if job.action not in ("start", "continue", "respond"):
        released = await jobs.release_job_to_queue(pool, job.id)
        logger.info(
            "poller.released",
            job_id=job.id,
            released=released,
            reason="action_not_supported_yet",
            action=job.action,
        )
        return

    await _execute_claimed(pool, job, settings, claimed_at=claim_sent_at)


# --- execution + settlement -------------------------------------------------


@dataclasses.dataclass(frozen=True)
class _Settlement:
    """How to settle a job once its dispatch finished."""

    ok: bool
    error: str | None = None
    # An error escaped the executor, so the executor never settled the
    # task: fail it too (when nothing else will drive it), or it strands
    # `running` behind a failed job.
    settle_task: bool = False


async def _execute_claimed(
    pool: asyncpg.Pool,
    job: ClaimedJob,
    settings: Settings,
    *,
    claimed_at: float | None = None,
    clock: lease_mod.Clock = time.monotonic,
) -> None:
    """Run one claimed job under a heartbeated lease and settle it
    exactly once (see the module docstring).

    The lease is bound for the dispatch (`lease.bound`): once the
    heartbeat finds the claim gone, the run's next emit / step / tool
    call raises `LeaseLostError` and the job is abandoned — neither the
    job nor the task is settled, because the worker that reclaimed it
    owns both now."""
    job_lease = lease_mod.JobLease(
        job_id=job.id,
        lease_seconds=settings.JOB_LEASE_SECONDS,
        acquired_at=claimed_at,
        clock=clock,
    )
    heartbeat = asyncio.create_task(
        _heartbeat(pool, job, settings, job_lease, clock=clock),
        name=f"agent-py.heartbeat.{job.id}",
    )
    try:
        with lease_mod.bound(job_lease):
            settlement = await _dispatch(pool, job)
    except lease_mod.LeaseLostError as exc:
        heartbeat.cancel()
        logger.warning(
            "poller.job_abandoned_lease_lost",
            job_id=job.id,
            task_id=job.task_id,
            action=job.action,
            attempts=job.attempts,
            reason=exc.reason,
        )
        return
    except asyncio.CancelledError:
        # Shutdown grace ran out mid-run. Don't guess at an outcome —
        # hand the job back so the next worker reclaims it right away
        # and resumes from the task's persisted state. The task row is
        # left as-is (still live).
        heartbeat.cancel()
        logger.warning(
            "poller.job_interrupted",
            job_id=job.id,
            task_id=job.task_id,
            action=job.action,
        )
        await _shielded(_hand_back(pool, job))
        raise
    except Exception as exc:
        logger.error(
            "poller.dispatch_raised",
            job_id=job.id,
            task_id=job.task_id,
            action=job.action,
            error=str(exc),
        )
        settlement = _Settlement(ok=False, error=f"{type(exc).__name__}: {exc}", settle_task=True)
    finally:
        # Stop heartbeating before the settle write, or a late extend
        # would race it (and log a spurious lease loss).
        heartbeat.cancel()

    if job_lease.lost and settlement.settle_task:
        # The run finished (or failed) after its last lease check, but the
        # claim is gone: the job settle below is fenced and harmless, the
        # unfenced task settle is not — leave the task to its new owner.
        settlement = dataclasses.replace(settlement, settle_task=False)
    await _shielded(_settle_job(pool, job, settlement))


async def _dispatch(pool: asyncpg.Pool, job: ClaimedJob) -> _Settlement:
    """Gate + route one job to the executor. Returns how to settle it."""
    # Ownership gate. `task_jobs` RLS only checks `auth.uid() = user_id`
    # on insert, so a user can enqueue a job carrying their own
    # `user_id` but SOMEONE ELSE's `task_id`. Every executor write is
    # scoped by `job.user_id`, but refuse up front rather than run a
    # forged job against a task the job's user doesn't own.
    if not await store.is_task_owned_by(pool, task_id=job.task_id, user_id=job.user_id):
        logger.error(
            "poller.job_owner_mismatch",
            job_id=job.id,
            task_id=job.task_id,
            user_id=job.user_id,
            action=job.action,
        )
        return _Settlement(ok=False, error="task not owned by job user")

    action = job.action
    # Reclaimed-attempt flavours, see `reclaim_decision`.
    rerun_start = False
    resume_respond = False
    if job.reclaimed:
        state = await jobs.load_job_task_state(
            pool, task_id=job.task_id, user_id=job.user_id, job_id=job.id
        )
        if state is None:
            return _Settlement(ok=False, error="reclaimed job's task not found")
        decision, reason = reclaim_decision(job.action, state)
        logger.warning(
            "poller.reclaimed",
            job_id=job.id,
            task_id=job.task_id,
            action=job.action,
            attempts=job.attempts,
            task_status=state.task_status,
            decision=decision,
            reason=reason,
        )
        if decision == "skip":
            return _Settlement(ok=True)
        if decision == "continue" and job.action == "respond":
            # The dead attempt flipped paused → running; whether it also
            # persisted the user's answer is for the executor to find out
            # (`execute_respond(resume_interrupted=True)`).
            resume_respond = True
        elif decision == "continue":
            action = "continue"
        elif job.action == "start":
            rerun_start = True

    if action == "respond":
        respond_payload = _respond_payload_from_job(job)
        if respond_payload is None:
            logger.error(
                "poller.respond_invalid_payload",
                job_id=job.id,
                payload_keys=sorted(job.payload.keys()) if job.payload else [],
            )
            if not resume_respond:
                return _Settlement(ok=False, error="respond: invalid payload")
            # No answer to re-apply; resume from whatever was persisted.
            outcome = await executor.execute_continue(
                pool,
                executor.StartActionPayload(run_id=job.task_id, user_id=job.user_id),
                reclaimed=True,
            )
        elif resume_respond:
            outcome = await executor.execute_respond(pool, respond_payload, resume_interrupted=True)
        else:
            outcome = await executor.execute_respond(pool, respond_payload)
    elif action == "continue" and job.reclaimed:
        # Re-run of a chunk whose worker died: opens with a resume marker
        # (see `execute_continue`). A normal chunk-boundary `continue`
        # below emits none.
        outcome = await executor.execute_continue(
            pool,
            executor.StartActionPayload(run_id=job.task_id, user_id=job.user_id),
            reclaimed=True,
        )
    elif action == "continue":
        outcome = await executor.execute_continue(
            pool,
            executor.StartActionPayload(run_id=job.task_id, user_id=job.user_id),
        )
    elif rerun_start:
        outcome = await executor.execute_start(
            pool,
            executor.StartActionPayload(run_id=job.task_id, user_id=job.user_id),
            reclaimed=True,
        )
    else:
        outcome = await executor.execute_start(
            pool,
            executor.StartActionPayload(run_id=job.task_id, user_id=job.user_id),
        )

    if outcome.settled:
        logger.info("poller.executed", job_id=job.id, run_id=job.task_id, action=action)
        return _Settlement(ok=True)
    logger.error(
        "poller.execute_failed",
        job_id=job.id,
        run_id=job.task_id,
        error=outcome.error,
    )
    return _Settlement(ok=False, error=outcome.error or "unknown")


ReclaimAction = Literal["run", "continue", "skip"]


def reclaim_decision(action: str, state: JobTaskState) -> tuple[ReclaimAction, str]:
    """What to do with a job reclaimed from a dead worker, given its
    task's current state. Returns `(decision, reason)`:

      - `"run"` — execute the job's own action again;
      - `"continue"` — resume the run from its checkpoint instead;
      - `"skip"` — settle the job done without executing.

    The previous attempt may have died anywhere — before doing anything,
    mid-step, or after finishing the run but before settling the job —
    so the task (not the job) says how far it got:

      - task terminal → the run finished; nothing to do.
      - start/continue superseded by a later job for the task → the
        attempt got as far as yielding / pausing; the later job owns the
        run now. Re-running would fork it.
      - task paused → it is legitimately waiting: on the user (only the
        respond job may proceed, through the normal paused → running
        gate) or on its subagents (only the barrier's `continue`, once
        `pending_children` hit zero, may resume it).
      - task queued/running:
          * respond → the attempt had already flipped paused → running,
            so the respond gate must not run again: `"continue"` —
            unless another live job is already driving the run. The
            poller runs it as `execute_respond(resume_interrupted=True)`,
            which resumes from the checkpoint when the answer was
            persisted and re-applies the job's answer when it wasn't.
          * start/continue → re-run it. The emitter seeds past every seq
            already written, so new events never collide with the dead
            attempt's. The re-run goes through `reclaimed=True`
            (`execute_start` resumes from a checkpoint the dead attempt
            saved, else restarts from the initial one) and opens with a
            `status: running` marker carrying `resumedFromSeq` — the
            checkpoint's seq — so consumers drop the dead attempt's
            partial output written past it.
      Either way a side-effecting tool the dead attempt had started is
      never run again (its checkpointed execution record turns it into
      an "interrupted, outcome unknown" result — `tool_ledger`), and a
      checkpoint suspended on an unanswered gated call pauses the run
      again rather than resuming past it (`executor._run_chunk_inner`).
    """
    status = state.task_status
    if status in _TERMINAL_TASK_STATUSES:
        return "skip", "task_already_settled"
    if action in ("start", "continue") and state.superseded:
        return "skip", "superseded_by_later_job"
    if status == "paused":
        if action == "respond":
            return "run", "respond_to_paused_task"
        if action == "continue" and state.awaiting_children and state.pending_children <= 0:
            return "run", "fan_in_resume"
        return "skip", "task_paused"
    if action == "respond":
        if state.has_other_live_job:
            return "skip", "run_driven_by_another_job"
        return "continue", "resume_interrupted_respond"
    return "run", "rerun_interrupted"


async def _heartbeat(
    pool: asyncpg.Pool,
    job: ClaimedJob,
    settings: Settings,
    job_lease: lease_mod.JobLease,
    *,
    sleep: SleepFn = _default_sleep,
    clock: lease_mod.Clock = time.monotonic,
) -> None:
    """Extend the job's lease until cancelled. Clamped to a third of the
    lease so two consecutive misses still leave headroom.

    Two failure modes, handled differently:
      - the extend matched no row → the claim is gone (settled, reaped,
        or reclaimed by another worker after our lease lapsed): mark the
        lease lost so the run stops at its next check, and stop beating;
      - the extend raised (transient DB error) → retry next beat. Only
        if the lease's deadline passes without a successful extend is it
        marked lost — from then on another worker may reclaim the job.
    """
    lease_s = settings.JOB_LEASE_SECONDS
    interval = max(0.01, min(settings.JOB_HEARTBEAT_SECONDS, lease_s / 3))
    while not job_lease.lost:
        await sleep(interval)
        if job_lease.lost:
            return
        sent_at = clock()
        try:
            still_ours = await jobs.extend_lease(
                pool, job.id, attempts=job.attempts, lease_seconds=lease_s
            )
        except Exception as exc:
            if job_lease.expired():
                job_lease.mark_lost("heartbeat_failing_past_expiry")
                logger.error(
                    "poller.lease_expired_heartbeat_failing",
                    job_id=job.id,
                    task_id=job.task_id,
                    error=str(exc),
                )
                return
            logger.warning("poller.heartbeat_failed", job_id=job.id, error=str(exc))
            continue
        if not still_ours:
            job_lease.mark_lost("claim_taken_over")
            logger.warning("poller.lease_lost", job_id=job.id, task_id=job.task_id)
            return
        job_lease.renewed(sent_at=sent_at)


async def _settle_job(pool: asyncpg.Pool, job: ClaimedJob, settlement: _Settlement) -> None:
    """Write the job's terminal status (fenced on the claim's
    `attempts`), then — for an error that escaped the executor — the
    task's. Never raises: a failed write leaves the job `running`, its
    lease lapses, and the reclaim path re-examines it."""
    try:
        if settlement.ok:
            await jobs.mark_job_done(pool, job.id, attempts=job.attempts)
        else:
            await jobs.mark_job_failed(
                pool, job.id, error=settlement.error or "unknown", attempts=job.attempts
            )
    except Exception as exc:
        logger.error("poller.job_settle_failed", job_id=job.id, error=str(exc))
        return
    if settlement.settle_task:
        try:
            await executor.settle_stranded_task(
                pool,
                task_id=job.task_id,
                user_id=job.user_id,
                job_id=job.id,
                error=settlement.error or "Task failed unexpectedly.",
            )
        except Exception as exc:
            logger.error("poller.task_settle_failed", job_id=job.id, error=str(exc))


async def _hand_back(pool: asyncpg.Pool, job: ClaimedJob) -> None:
    try:
        handed_back = await jobs.hand_back_job(pool, job.id, attempts=job.attempts)
    except Exception as exc:
        # The lease still lapses on its own; another worker reclaims it.
        logger.error("poller.hand_back_failed", job_id=job.id, error=str(exc))
        return
    logger.info("poller.handed_back", job_id=job.id, handed_back=handed_back)


async def _reap_expired(pool: asyncpg.Pool) -> None:
    """Fail jobs whose lease ran out on their last attempt, and settle
    each one's task failed with a terminal event (unless it's paused,
    already settled, or driven by another live job). Never raises."""
    try:
        reaped = await jobs.reap_expired_jobs(pool)
    except Exception as exc:
        logger.error("poller.reap_failed", error=str(exc))
        return
    for job in reaped:
        logger.error(
            "poller.job_reaped",
            job_id=job.id,
            task_id=job.task_id,
            action=job.action,
            attempts=job.attempts,
        )
        try:
            await executor.settle_stranded_task(
                pool,
                task_id=job.task_id,
                user_id=job.user_id,
                job_id=job.id,
                error=(
                    "The worker running this task stopped responding "
                    f"({job.attempts} attempt(s)); giving up."
                ),
            )
        except Exception as exc:
            logger.error("poller.reap_settle_failed", job_id=job.id, error=str(exc))


async def _shielded(aw: Awaitable[Any]) -> None:
    """Await `aw` so a cancellation of the caller can't abort it
    half-way: on cancel, give the write up to `_SHIELDED_WRITE_TIMEOUT_S`
    to land, then propagate the cancellation."""
    inner = asyncio.ensure_future(aw)
    try:
        await asyncio.shield(inner)
    except asyncio.CancelledError:
        with contextlib.suppress(Exception):
            await asyncio.wait({inner}, timeout=_SHIELDED_WRITE_TIMEOUT_S)
        raise
