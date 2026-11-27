<!-- pages-for: panel:mcp-tab -->
<!-- related: services/agent-py/src/agent_py/routers/mcp.py, lib/client/hooks/store/slices/mcp.ts, components/panels/mcp-tab.tsx -->

# MCP server config

## What it is
The Model Context Protocol (MCP) lets Hummingbird call tools
exposed by external servers. Each user configures their own
servers in the **MCP** right-rail tab.

## Adding a server

1. Open the **MCP** tab in the right rail.
2. Click **+ Add server**.
3. Pick **Local** or **Cloud** mode.
4. Fill in the server name, transport (stdio / http), command or
   URL, and any required env vars.
5. Click **Test connection** to verify the handshake.
6. Save.

Local-mode servers run their command on the user's machine; the
browser talks to them via stdio through the local shell. Cloud-mode
servers run on a remote host reachable over HTTP; credentials are
encrypted with `MCP_ENCRYPTION_KEY` and stored in Postgres.

## Local vs cloud mode

| | Local | Cloud |
|---|---|---|
| Where it runs | User's machine | Remote host (HTTP) |
| Auth | None (stdio) | Encrypted credentials in Postgres |
| Requires `MCP_ENCRYPTION_KEY` | No | Yes |
| Visible to all workspaces | No - per-user, per-device | Yes - synced across devices |

## Tips & gotchas
- The MCP panel's discovery, resource reads and tool calls go through
  the deploy's agent service (agent-py). When the deploy has accounts
  (Supabase configured) they need sign-in ("Sign in required"
  otherwise); a deploy without accounts serves them anonymously, up to
  120 calls per minute per IP. Cloud-mode servers always need sign-in.
- Rotating `MCP_ENCRYPTION_KEY` invalidates every existing
  cloud-mode credential. Users have to re-add their servers.
- If a tool call returns a "permission denied" error from a
  cloud-mode server, the encryption key may have been rotated.
- The MCP server list is per-user, not per-workspace. Move
  workspaces freely - MCP follows the user.

## Related
- [Environment variables](21-environment-variables.md)
- [Encryption keys](25-encryption-keys.md)
- [Troubleshooting](26-troubleshooting.md)
