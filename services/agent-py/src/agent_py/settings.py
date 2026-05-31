"""Process-wide settings loaded from environment.

Kept deliberately small in Phase 0 — the only settings that matter at this
stage are the Supabase JWT secret (needed to verify incoming tokens) and the
Supabase URL (used by /readyz to confirm the data layer is reachable).
Phase 1 will add the service-role key, polling interval, and runtime mode.

Mirrors the env vars already documented in the repo's top-level `.env.example`
so a single `.env` works for both the Next.js app and this service.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Service configuration.

    `SUPABASE_JWT_SECRET` is required for any auth-protected endpoint; without
    it the JWT middleware refuses every request. Set it to the JWT secret
    listed under your Supabase project's API settings (the same value Next.js
    would use if it verified JWTs directly).
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # --- Supabase ---------------------------------------------------------
    SUPABASE_URL: str = ""
    """Used by /readyz to confirm the data layer is reachable. Empty in dev
    is fine; /readyz will just report `supabase: not configured`."""

    SUPABASE_JWT_SECRET: str = ""
    """Required for auth-protected endpoints. When empty, JWT middleware
    refuses every request with 503."""

    SUPABASE_DB_URL: str = ""
    """Direct Postgres connection string (`postgresql://...`). Required for
    the Phase 1+ poll loop — when empty the poller still starts but no-ops
    on every tick (no pool, nothing to claim). Use the *direct* connection,
    NOT the transaction pooler — `FOR UPDATE SKIP LOCKED` needs an open
    transaction which the pooler doesn't expose."""

    # --- Worker -----------------------------------------------------------
    WORKER_DRY_RUN: bool = True
    """Phase 1 default: claim jobs, log them, release back to the queue.
    The TS worker picks them up. Flip to False in Phase 2+ when the
    executor branch lands. Until then, a False here logs an error and
    still releases so we never silently drop work."""

    POLL_INTERVAL_SECONDS: float = 5.0
    """Seconds between claim attempts. Five matches a healthy idle rate —
    fast enough that a real Phase 4+ workload would feel responsive, slow
    enough that the dry-run replica isn't fighting the TS worker."""

    # --- Model providers --------------------------------------------------
    ANTHROPIC_API_KEY: str = ""
    """Anthropic API key — Phase 2b enables real model streaming when set.
    Empty falls back to the Phase 2a stub step fn so the executor stays
    runnable in development without a live key."""

    ANTHROPIC_BASE_URL: str = ""
    """Optional override for the Anthropic API base URL. Empty = SDK default
    (https://api.anthropic.com). Set to point the SDK at an Anthropic-
    compatible endpoint — proxy, self-hosted gateway, or a region-specific
    upstream (e.g. Minimax's `/anthropic/v1` host). Mirrors the TS side's
    `MINIMAX_CN_BASE_URL` override pattern. Has no effect when
    `ANTHROPIC_API_KEY` is empty (the stub step fn doesn't reach a network)."""

    # --- Service identity -------------------------------------------------
    SERVICE_NAME: str = "agent-py"
    SERVICE_PORT: int = 8000


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide singleton. `lru_cache` keeps lookups cheap inside hot
    request paths without paying for a `Depends` injection on every call."""
    return Settings()
