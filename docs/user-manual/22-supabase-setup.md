<!-- related: docs/SUPABASE_LOCAL.md, docs/SUPABASE_SETUP.md, docs/SUPABASE_TEST.md, supabase/migrations/ -->

# Supabase setup

## What it is
The two ways to wire Hummingbird to Supabase: local Docker for dev,
or a hosted Supabase project for production.

## Local Supabase

Full guide: [`docs/SUPABASE_LOCAL.md`](../SUPABASE_LOCAL.md).

```bash
# Path A - Supabase CLI
bun run supabase:start

# Path B - docker-compose
bun run supabase:docker:up
bun run supabase:docker:migrate
```

The local stack starts Studio at <http://localhost:54323> and
the magic-link inbox (Mailpit with the CLI, Inbucket with
docker-compose) at <http://localhost:54324>. The
dev keys are dumped to `.docker/supabase/dev-keys.txt` - paste the
`NEXT_PUBLIC_*` ones into `apps/web/.env` and the service-role key
into `services/agent-py/.env`.

## Hosted Supabase

Full guide: [`docs/SUPABASE_SETUP.md`](../SUPABASE_SETUP.md).

1. Create a Supabase project.
2. Run the migrations in `supabase/migrations/` in numeric order
   (seventeen files, 0001-0017).
3. Paste the project's URL + anon key into `apps/web/.env`
   (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`), and
   the URL, JWT secret, direct DB URL and service-role key into
   `services/agent-py/.env` (`SUPABASE_URL`, `SUPABASE_JWT_SECRET`,
   `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
4. Configure auth (magic-link templates) and Storage buckets per
   the SUPABASE_SETUP guide.

## Verifying the stack

```bash
bun test                          # unit + integration
bun run check                     # typecheck + lint
```

For end-to-end verification of the file full-text retrieval
pipeline (after schema or extraction changes), see
[`docs/SUPABASE_TEST.md`](../SUPABASE_TEST.md).

## Tips & gotchas
- Seventeen migration files. They run in numeric order - don't
  skip ahead.
- The hosted project MUST expose a **direct** Postgres connection
  for the Python agent service's poll loop. Use
  `db.<project>.supabase.co:5432`, not the pooler.
- Magic-link emails in dev land in the local inbox, not your real inbox.
  Open <http://localhost:54324> to find them.

## Related
- [Installation](20-installation.md)
- [Environment variables](21-environment-variables.md)
- [Troubleshooting](26-troubleshooting.md)
