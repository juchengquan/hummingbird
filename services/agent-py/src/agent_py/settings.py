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

    # --- Service identity -------------------------------------------------
    SERVICE_NAME: str = "agent-py"
    SERVICE_PORT: int = 8000


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide singleton. `lru_cache` keeps lookups cheap inside hot
    request paths without paying for a `Depends` injection on every call."""
    return Settings()
