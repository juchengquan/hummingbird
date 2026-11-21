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

DEFAULT_AGENT_MODEL = "anthropic/claude-haiku-4.5"
"""Service default model (catalog id) when `AGENT_DEFAULT_MODEL` is unset."""


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

    SUPABASE_JWT_AUDIENCE: str = "authenticated"
    """Required `aud` claim on incoming user JWTs. Supabase stamps
    `authenticated` on every signed-in user's access token; override only
    if the project customised its JWT template."""

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

    JOB_LEASE_SECONDS: float = 120.0
    """Lease a claim holds on a `task_jobs` row (`lease_expires_at`,
    migration 0032). While the job runs the poller heartbeats it forward;
    if the worker dies the lease lapses and another worker reclaims the
    job (or reaps it as failed once `max_attempts` is spent). Must
    comfortably exceed `JOB_HEARTBEAT_SECONDS` — a heartbeat is clamped
    to at most a third of the lease so two can miss before expiry."""

    JOB_HEARTBEAT_SECONDS: float = 30.0
    """How often an executing job extends its lease."""

    SHUTDOWN_GRACE_SECONDS: float = 8.0
    """On shutdown, how long the in-flight job may keep running before
    it's cancelled and handed back to the queue (lease expired on the
    spot so the next worker resumes it). Kept under Docker's default
    10 s stop timeout; raise both together (`stop_grace_period`) to let
    more jobs finish in place."""

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

    # --- Model allowlist --------------------------------------------------
    MODELS_CONFIG_PATH: str = ""
    """Path to the shared model catalog (`config/models.json`). Its
    `anthropic/*` entries are the only model ids the service accepts
    (`agent_py.model_allowlist`). Empty = search upward from the package
    for `config/models.json` (the repo root in a checkout, `/app` in the
    Docker image). A missing / invalid file fails boot."""

    AGENT_DEFAULT_MODEL: str = DEFAULT_AGENT_MODEL
    """Catalog id of the model used when a request doesn't name one
    (`/v1/summarize`) and for the follow-up-suggestion chips. Must be an
    `anthropic/*` entry of `config/models.json` — checked at boot. Same
    name + default as agent-ts; empty → the default."""

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

    VERIFY_PROVIDER: str = "anthropic"
    """Verifier provider family: "anthropic" | "google". Default
    "anthropic" preserves the shipped same-family behaviour. Set to
    "google" to cross-check the answer with a different model family
    (needs `GOOGLE_API_KEY`/`GEMINI_API_KEY` + the optional
    `google-generativeai` SDK; falls back to Anthropic with a one-shot
    warning if either is missing). Cross-family is stronger because a
    model is a poor judge of its own output. See
    `docs/PLAN-citation-verifiability.md` open question #2."""

    # --- Embeddings (`/v1/embed`) ----------------------------------------
    # Same env vars, precedence and defaults as the Next.js provider
    # (`lib/server/embeddings/provider.ts`), so one `.env` configures both.
    EMBEDDINGS_BASE_URL: str = ""
    """OpenAI-compatible embedder base URL (`<base>/embeddings` is called),
    e.g. `http://localhost:11434/v1`. Wins over `OLLAMA_BASE_URL`. Neither
    set → embedding is off and `/v1/embed` answers `skipped /
    not_configured`."""

    EMBEDDINGS_API_KEY: str = ""
    """Bearer key for `EMBEDDINGS_BASE_URL`; empty falls back to
    `OLLAMA_API_KEY`, then to a placeholder (Ollama ignores auth)."""

    EMBEDDINGS_MODEL: str = ""
    """Embedding model id. Empty → `nomic-embed-text` (768-dim — must match
    the `vector(768)` column of `file_sections`)."""

    OLLAMA_BASE_URL: str = ""
    """Fallback embedder base URL when `EMBEDDINGS_BASE_URL` is unset (the
    Ollama host the Next.js app also uses for `ollama/*` chat models)."""

    OLLAMA_API_KEY: str = ""
    """Optional key for `OLLAMA_BASE_URL`."""

    # --- Memory extraction (`/v1/memory/extract`) -------------------------
    MEMORY_EXTRACT_MODEL: str = ""
    """Catalog id of the memory-extraction model. Used only when it is an
    allowed `anthropic/*` entry of `config/models.json`; empty or anything
    else (the Next.js default is `google/gemini-2.5-flash`, which this
    service cannot call) → `AGENT_DEFAULT_MODEL`."""

    # --- Request hardening ------------------------------------------------
    CORS_ALLOWED_ORIGINS: str = ""
    """Comma-separated exact origins (scheme://host[:port]) allowed to
    call the API cross-origin from a browser, e.g. `http://localhost:3000`
    when the frontend calls agent-py on its own port. Empty (default) = no
    CORS headers at all, which is right for the same-origin reverse-proxy
    setup. No wildcards and no credentialed CORS: the browser sends the
    Supabase JWT as a bearer header, never cookies."""

    TRUSTED_PROXY_HOPS: int = 1
    """How many reverse proxies in front of the service append to
    `X-Forwarded-For`. The rate-limit key is the XFF entry this many
    places from the right (1 = the rightmost entry, i.e. the address
    our own proxy saw). Entries further left are client-supplied and
    spoofable. 0 = ignore XFF entirely and key on the socket peer."""

    CLIENT_IP_HEADER: str = ""
    """Optional single-value header a trusted platform sets to the real
    client IP (e.g. `cf-connecting-ip`, `x-real-ip`, `fly-client-ip`).
    When set and present it wins over `X-Forwarded-For`. Only set this
    if the edge proxy overwrites the header — otherwise it's spoofable."""

    EXTRACT_MAX_BYTES: int = 5 * 1024 * 1024
    """Upload cap for `/v1/extract`. Matches the Next.js route's
    `FILE_SIZE_LIMIT` (`lib/shared/upload-config.ts`, 5 MB). Larger
    uploads get 413 before extraction runs."""

    REQUEST_BODY_MAX_BYTES: int = 1024 * 1024
    """Default request-body cap (`body_limit.py`), enforced before
    routing / auth so an unauthenticated caller can't make the service
    buffer an unbounded body. `/v1/extract` uses `EXTRACT_MAX_BYTES`
    (+ multipart overhead) instead, `/v1/chat` + `/v1/summarize` use
    `CHAT_BODY_MAX_BYTES`. Over the cap → 413."""

    CHAT_BODY_MAX_BYTES: int = 16 * 1024 * 1024
    """Request-body cap for `/v1/chat` and `/v1/summarize`, whose JSON
    carries a whole conversation (up to 200 messages)."""

    # --- Service identity -------------------------------------------------
    SERVICE_NAME: str = "agent-py"
    SERVICE_PORT: int = 8000


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide singleton. `lru_cache` keeps lookups cheap inside hot
    request paths without paying for a `Depends` injection on every call."""
    return Settings()
