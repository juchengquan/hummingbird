<!-- pages-for: env:* -->
<!-- related: apps/web/.env.example, services/agent-py/.env.example, config/providers.json, config/models.json -->

# Environment variables

## What it is
The full set of env vars Hummingbird reads. The canonical lists with
descriptions are [`apps/web/.env.example`](../../apps/web/.env.example)
and [`services/agent-py/.env.example`](../../services/agent-py/.env.example) -
this page groups them by purpose and explains when each is needed.

There are two readers. The **frontend** (the Next.js app) reads only
the `NEXT_PUBLIC_*` variables and `CSP_MODE`; it holds no secrets and
serves no API. **Everything else is read by the agent service**
(agent-py, `services/agent-py/`), which serves chat, tasks, schedules,
files, MCP and every other API surface - see its README's
Configuration section for the full table. Each reads its own file:
the frontend `apps/web/.env` (copy `apps/web/.env.example`), agent-py
`services/agent-py/.env` (copy `services/agent-py/.env.example`). A
value both need is set in each (`NEXT_PUBLIC_SUPABASE_URL` for the
frontend, `SUPABASE_URL` for agent-py). The Frontend table below goes
in `apps/web/.env`; every Agent service table in
`services/agent-py/.env`. A root `.env` is not read;
`bun run env:split` moves one into the two files.

## Frontend (Next.js)

| Variable | Effect |
|---|---|
| `NEXT_PUBLIC_AGENT_PY_URL` | Base URL of the agent service. **Required**: without it the app builds but shows a full-page "This deploy has no backend configured" screen (see [Troubleshooting](26-troubleshooting.md)). Use an absolute URL (`http://localhost:8000`) for a separate origin, or `/` when a reverse proxy serves the agent service on the app's own origin (local dev: `docker compose up proxy agent-py`, then open `http://localhost:8080`). Browsers send CSP violation reports to its `/v1/csp-report`. |
| `NEXT_PUBLIC_API_BASE_URL` | Optional. An extra backend origin the browser may call (added to the CSP's `connect-src`). |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser client target. Optional: without Supabase the app runs anonymously on `localStorage`. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser client auth. |
| `CSP_MODE` | Content-Security-Policy mode: `report-only` (default — violations are reported, nothing blocked), `enforce` (violations blocked), or `off` (no CSP header). See `docs/SECURITY.md` before switching to `enforce`. |

## Agent service - model providers

At least one provider is needed for real AI. With none, the model
picker and the chat say "No model provider is configured on this
deploy" and sending is blocked - there is no mock answer.

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Direct Anthropic calls (the `anthropic/*` models). |
| `ANTHROPIC_BASE_URL` | Override the base URL of the direct Anthropic calls (a proxy). Empty means Anthropic's own API. |
| `AI_GATEWAY_API_KEY` | The Vercel AI Gateway: the catalog's `gateway` routes (OpenAI, Google, DeepSeek; `anthropic/*` too without `ANTHROPIC_API_KEY`). |
| `MINIMAX_CN_BASE_URL` + `MINIMAX_CN_API_KEY` | Both set -> the `minimax/*` models run on Minimax's Anthropic-compatible endpoint (include the `/v1` suffix). The key also enables image generation. |
| `OLLAMA_BASE_URL` | Set (typically `http://localhost:11434/v1`) -> the `ollama/*` models run on that Ollama host. |
| `OLLAMA_API_KEY` | Optional. Ollama doesn't enforce auth. |
| `OPENROUTER_API_KEY` | Set -> the `openrouter/*` models run via `https://openrouter.ai/api/v1`. |
| `AGENT_DEFAULT_MODEL` | The model used when a request names none, and for follow-up suggestions. Default `anthropic/claude-haiku-4.5`; must be in `config/models.json`. The agent service runs every model in `config/models.json` it has a provider for, and the model picker offers only those. |
| `MODELS_CONFIG_PATH` | Where to read `config/models.json` from. Leave empty outside Docker. |
| `VERIFY_MODEL` / `VERIFY_PROVIDER` / `GOOGLE_API_KEY` | Optional citation verifier for Deep Research reports. |
| `WORKER_STUB_MODEL` | Tests only. `true` answers background tasks with canned text, without a model. Leave empty: anything other than `true`, `false` or empty stops the service at startup. |

## Agent service - Supabase and sign-in

| Variable | Effect |
|---|---|
| `SUPABASE_URL` | The project URL (same value as `NEXT_PUBLIC_SUPABASE_URL`). |
| `SUPABASE_JWT_SECRET` | Verifies users' sign-in tokens. Without it (or a JWKS URL) the signed-in endpoints return 503. |
| `SUPABASE_DB_URL` | Direct Postgres connection (NOT the pooler) - required by the task worker, the scheduler and saved tasks. |
| `SUPABASE_SERVICE_ROLE_KEY` | Storage access for generated images and files. Never expose. |
| `REQUIRE_AUTH_FOR_AI` | Default off. `true`/`1` (with Supabase configured) -> anonymous visitors can't use AI: chat, summaries, editor AI / autocomplete, table extraction and memory extraction answer "Sign in required", adding a link needs sign-in, and file uploads skip the vision pass (plain text extraction still works). Off, unset, or no Supabase -> anonymous mode works as before. Only `true`/`false`/`1`/`0` are accepted; any other value makes anonymous AI calls fail until fixed. |
| `CORS_ALLOWED_ORIGINS` | Comma-separated exact origins allowed to call the agent service from a browser on another origin, e.g. `http://localhost:3000` when `NEXT_PUBLIC_AGENT_PY_URL` is `http://localhost:8000`; without it the browser blocks those calls. Leave it empty with the same-origin proxy (`/`). No wildcards. |
| `TRUSTED_PROXY_HOPS` | How many reverse proxies in front of the agent service append to `X-Forwarded-For` (default `1`). Per-IP rate limits read the client IP from that entry; `0` ignores the header and uses the connection's address. See `docs/SECURITY.md`. |

## Agent service - tasks and schedules

| Variable | Effect |
|---|---|
| `SCHEDULER_ENABLED` | Unset, it follows the worker: an agent service that runs tasks (`WORKER_DRY_RUN=false`, with `SUPABASE_DB_URL`) also fires scheduled tasks, every `SCHEDULER_INTERVAL_SECONDS` (default 60). `false` turns that off; `true` turns it on regardless. There is no separate cron job. |
| `SCHEDULER_INTERVAL_SECONDS` | Seconds between scheduled-task checks. Default `60`. |
| `TASK_NO_WORKER_TIMEOUT_MINUTES` | Default 10. A background task that no worker has started after this many minutes is marked failed with "No task worker available". This happens only when no worker has run anything in that window — the task worker is down or in dry-run — so a busy worker's backlog keeps waiting. (Tasks of a user an admin has opted out fail right away.) |

## Agent service - tools and files

| Variable | Effect |
|---|---|
| `TAVILY_API_KEY` | Enables the web search tool. |
| `MINIMAX_IMAGE_RATE_LIMIT_PER_MINUTE` | Per-IP rate cap for the image-generation tool. Default tight. |
| `MCP_ENCRYPTION_KEY` | Required when any user picks Cloud-mode credentials for an MCP server. Generate with `openssl rand -base64 32`. See [Encryption keys](25-encryption-keys.md). |
| `MCP_ALLOW_PRIVATE_HOSTS` | Default off. `true` lets MCP servers on `localhost` / private networks through (local dev only - never on a shared deploy). |
| `EMBEDDINGS_BASE_URL` | Optional. An OpenAI-compatible embeddings endpoint (e.g. Ollama's `http://localhost:11434/v1`). Turns on semantic file search: uploaded files' text is split into chunks and embedded. Unset -> `OLLAMA_BASE_URL` is used; neither set -> embedding is off and file search stays full-text only. |
| `EMBEDDINGS_API_KEY` | Optional key for `EMBEDDINGS_BASE_URL` (falls back to `OLLAMA_API_KEY`). |
| `EMBEDDINGS_MODEL` | Default `nomic-embed-text`. Must produce 768-dimension vectors (the database column's size). |
| `MEMORY_EXTRACT_MODEL` | Optional. The model that picks durable facts out of a finished chat for cross-conversation memory. Used only if it is a model from `config/models.json` with structured output that has a provider, else `AGENT_DEFAULT_MODEL`. |
| `CODE_SANDBOX_ENABLED` / `CODE_SANDBOX_BASE_URL` | Optional. Turns on the code interpreter (`runCode`) in a local microsandbox VM. |
| `VISION_MODEL` | Optional. The vision-capable model that transcribes scanned / layout-heavy PDFs on upload. Unset -> the first `supportsVision` model with a provider; none -> text-only extraction. |

## Tips & gotchas
- Variables prefixed `NEXT_PUBLIC_*` are inlined into the client
  bundle. **Never** put a secret in one of those.
- `SUPABASE_DB_URL` MUST be the **direct** connection
  (`db.<project>.supabase.co:5432`), NOT the pooler
  (`*.pooler.supabase.com:6543`). `FOR UPDATE SKIP LOCKED` needs an
  open transaction.
- `OLLAMA_BASE_URL` should end in `/v1` - that's Ollama's
  "OpenAI compatibility" endpoint.

## Related
- [Installation](20-installation.md)
- [Supabase setup](22-supabase-setup.md)
- [Model providers](23-model-providers.md)
- [MCP server config](24-mcp-server-config.md)
