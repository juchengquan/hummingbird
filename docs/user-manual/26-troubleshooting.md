<!-- related: README.md, docs/SUPABASE_TEST.md -->

# Troubleshooting

## What it is
Common failure modes and how to recover. If a fix here doesn't
work, check the GitHub issues for your Hummingbird version.

## "Chat returns mock responses"

`AI_GATEWAY_API_KEY` is missing or invalid. Check
[Environment variables](21-environment-variables.md) and confirm
the key is set in `.env.local`. Restart `bun dev` after editing
the file.

## "Magic-link email never arrives"

In dev: check Inbucket at <http://localhost:54324>. In hosted
Supabase: check the project's auth email templates - the magic-
link template must be enabled.

## "File upload stuck on extraction"

The first extraction of a large file (PDF, code repo) can take
several seconds. The row's extraction status badge shows progress.
If it never finishes, check the server logs - extraction lives
in `app/api/extract/`.

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

## "Chat backend toggle is missing"

The toggle only appears when `NEXT_PUBLIC_AGENT_PY_URL` (or
`NEXT_PUBLIC_AGENT_TS_URL`) is set. Without either, every value
of the internal `chatBackend` setting is silently treated as
`ts`.

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
