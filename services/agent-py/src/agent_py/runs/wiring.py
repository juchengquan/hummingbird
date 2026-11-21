"""The one place the runs API's services are built (the wiring seam).

`routers/runs.py` reads everything it needs from `RunServices`; the
lifespan (`main.py`) builds it once the DB pool exists and runs its
maintenance loop. Swapping an implementation means changing this file
only. Each stand-in for another wave-3b workstream is marked:

* `# WIRE(3b-A)` — event logs (Postgres `task_events` log, TTL'd memory
  log), the AG-UI encoder, `stream_run_events`, compaction (post-settle);
* `# WIRE(3b-C)` — the harness adapter over today's agent loop (and,
  in `run_input.py`, AG-UI → model-input conversion for background
  checkpoints).

**Stores, by owner** (`repo_for` / `log_for`):

| caller                           | runs live in            | event log        |
|----------------------------------|-------------------------|------------------|
| signed in, `SUPABASE_DB_URL` set | Postgres (`tasks`, 0041) | Postgres log     |
| signed in, no database           | memory (TTL)            | memory log       |
| anonymous                        | memory (TTL)            | memory log       |

Without a database, signed-in callers keep interactive runs — chat keeps
working on a DB-less deployment, as `/v1/chat` does — but they are not
persisted (lost on restart, dropped `RUNS_MEMORY_TTL_SECONDS` after they
end, never visible to another replica) and background runs answer
`503 unavailable` ("Supabase is not configured."), as the schedules
routes do.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

import asyncpg
import structlog

from .. import db
from ..settings import Settings, get_settings
from .access import AnonymousLimits
from .driver import PostSettleHook, RunDriver, reap_interactive_runs
from .encoder import AgUiEncoder, AgUiEncoderFactory, RecordingEncoder
from .event_log import InMemoryRunEventLog, RunEventLog
from .harness import HarnessAdapter
from .model import RunCursor, RunOwner, RunRecord
from .placeholders import UnwiredHarness, noop_post_settle, placeholder_stream_run_events
from .repository import RunRepository
from .repository_memory import MemoryRunRepository
from .repository_pg import PgRunRepository
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
    """Type of 3b-A's `stream.stream_run_events` (each item = one
    complete SSE frame)."""

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
            # WIRE(3b-A): the TTL'd memory log drops its own entries.
            with contextlib.suppress(Exception):
                await self.memory_log.purge(run_id)


def build_run_services(settings: Settings, pool: asyncpg.Pool | None) -> RunServices:
    # WIRE(3b-A): compaction scheduling (`compaction.py`) as the hook.
    post_settle: PostSettleHook = noop_post_settle
    # WIRE(3b-C): the adapter wrapping today's agent loop, in place of
    # `UnwiredHarness` (the stub stays for RUNS_STUB_HARNESS).
    harness: HarnessAdapter = StubHarness() if settings.RUNS_STUB_HARNESS else UnwiredHarness()
    return RunServices(
        settings=settings,
        pg_repo=None if pool is None else PgRunRepository(pool),
        # WIRE(3b-A): `event_log_pg.PgRunEventLog(pool)` over task_events.
        pg_log=None if pool is None else InMemoryRunEventLog(),
        memory_repo=MemoryRunRepository(
            ttl_seconds=settings.RUNS_MEMORY_TTL_SECONDS,
            max_runs=settings.RUNS_MEMORY_MAX_RUNS,
        ),
        # WIRE(3b-A): `event_log_memory` (TTL'd, Q16).
        memory_log=InMemoryRunEventLog(),
        # WIRE(3b-A): the real `AgUiEncoder` factory (`agui_encoder.py`).
        encoder_factory=RecordingEncoder,
        harness=harness,
        # WIRE(3b-A): `stream.stream_run_events`.
        stream=placeholder_stream_run_events,
        driver=RunDriver(
            lease_seconds=settings.RUNS_LEASE_SECONDS,
            heartbeat_seconds=settings.RUNS_HEARTBEAT_SECONDS,
            post_settle=post_settle,
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


async def run_maintenance_loop(services: RunServices, *, stop: asyncio.Event) -> None:
    """`services.maintain()` every `RUNS_REAPER_INTERVAL_SECONDS` until
    `stop` is set."""
    interval = max(0.05, services.settings.RUNS_REAPER_INTERVAL_SECONDS)
    while not stop.is_set():
        try:
            await services.maintain()
        except Exception as exc:  # pragma: no cover — maintain() logs its own
            logger.warning("runs.maintenance.failed", error=str(exc))
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval)
