<!-- related: .env.example, lib/server/mcp/credentials.ts, supabase/migrations/0005_mcp.sql -->

# Encryption keys

## What it is
The keys Hummingbird uses to encrypt secrets at rest. The only
required one is `MCP_ENCRYPTION_KEY`; the rest are auto-managed.

## `MCP_ENCRYPTION_KEY`

Required when any user picks Cloud-mode credentials for an MCP
server. The key is used by a Postgres `SECURITY DEFINER` RPC to
encrypt and decrypt `credentials_encrypted` rows.

### Generate

```bash
openssl rand -base64 32
```

The output is a 32+ character base64 string. Paste it into
`.env.local` as `MCP_ENCRYPTION_KEY=<value>`.

### Rotation

Rotating the key invalidates every existing cloud-mode credential -
users have to re-add their servers. To rotate without downtime:

1. Decrypt every `credentials_encrypted` row with the OLD key.
2. Set the NEW key in `.env.local`.
3. Re-encrypt with the new key.
4. Roll the deploy.

There is no built-in rotation tool. The two-step dance above is
deliberate - you can't transparently migrate without keeping the
old key live for the duration.

### Where the key is read

- Next.js server env (the original reader).
- Python agent service env (Phase 3f-1+ - reads the same var to
  call the same `SECURITY DEFINER` decrypt RPC).

The key is **never** persisted to Postgres. It's passed as an
argument to the RPC at request time.

## Tips & gotchas
- If you skip setting `MCP_ENCRYPTION_KEY`, cloud-mode is silently
  disabled. Local-mode still works.
- A 32-byte key is the minimum. Larger is fine; the RPC truncates
  to its internal block size.

## Related
- [MCP server config](24-mcp-server-config.md)
- [Environment variables](21-environment-variables.md)
