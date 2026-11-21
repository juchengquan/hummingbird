"""In-memory `RunRepository` for runs that are not persisted (Q16).

Holds anonymous runs, and signed-in interactive runs when agent-py has
no database (`SUPABASE_DB_URL` unset). It is the 3a reference fake
(`InMemoryRunRepository`, same rules as 0041's `create_run` and the
transitions) plus what a long-lived process needs:

* a **TTL**: a run is dropped `ttl_seconds` after it ended (~15 min),
  after which every operation on it answers 404 — `sweep()` does it and
  returns the dropped ids so the caller can drop their event logs too;
* a **capacity cap**, so memory cannot grow without bound
  (`MemoryStoreFull`);
* the **client key** (IP) each anonymous run was started from, for the
  per-IP concurrency limit;
* `contains(run_id)` — run ids are global across stores, so a create
  elsewhere can refuse an id taken here (`409 run_id_conflict`).

Background runs need the database: `create` refuses them.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from .model import RunOwner
from .repository import CreateResult, InMemoryRunRepository, RunSpec

__all__ = ["MemoryRunRepository", "MemoryStoreFull"]


class MemoryStoreFull(Exception):
    """The in-memory store holds `max_runs` runs already (API: 503)."""


def _now() -> datetime:
    return datetime.now(UTC)


class MemoryRunRepository(InMemoryRunRepository):
    def __init__(
        self,
        *,
        ttl_seconds: float,
        max_runs: int,
        clock: Callable[[], datetime] = _now,
    ) -> None:
        super().__init__(conversations={}, clock=clock)
        self._ttl = timedelta(seconds=max(0.0, ttl_seconds))
        self._max_runs = max(1, max_runs)
        self._client_keys: dict[str, str] = {}

    def contains(self, run_id: str) -> bool:
        return run_id in self._rows

    def __len__(self) -> int:
        return len(self._rows)

    async def create(self, owner: RunOwner, spec: RunSpec) -> CreateResult:
        if spec.mode == "background":
            raise ValueError("background runs need the database")
        if spec.run_id not in self._rows and len(self._rows) >= self._max_runs:
            raise MemoryStoreFull()
        return await super().create(owner, spec)

    def tag_client(self, run_id: str, client_key: str) -> None:
        """Remember which client (IP) started `run_id`."""
        if run_id in self._rows:
            self._client_keys[run_id] = client_key

    def live_runs_for_client(self, client_key: str) -> int:
        """Live anonymous runs started by `client_key`."""
        return sum(
            1
            for run_id, key in self._client_keys.items()
            if key == client_key
            and (row := self._rows.get(run_id)) is not None
            and row.record.owner.is_anonymous
            and row.record.is_live
        )

    def sweep(self) -> list[str]:
        """Drop every run that ended more than the TTL ago; returns their
        ids. Live runs are never dropped (the reaper ends abandoned ones
        first)."""
        cutoff = self._clock() - self._ttl
        expired = [
            run_id
            for run_id, row in self._rows.items()
            if not row.record.is_live
            and row.record.finished_at is not None
            and row.record.finished_at <= cutoff
        ]
        for run_id in expired:
            del self._rows[run_id]
            self._client_keys.pop(run_id, None)
        return expired
