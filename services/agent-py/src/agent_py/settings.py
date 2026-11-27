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

from pydantic import field_validator, model_validator
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
    """The legacy HS256 project secret. With neither it nor a JWKS URL
    (`SUPABASE_JWKS_URL` / `SUPABASE_URL`), auth-protected endpoints
    answer 503."""

    SUPABASE_JWKS_URL: str = ""
    """The project's public signing keys (ES256 / RS256 access tokens,
    wave 9). Empty → `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` when
    `SUPABASE_URL` is set. Read only for a token whose `alg` is
    asymmetric; an HS256 token goes to `SUPABASE_JWT_SECRET`."""

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

    WORKER_STUB_MODEL: bool = False
    """Tests only: execute background tasks with a model-free stub that
    answers canned text (Q55 — success is never faked otherwise). Exactly
    `true` turns it on; unset / empty / `false` is off; any other value
    fails the service at boot. A task without a model or messages still
    fails. Never set it in a deployment."""

    @field_validator("WORKER_STUB_MODEL", mode="before")
    @classmethod
    def _strict_worker_stub_model(cls, value: object) -> bool:
        if isinstance(value, bool):
            return value
        if value is None or value == "" or value == "false":
            return False
        if value == "true":
            return True
        raise ValueError("WORKER_STUB_MODEL must be `true` or `false`")

    # --- Schedule dispatcher -----------------------------------------------
    SCHEDULER_ENABLED: bool | None = None
    """Run the `task_schedules` dispatcher loop (`agent_py.scheduler`) in
    this process: every `SCHEDULER_INTERVAL_SECONDS` it fires due
    schedules exactly like the Vercel Cron's `/api/tasks/jobs/tick`
    (`dispatchDueSchedules`). Unset (or empty) it follows the worker
    (Q130): on where the worker runs tasks (`WORKER_DRY_RUN=false`) with
    `SUPABASE_DB_URL` set, off otherwise; an explicit `true` / `false`
    wins either way. Always a bool once loaded. Safe to run alongside
    that cron and on several replicas: each occurrence is claimed with a
    guarded `next_run_at` update, so only one dispatcher fires it. Needs
    `SUPABASE_DB_URL`."""

    @field_validator("SCHEDULER_ENABLED", mode="before")
    @classmethod
    def _empty_scheduler_enabled_is_unset(cls, value: object) -> object:
        return None if value == "" else value

    @model_validator(mode="after")
    def _scheduler_follows_the_worker(self) -> Settings:
        if self.SCHEDULER_ENABLED is None:
            self.SCHEDULER_ENABLED = not self.WORKER_DRY_RUN and bool(self.SUPABASE_DB_URL)
        return self

    SCHEDULER_INTERVAL_SECONDS: float = 60.0
    """Seconds between dispatcher ticks. 60 matches the Vercel Cron's
    one-minute cadence (and the 4-minute minimum gap's one tick of slack)."""

    # --- Model providers --------------------------------------------------
    ANTHROPIC_API_KEY: str = ""
    """Anthropic API key — the model provider of every run. Empty: a run
    fails with a clear message, interactive and background alike (Q55);
    nothing falls back to canned output."""

    ANTHROPIC_BASE_URL: str = ""
    """Optional override for the Anthropic API base URL. Empty = Anthropic's
    own API (https://api.anthropic.com, passed explicitly —
    `anthropic_client.py`). Set to point the direct route at an Anthropic-
    compatible endpoint (a proxy). Has no effect when `ANTHROPIC_API_KEY`
    is empty."""

    # --- Other providers (wave 10, `model_routes.py`) ----------------------
    # The catalog's other routes, named by `config/providers.json`. All are
    # spoken to in the Anthropic Messages format. `MINIMAX_CN_*` and
    # `OLLAMA_*` are declared below with their other uses.
    AI_GATEWAY_API_KEY: str = ""
    """The Vercel AI Gateway (its `/v1/messages`): the `gateway` routes —
    OpenAI, Google, DeepSeek, and the `anthropic/*` models when
    `ANTHROPIC_API_KEY` is unset. The same variable Next reads."""

    OPENROUTER_API_KEY: str = ""
    """OpenRouter (`/api/v1/messages`): the `openrouter/*` models."""

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

    MCP_ALLOW_PRIVATE_HOSTS: bool = False
    """Let MCP traffic reach private hosts — loopback, RFC 1918, ULA,
    `.local`-style names — for a dev MCP server on the same machine.
    Next.js's `MCP_ALLOW_PRIVATE_HOSTS` (`lib/server/mcp/outbound.ts`):
    only the exact value `true` turns it on; unset / empty / `false` is
    off, and any other value fails the service at boot rather than being
    guessed at. Covers every MCP egress path (`mcp_client`, the proxy and
    the upsert URL check, local and cloud MCP tools); bookmarks and
    `webFetch` stay public-only. Link-local and cloud-metadata addresses
    (169.254.0.0/16, fe80::/10, `metadata.google.internal`, …) stay
    blocked regardless. Never enable on a shared deployment."""

    @field_validator("MCP_ALLOW_PRIVATE_HOSTS", mode="before")
    @classmethod
    def _strict_mcp_allow_private_hosts(cls, value: object) -> bool:
        if isinstance(value, bool):
            return value
        if value is None or value == "" or value == "false":
            return False
        if value == "true":
            return True
        raise ValueError("MCP_ALLOW_PRIVATE_HOSTS must be `true` or `false`")

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

    # --- Code interpreter (`runCode`, wave 8) --------------------------------
    # The same names and defaults as Next's `lib/server/code-sandbox/config.ts`,
    # so one `.env` covers both. `runCode` registers only when enabled AND the
    # startup check passes (`code_sandbox.select`): the `sandbox` extra is
    # installed and the host can run a microVM (`/dev/kvm`, macOS arm64) or
    # `MSB_BACKEND=remote` with `MSB_API_KEY`. The SDK reads `MSB_HOME`
    # itself; give agent-py its own, short (Unix socket paths derive from it).
    CODE_SANDBOX_ENABLED: str = ""
    """`1` / `true` / `yes` / `on` (as Next) turns the code interpreter on."""
    CODE_SANDBOX_BASE_URL: str = ""
    """Also turns it on, as on Next (reserved there for a remote backend)."""
    CODE_SANDBOX_TIMEOUT_MS: int = 30_000
    CODE_SANDBOX_STDOUT_CAP: int = 256_000
    CODE_SANDBOX_RESULT_CAP: int = 10_000_000
    CODE_SANDBOX_RESULT_FILE_MAX: int = 20
    CODE_SANDBOX_MEM_MIB: int = 512
    CODE_SANDBOX_CPUS: int = 1
    CODE_SANDBOX_MAX_CONCURRENT: int = 2
    """microVMs booting / running at once in this process (each holds
    `MEM_MIB`); more calls wait for a slot."""
    CODE_SANDBOX_PYTHON_IMAGE: str = "jupyter/scipy-notebook"
    CODE_SANDBOX_JS_IMAGE: str = "node"
    CODE_SANDBOX_MOUNT_FILE_MAX: int = 10_000_000
    CODE_SANDBOX_MOUNT_TOTAL_MAX: int = 20_000_000
    CODE_SANDBOX_MOUNT_COUNT_MAX: int = 10
    CODE_SANDBOX_TABLE_MAX_COLS: int = 50
    CODE_SANDBOX_TABLE_MAX_ROWS: int = 1000
    CODE_SANDBOX_TABLE_CELL_MAX: int = 500

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

    # --- Runs (`/v1/runs`, PLAN-frontend-backend-split Phase 2) ------------
    REQUIRE_AUTH_FOR_AI: str = ""
    """Refuse anonymous runs (`401 auth_required`) when true — today's
    Next.js `REQUIRE_AUTH_FOR_AI` (Q20), same strict parsing as
    `lib/server/auth/require-ai-auth.ts`: `true` / `false` / `1` / `0`
    (case-insensitive, whitespace ignored), unset / empty = off; any other
    value fails every anonymous run start with a 500 (never silently
    open). Inert while no token can be verified (no `SUPABASE_JWT_SECRET`
    and no JWKS URL): then nobody can sign in, so there is nothing to require (as in Next.js without
    Supabase). Parsed by `agent_py.runs.access.require_auth_for_ai`."""

    RUNS_STUB_HARNESS: bool = False
    """Run every run on the model-free stub harness
    (`agent_py.runs.stub_harness`) — for the contract conformance suite
    and local development. Never in production: it answers without a
    model. The stub reads `forwardedProps.conformance` (see the
    harness's docstring)."""

    RUNS_LEASE_SECONDS: float = 60.0
    """Lease an interactive run holds on its row (`tasks.lease_expires_at`
    / the in-memory equivalent) while this process executes it. A run
    whose lease lapses belongs to a dead process and is failed
    `worker_lost` by the reaper (Q28 — never handed over)."""

    RUNS_HEARTBEAT_SECONDS: float = 5.0
    """How often an executing interactive run extends its lease. Also the
    latency of a cancel made in another process: the heartbeat finding
    the row no longer live is how the executing process learns of it."""

    RUNS_REAPER_INTERVAL_SECONDS: float = 15.0
    """Seconds between passes of the runs maintenance loop: the
    interactive-run reaper (lapsed leases) and the in-memory store's
    TTL sweep."""

    RUNS_MEMORY_TTL_SECONDS: float = 900.0
    """How long an in-memory run (anonymous, or signed-in without
    `SUPABASE_DB_URL`) and its event log are kept after it ends (Q16:
    ~15 min). Afterwards every operation on it answers 404."""

    RUNS_MEMORY_MAX_RUNS: int = 2000
    """Cap on runs held in memory at once (live + recently ended). A start
    past it answers `503 unavailable` instead of growing without bound."""

    RUNS_RATE_PER_MINUTE: int = 30
    """Run starts per client IP per minute, every caller (the same budget
    as `/v1/chat`'s turns)."""

    RUNS_ANONYMOUS_RATE_PER_MINUTE: int = 10
    """Anonymous run starts per client IP per minute (on top of
    `RUNS_RATE_PER_MINUTE`)."""

    RUNS_ANONYMOUS_DAILY_BUDGET: int = 200
    """Anonymous run starts per client IP per rolling 24 h."""

    RUNS_ANONYMOUS_MAX_CONCURRENT: int = 3
    """Live anonymous runs per client IP at once."""

    RUNS_RECONCILE_ENABLED: bool = True
    """Run the no-worker reconciler (`agent_py.runs.reconcile`, wave 6) in
    this process when `SUPABASE_DB_URL` is set: a background task still
    `queued`, never picked up, after `TASK_NO_WORKER_TIMEOUT_MINUTES` —
    while no worker executed anything in that window — fails "No task
    worker available", as Next's `reconcileStaleRuns` does when its task
    stream route is opened. Safe on several replicas (each failure is a
    guarded update)."""

    RUNS_RECONCILE_INTERVAL_SECONDS: float = 60.0
    """Seconds between no-worker reconciler passes."""

    TASK_NO_WORKER_TIMEOUT_MINUTES: float = 10.0
    """How long a never-started background task may wait for a worker —
    the variable Next reads (`noWorkerTimeoutMs`), read the same way: a
    positive number of minutes, anything else (empty, not a number, ≤ 0)
    the default 10."""

    @field_validator("TASK_NO_WORKER_TIMEOUT_MINUTES", mode="before")
    @classmethod
    def _lenient_no_worker_timeout(cls, value: object) -> float:
        try:
            minutes = float(str(value).strip()) if value is not None else 0.0
        except ValueError:
            return 10.0
        return minutes if minutes > 0 and minutes != float("inf") else 10.0

    DB_POOL_MAX_SIZE: int = 10
    """Connections in agent-py's Postgres pool, shared by the task poller,
    the schedule dispatcher, the reconciler and every runs request and
    stream (an idle stream holds none between its polls). Was a fixed 4
    (wave 6, survey bug 18). Keep it under the database's connection
    limit across every replica."""

    WEB_TOOL_RATE_LIMIT_PER_MINUTE: int = 20
    """Per-IP cap on interactive runs' outbound tool calls — webSearch,
    webFetch and searchFiles share one 60 s window, counted per call (the
    Next chat route's fixed `chatWebToolLimit`, 20). agent-py only; the
    Next route's 20 is not configurable."""

    MINIMAX_IMAGE_RATE_LIMIT_PER_MINUTE: str = ""
    """Per-IP cap on interactive runs' `generateImage` calls per minute —
    the same variable as the Next chat route, read the same way: not a
    positive number (or empty) → 5, otherwise floored and capped at 60
    (`rate_limit.image_gen_per_minute`). A string so a value Next
    tolerates never fails this service's boot."""

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

    VISION_MODEL: str = ""
    """The catalog model `/v1/extract`'s PDF vision pass uses, if it is
    flagged `supportsVision` and served here; else the first such model in
    catalog order; none → no vision pass. Next's `VISION_MODEL`."""

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
