"""Job-lease guard — stop a run cooperatively once its claim is gone.

The poller holds a lease on every job it executes (`task_jobs.
lease_expires_at`, migration 0032) and heartbeats it forward. When the
heartbeat finds the claim gone — the fenced `extend_lease` matched no
row because another worker reclaimed the job, or the lease ran out
while the DB was unreachable — this worker no longer owns the run. It
must not keep emitting events, running tools or settling the task:
the new owner is doing all of that.

`JobLease` is the shared flag between the heartbeat (writer) and the
run (reader). The poller binds it for the duration of a dispatch
(`bound`); the executor and the tool loop call `check_current()` at
every point where the run would touch shared state — each event emit,
each step, right before a tool executes, before the post-loop
checkpoint / settle writes. A lost lease raises `LeaseLostError`, which
unwinds the run without any further writes.

Two ways to lose it, deliberately distinguished:
  - the heartbeat's update matched 0 rows → lost for sure, now;
  - the heartbeat raised (transient DB error) → NOT lost; the next beat
    retries. Only once the lease's own deadline has passed (measured
    locally, from the moment the last successful extend was *sent*) is
    the claim treated as lost, since another worker may now reclaim it.

A contextvar rather than a parameter: the check sites span the runner,
the executor and every tool call path, and threading a guard through
`MakeStepFn` / `AnthropicStepConfig` / the tool registry would touch
every test fake for no behavioural gain. Outside a bound lease (tests,
the reaper, scripts) `check_current()` is a no-op.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar

Clock = Callable[[], float]


class LeaseLostError(BaseException):
    """The job's lease is gone; this worker must stop the run now.

    A `BaseException` (like `asyncio.CancelledError`) on purpose: the
    tool loop and the executor's failure paths catch `Exception` to turn
    errors into `step_error` events or a `result: failed` settle — both
    of which are exactly the writes a worker without the lease must not
    make. Only the poller catches it."""

    def __init__(self, job_id: str, reason: str) -> None:
        super().__init__(f"lease lost for job {job_id}: {reason}")
        self.job_id = job_id
        self.reason = reason


class JobLease:
    """Lease state for one claimed job, shared by heartbeat and run."""

    def __init__(
        self,
        *,
        job_id: str,
        lease_seconds: float,
        acquired_at: float | None = None,
        clock: Clock = time.monotonic,
    ) -> None:
        """`acquired_at` is the local clock reading taken just BEFORE the
        claim was sent: the DB stamped `now() + lease` no earlier than
        that, so `acquired_at + lease` never overestimates the deadline."""
        self.job_id = job_id
        self._lease_seconds = float(lease_seconds)
        self._clock = clock
        start = clock() if acquired_at is None else acquired_at
        self._valid_until = start + self._lease_seconds
        self._lost_reason: str | None = None

    @property
    def lost(self) -> bool:
        return self._lost_reason is not None

    @property
    def lost_reason(self) -> str | None:
        return self._lost_reason

    def expired(self) -> bool:
        """True once the lease's (locally estimated) deadline passed."""
        return self._clock() >= self._valid_until

    def renewed(self, *, sent_at: float) -> None:
        """A heartbeat extend succeeded. `sent_at` is the clock reading
        taken before the extend was sent (conservative, see __init__)."""
        if self.lost:
            return
        self._valid_until = max(self._valid_until, sent_at + self._lease_seconds)

    def mark_lost(self, reason: str) -> None:
        """Latch the lease as lost. Irreversible — once the run has been
        told to stop, a later successful extend doesn't restart it."""
        if self._lost_reason is None:
            self._lost_reason = reason

    def check(self) -> None:
        """Raise `LeaseLostError` if the lease is lost or has expired."""
        if self._lost_reason is None and self.expired():
            self.mark_lost("lease_expired")
        if self._lost_reason is not None:
            raise LeaseLostError(self.job_id, self._lost_reason)


_current: ContextVar[JobLease | None] = ContextVar("agent_py_job_lease", default=None)


@contextmanager
def bound(lease: JobLease) -> Iterator[JobLease]:
    """Make `lease` the current one for the enclosed run (and any task
    it spawns — contextvars are copied into child tasks)."""
    token = _current.set(lease)
    try:
        yield lease
    finally:
        _current.reset(token)


def current() -> JobLease | None:
    return _current.get()


def check_current() -> None:
    """`check()` the bound lease; no-op when none is bound."""
    lease = _current.get()
    if lease is not None:
        lease.check()
