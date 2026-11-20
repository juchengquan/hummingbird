<!-- pages-for: env:* -->
<!-- related: .env.example, config/providers.json, config/models.json -->

# Environment variables

## What it is
The full set of env vars Hummingbird reads. The canonical list with
descriptions is in [`.env.example`](../../.env.example) - this page
groups them by purpose and explains when each is needed.

## Required (for real AI)

| Variable | Why |
|---|---|
| `AI_GATEWAY_API_KEY` | Streams chat / editor model calls. Without it, chat falls back to a mock. |

## Optional - providers

| Variable | Effect |
|---|---|
| `MINIMAX_CN_BASE_URL` + `MINIMAX_CN_API_KEY` | Both set -> `minimax/*` routes via the native Anthropic SDK at the configured base URL. Either unset -> falls through to the gateway. |
| `OLLAMA_BASE_URL` | Set (typically `http://localhost:11434/v1`) -> `ollama/*` models route to Ollama's OpenAI-compatible endpoint. |
| `OLLAMA_API_KEY` | Optional. Ollama doesn't enforce auth. |
| `OPENROUTER_API_KEY` | Set -> `openrouter/*` routes via `https://openrouter.ai/api/v1`. |

## Optional - Supabase

| Variable | Effect |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Browser client target. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser client auth. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side admin (share links, generated-image Storage mirror). Never expose. |
| `SUPABASE_JWT_SECRET` | Read by the Python agent service for auth-protected endpoints. Without it those endpoints return 503. |
| `SUPABASE_DB_URL` | Direct Postgres connection (NOT the pooler) - required by the Python agent service's Phase 1+ poll loop. |
| `REQUIRE_AUTH_FOR_AI` | Default off. `true`/`1` (with Supabase configured) -> anonymous visitors can't use AI: chat, summaries, editor AI / autocomplete, table extraction and memory extraction answer "Sign in required", and file uploads skip the vision pass (plain text extraction still works). Off, unset, or no Supabase -> anonymous mode works as before. Only `true`/`false`/`1`/`0` are accepted; any other value makes the AI routes fail until fixed. |

## Optional - search & image

| Variable | Effect |
|---|---|
| `TAVILY_API_KEY` | Enables the Tavily-backed web search skill. |
| `BRAVE_SEARCH_API_KEY` | Enables the Brave-backed web search skill. |
| `EXA_API_KEY` | Enables the Exa-backed web search skill. All three can be enabled together. |
| `MINIMAX_IMAGE_RATE_LIMIT_PER_MINUTE` | Per-IP rate cap for the image-generation tool. Default tight. |

## Optional - MCP

| Variable | Effect |
|---|---|
| `MCP_ENCRYPTION_KEY` | Required when any user picks Cloud-mode credentials for an MCP server. Generate with `openssl rand -base64 32`. See [Encryption keys](25-encryption-keys.md). |

## Optional - split backend

| Variable | Effect |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | Points the API client at a non-default origin (used when the backend is rewritten in another language). |
| `NEXT_PUBLIC_AGENT_PY_URL` | Base URL of the Python agent service. When set, the account menu shows a "Python agent backend" toggle. |
| `NEXT_PUBLIC_AGENT_TS_URL` | Base URL of the TypeScript agent service. When set + Python also set, surfaces a 3-way picker. |
| `TASK_NO_WORKER_TIMEOUT_MINUTES` | Default 10. Background tasks run on the Python agent service. A task that no worker has started after this many minutes is marked failed with "No task worker available". This happens when the agent service is down or in dry-run, or when an admin has opted the user out. |

## Optional - security headers

| Variable | Effect |
|---|---|
| `CSP_MODE` | Content-Security-Policy mode: `report-only` (default — violations are reported, nothing blocked), `enforce` (violations blocked), or `off` (no CSP header). See `docs/SECURITY.md` before switching to `enforce`. |

## Optional - Anthropic direct

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Read by the Python agent service's Phase 2b+ executor for direct Anthropic calls. Without it, the executor uses the Phase 2a stub. |
| `ANTHROPIC_BASE_URL` | Override the Anthropic base URL. Useful for self-hosted gateways. |
| `AGENT_DEFAULT_MODEL` | Model the agent services (Python + TypeScript) use when a request names none, and for follow-up suggestions. Default `anthropic/claude-haiku-4.5`. The agent services only accept the `anthropic/*` models in `config/models.json`; picking any other model with an agent backend selected returns an "unknown model" error. |
| `MODELS_CONFIG_PATH` | Python agent service only: where to read `config/models.json` from. Leave empty outside Docker. |

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
