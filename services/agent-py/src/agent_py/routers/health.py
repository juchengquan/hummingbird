"""Liveness + readiness probes. Public (no JWT) — Kubernetes /
Docker / Cloudflare health checks hit these without an Authorization
header.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import __version__, db, poller, scheduler
from ..settings import Settings, get_settings

router = APIRouter(tags=["meta"])


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str


class ReadinessChecks(BaseModel):
    supabase_url_configured: bool
    supabase_db_configured: bool
    jwt_secret_configured: bool
    db_pool_open: bool
    # None when no poll loop was started (no `SUPABASE_DB_URL`); False
    # when it was started and has died — nothing executes tasks then.
    poller_alive: bool | None = None
    # Seconds since the loop last finished a tick (None before the
    # first). A tick executing a job lasts as long as that job's chunk.
    poller_last_tick_age_seconds: float | None = None
    # Same pair for the schedule dispatcher loop (`SCHEDULER_ENABLED`):
    # None when it isn't running in this process.
    scheduler_alive: bool | None = None
    scheduler_last_tick_age_seconds: float | None = None


class ReadinessResponse(BaseModel):
    status: str
    checks: ReadinessChecks


@router.get("/healthz", response_model=HealthResponse)
def healthz(
    settings: Annotated[Settings, Depends(get_settings)],
) -> HealthResponse:
    """Liveness probe — returns 200 as long as the process is up.

    Does NOT depend on Supabase, the model gateway, or any other
    external service. A failing /healthz means restart the container;
    a failing /readyz means *don't route traffic yet* but the process
    might recover on its own.
    """
    return HealthResponse(status="ok", service=settings.SERVICE_NAME, version=__version__)


@router.get("/readyz", response_model=ReadinessResponse)
def readyz(
    settings: Annotated[Settings, Depends(get_settings)],
) -> ReadinessResponse:
    """Readiness probe — reports configured dependencies.

    Phase 0 only reported config presence; Phase 1 additionally
    reports whether the Postgres pool is open (which is the closest
    we get to "Postgres reachable" without a per-request `SELECT 1`).
    Phase 2+ may add a `SELECT 1` if we see false-positive ready.

    Also reports the task poller's and the schedule dispatcher's
    liveness: `status` is `degraded` when either loop was started and has
    since died (the HTTP API still works, but no background task — or no
    scheduled fire — will run).
    """
    alive, tick_age = poller.liveness()
    sched_alive, sched_tick_age = scheduler.liveness()
    return ReadinessResponse(
        status="degraded" if alive is False or sched_alive is False else "ok",
        checks=ReadinessChecks(
            supabase_url_configured=bool(settings.SUPABASE_URL),
            supabase_db_configured=bool(settings.SUPABASE_DB_URL),
            jwt_secret_configured=bool(settings.SUPABASE_JWT_SECRET),
            db_pool_open=db.has_pool(),
            poller_alive=alive,
            poller_last_tick_age_seconds=None if tick_age is None else round(tick_age, 1),
            scheduler_alive=sched_alive,
            scheduler_last_tick_age_seconds=None
            if sched_tick_age is None
            else round(sched_tick_age, 1),
        ),
    )
