<!-- related: README.md, docs/SUPABASE_TEST.md -->

# Troubleshooting

## What it is
Common failure modes and how to recover. If a fix here doesn't
work, check the GitHub issues for your Hummingbird version.

## "This deploy has no backend configured"

The whole app shows this screen when the frontend was built without
`NEXT_PUBLIC_AGENT_PY_URL`: every feature talks to the agent service
(agent-py), and the frontend doesn't know where it is. Set
`NEXT_PUBLIC_AGENT_PY_URL` (an absolute URL, or `/` behind a same-origin
proxy - see [Environment variables](21-environment-variables.md) and
[Installation](20-installation.md)) and rebuild / redeploy the frontend:
`NEXT_PUBLIC_*` values are baked in at build time, so a restart alone
isn't enough.

## "No model provider is configured on this deploy"

The agent service has no model provider key at all, so nothing can
answer: the model picker and the chat say so and sending is blocked
(there is no mock answer). Set a provider key
for agent-py — see [Model providers](23-model-providers.md) — and
restart it, then reload the page.

## "Sign in required" instead of an AI answer

The server sets `REQUIRE_AUTH_FOR_AI`, so AI features (chat, Explain,
summaries, Compress, editor AI and autocomplete, table extraction)
need a signed-in account. Click **Sign in** on the error bubble or
the toast, sign in, then **Retry**. Uploads still work while signed
out, but without the vision pass for scanned / layout-heavy PDFs.
Operators: unset the variable (or set it to `false`) to allow
anonymous use - see [Environment variables](21-environment-variables.md).

## "File upload stuck on extraction"

The first extraction of a large file (PDF, code repo) can take
several seconds. The row's extraction status badge shows progress.
If it never finishes, check the agent service's logs - extraction is
agent-py's `/v1/extract`.

## "MCP cloud-mode returns 401 / decrypt failed"

`MCP_ENCRYPTION_KEY` was rotated (or never set). See
[Encryption keys](25-encryption-keys.md). Users have to re-add
their cloud-mode servers.

## "Python agent service returns 503 on auth-protected endpoints"

`SUPABASE_JWT_SECRET` is missing. The Python service requires it
to verify the user's JWT. Without it, those endpoints return 503
(a distinct signal from 401, so monitoring can alert on
misconfig).

## "Poller no-ops every tick"

`SUPABASE_DB_URL` is missing or is the pooler connection. The
poller needs the **direct** connection (`db.<project>.supabase.co:5432`)
because `FOR UPDATE SKIP LOCKED` needs an open transaction. See
[Environment variables](21-environment-variables.md).

## `bun run check` fails

```bash
bun run typecheck    # tsc errors
bun run lint         # eslint errors
bun test             # test failures
```

Run them individually to see which failed. Most common cause: a
new dep added without `bun install`.

## Related
- [Installation](20-installation.md)
- [Environment variables](21-environment-variables.md)
- [Supabase setup](22-supabase-setup.md)
