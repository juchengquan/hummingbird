"""The one place the runs API's services are built (the wiring seam).

`routers/runs.py` reads everything it needs from `RunServices`; the
lifespan (`main.py`) builds it once the DB pool exists and runs its
maintenance loop. Swapping an implementation means changing this file
only. What is wired:

* event logs — `PgRunEventLog` over `task_events` (signed-in runs, when
  a pool exists) and the TTL'd `MemoryRunEventLog` (anonymous runs, and
  signed-in runs without a database); one instance of each per process,
  shared by the driver and every stream;
* the AG-UI encoder (`agui_encoder.agui_encoder_factory`) and the stream
  (`stream.stream_run_events`);
* the harness — `native_harness.build_native_harness` (today's agent
  loop), or the model-free `StubHarness` under `RUNS_STUB_HARNESS=true`
  (the conformance suite);
* maintenance — `maintain()` reaps lapsed interactive runs and drops
  expired in-memory runs + logs every `RUNS_REAPER_INTERVAL_SECONDS`;
  `retention_sweep` (compaction + purge, `compaction.py`) runs every
  `SWEEP_INTERVAL` (10 min) when a pool exists. Compaction is
  time-based (24 h after a run ends), so nothing runs post-settle.

**Stores, by owner** (`repo_for` / `log_for`):

| caller                           | runs live in            | event log        |
|----------------------------------|-------------------------|------------------|
| signed in, `SUPABASE_DB_URL` set | Postgres (`tasks`, 0041) | Postgres log     |
| signed in, an ephemeral run      | memory (TTL)            | memory log       |
| signed in, no database           | memory (TTL)            | memory log       |
| anonymous                        | memory (TTL)            | memory log       |

An **ephemeral** run (`forwardedProps.ephemeral`, Q136 — the Explain
popover, whose temporary thread no conversation owns, so a `tasks` row of
it would never be deleted) is kept in memory like an anonymous run while
still being the signed-in user's: their bearer reads and cancels it
(`stores_of_run` finds it there), their start limits apply, it is never
listed. `stores_for(owner, ephemeral=…)` picks a new run's store.

Without a database, signed-in callers keep interactive runs — chat keeps
working on a DB-less deployment — but they are not
persisted (lost on restart, dropped `RUNS_MEMORY_TTL_SECONDS` after they
end, never visible to another replica) and background runs answer
`503 unavailable` ("Supabase is not configured."), as the schedules
routes do.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

import asyncpg
import structlog

from .. import db
from ..settings import Settings, get_settings
from .access import AnonymousLimits
from .agui_encoder import agui_encoder_factory
from .compaction import SWEEP_INTERVAL, retention_sweep
from .driver import RunDriver, reap_interactive_runs
from .encoder import AgUiEncoder, AgUiEncoderFactory
from .event_log import RunEventLog
from .event_log_memory import MemoryRunEventLog
from .event_log_pg import PgRunEventLog
from .harness import HarnessAdapter
from .model import RunCursor, RunOwner, RunRecord
from .native_harness import build_native_harness
from .repository import RunRepository
from .repository_memory import MemoryRunRepository
from .repository_pg import PgRunRepository
from .stream import stream_run_events
from .stub_harness import StubHarness

__all__ = [
    "RunServices",
    "StreamRunEvents",
    "build_run_services",
    "get_run_services",
    "reset_run_services",
    "run_maintenance_loop",
]

logger = structlog.get_logger(__name__)


class StreamRunEvents(Protocol):
    """Type of `stream.stream_run_events` (each item = one complete SSE
    frame; the first `anext()` raises `CursorOutOfRange` / `LookupError`
    before anything is sent)."""

    def __call__(
        self,
        *,
        run_id: str,
        after: RunCursor | None,
        log: RunEventLog,
        encoder: AgUiEncoder,
        load_run: Callable[[], Awaitable[RunRecord | None]],
    ) -> AsyncIterator[str]: ...


@dataclass
class RunServices:
    settings: Settings
    pool: asyncpg.Pool | None
    """The DB pool the Postgres store and log use (retention sweeps)."""
    pg_repo: PgRunRepository | None
    """Signed-in runs when the database is configured; None otherwise."""
    pg_log: RunEventLog | None
    memory_repo: MemoryRunRepository
    memory_log: RunEventLog
    encoder_factory: AgUiEncoderFactory
    harness: HarnessAdapter
    stream: StreamRunEvents
    driver: RunDriver
    limits: AnonymousLimits

    @property
    def has_db(self) -> bool:
        return self.pg_repo is not None

    def repo_for(self, owner: RunOwner) -> RunRepository:
        if owner.user_id is not None and self.pg_repo is not None:
            return self.pg_repo
        return self.memory_repo

    def log_for(self, owner: RunOwner) -> RunEventLog:
        if owner.user_id is not None and self.pg_log is not None:
            return self.pg_log
        return self.memory_log

    def stores_for(
        self, owner: RunOwner, *, ephemeral: bool = False
    ) -> tuple[RunRepository, RunEventLog]:
        """Where a new run of `owner` lives: memory for an ephemeral run
        (Q136), else `repo_for` / `log_for`."""
        if ephemeral:
            return self.memory_repo, self.memory_log
        return self.repo_for(owner), self.log_for(owner)

    def stores_of_run(self, owner: RunOwner, run_id: str) -> tuple[RunRepository, RunEventLog]:
        """Where `owner`'s existing run `run_id` lives: a signed-in
        caller's ephemeral run is in memory; everything else where
        `repo_for` / `log_for` put it."""
        if owner.user_id is not None and self.memory_repo.holds(owner, run_id):
            return self.memory_repo, self.memory_log
        return self.repo_for(owner), self.log_for(owner)

    async def run_id_taken_elsewhere(self, owner: RunOwner, run_id: str) -> bool:
        """Whether `run_id` exists in a store other than the owner's — run
        ids are global, so it is a `409 run_id_conflict` there too."""
        if self.repo_for(owner) is self.memory_repo:
            return self.pg_repo is not None and await self.pg_repo.exists(run_id)
        return self.memory_repo.contains(run_id)

    async def maintain(self) -> None:
        """One maintenance pass: reap interactive runs whose lease lapsed
        (both stores) and drop in-memory runs past their TTL."""
        if self.pg_repo is not None and self.pg_log is not None:
            try:
                await reap_interactive_runs(self.pg_repo, self.pg_log, driver=self.driver)
            except Exception as exc:
                logger.warning("runs.maintenance.reap_pg_failed", error=str(exc))
        try:
            await reap_interactive_runs(self.memory_repo, self.memory_log, driver=self.driver)
        except Exception as exc:  # pragma: no cover — memory store
            logger.warning("runs.maintenance.reap_memory_failed", error=str(exc))
        for run_id in self.memory_repo.sweep():
            # The run row is gone: drop its log now rather than at the
            # log's own TTL (both are ~15 min after the run ended).
            with contextlib.suppress(Exception):
                await self.memory_log.purge(run_id)
        if isinstance(self.memory_log, MemoryRunEventLog):
            self.memory_log.sweep()

    async def sweep_retention(self) -> None:
        """Compact + purge the Postgres logs that are due (`compaction.py`).
        No-op without a pool."""
        if self.pool is None or self.pg_log is None:
            return
        try:
            await retention_sweep(self.pool, self.pg_log)
        except Exception as exc:
            logger.warning("runs.maintenance.retention_failed", error=str(exc))


def build_run_services(
    settings: Settings,
    pool: asyncpg.Pool | None,
    *,
    harness: HarnessAdapter | None = None,
) -> RunServices:
    """`harness` overrides the configured one (tests inject a native
    harness over a fake model client)."""
    if harness is None:
        harness = StubHarness() if settings.RUNS_STUB_HARNESS else build_native_harness(settings)
    memory_ttl = max(0.0, settings.RUNS_MEMORY_TTL_SECONDS)
    return RunServices(
        settings=settings,
        pool=pool,
        pg_repo=None if pool is None else PgRunRepository(pool),
        pg_log=None if pool is None else PgRunEventLog(pool),
        memory_repo=MemoryRunRepository(
            ttl_seconds=settings.RUNS_MEMORY_TTL_SECONDS,
            max_runs=settings.RUNS_MEMORY_MAX_RUNS,
        ),
        memory_log=MemoryRunEventLog(ttl=memory_ttl),
        encoder_factory=agui_encoder_factory,
        harness=harness,
        stream=stream_run_events,
        driver=RunDriver(
            lease_seconds=settings.RUNS_LEASE_SECONDS,
            heartbeat_seconds=settings.RUNS_HEARTBEAT_SECONDS,
        ),
        limits=AnonymousLimits.from_settings(settings),
    )


_services: RunServices | None = None


def get_run_services() -> RunServices:
    """The process's services (FastAPI dependency; tests override it).
    Built on first use, with the DB pool if `db` has one by then — the
    lifespan calls this right after opening the pool."""
    global _services
    if _services is None:
        _services = build_run_services(get_settings(), db.get_pool() if db.has_pool() else None)
    return _services


def reset_run_services() -> None:
    """Drop the singleton (lifespan shutdown, tests)."""
    global _services
    _services = None


async def run_maintenance_loop(
    services: RunServices,
    *,
    stop: asyncio.Event,
    retention_interval: float = SWEEP_INTERVAL.total_seconds(),
) -> None:
    """`services.maintain()` every `RUNS_REAPER_INTERVAL_SECONDS`, and
    `services.sweep_retention()` every `retention_interval` (10 min) when
    a pool exists, until `stop` is set. Several processes may run it
    (the reaper skips locked rows; compaction is idempotent)."""
    interval = max(0.05, services.settings.RUNS_REAPER_INTERVAL_SECONDS)
    swept_at: float | None = None
    while not stop.is_set():
        try:
            await services.maintain()
        except Exception as exc:  # pragma: no cover — maintain() logs its own
            logger.warning("runs.maintenance.failed", error=str(exc))
        now = time.monotonic()
        if services.pool is not None and (swept_at is None or now - swept_at >= retention_interval):
            swept_at = now
            await services.sweep_retention()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval)
