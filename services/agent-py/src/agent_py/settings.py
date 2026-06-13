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

    SUPABASE_SERVICE_ROLE_KEY: str = ""
    """Service-role key for Supabase Storage REST API access (Phase 3d-2+).
    When set together with `SUPABASE_URL`, generated images get mirrored
    into `user-files/<user_id>/generated/...` and the model receives a
    long-lived signed URL instead of the short-lived Minimax URL. Bypasses
    RLS (same key Next.js uses for share links); per-user path scoping
    comes from the trusted `payload.user_id` we stamp into the path."""

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

    # --- Web search -------------------------------------------------------
    TAVILY_API_KEY: str = ""
    """Tavily web-search API key — Phase 3c-1. When set the `webSearch`
    tool registers itself in the default tool registry; otherwise the
    tool is omitted entirely (model never sees it). Mirrors the TS
    side's `TAVILY_API_KEY` env var so a single `.env` works for both."""

    # --- MCP --------------------------------------------------------------
    MCP_ENCRYPTION_KEY: str = ""
    """Symmetric key for decrypting cloud-mode MCP server credentials
    via the `mcp_get_decrypted_credentials` SECURITY DEFINER Postgres
    function (defined in `0005_mcp.sql`). Same env var the Next.js
    side reads. Empty (or shorter than 16 chars) → the Python service
    treats every cloud-mode MCP cred as if the row didn't exist, so
    those servers are silently skipped — matches the TS path's
    `getMcpEncryptionKey()` guard."""

    # --- Image generation -------------------------------------------------
    MINIMAX_CN_API_KEY: str = ""
    """Minimax API key — shared between the chat-bypass (TS side) and the
    Python service's `generateImage` tool. Empty = the `generateImage` tool
    is omitted from the registry; the model still sees the rest of the tool
    set. Same env var the TS side reads, so a single `.env` covers both."""

    MINIMAX_CN_BASE_URL: str = ""
    """Optional Minimax host override. When set, the `generateImage` tool
    derives its endpoint as `<origin>/v1/image_generation` (chat and image
    live under different paths on the same host). Empty falls back to the
    international endpoint `https://api.minimaxi.com/v1/image_generation`.
    Same env var the TS side reads."""

    # --- Citation verification --------------------------------------------
    VERIFY_MODEL: str = ""
    """Anthropic model id for the post-run citation verifier on research
    runs (`agent_py.verify`). Empty = verification is OFF (no extra model
    call). Set to a CHEAP model — ideally cheaper than the answerer, since
    cross-checking with a weaker/different model is the intent. Uses the
    same `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` client as the run, so
    it's a no-op without a key regardless. See
    `docs/PLAN-citation-verifiability.md`."""

    # --- Service identity -------------------------------------------------
    SERVICE_NAME: str = "agent-py"
    SERVICE_PORT: int = 8000


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide singleton. `lru_cache` keeps lookups cheap inside hot
    request paths without paying for a `Depends` injection on every call."""
    return Settings()
