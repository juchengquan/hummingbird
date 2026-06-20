# Plan: MCP-proxy outbound SSRF guard

Status: **⏸ deferred (single-user self-host).** A known gap, intentionally
not closed yet — re-open when multi-tenant / shared deployments arrive.
Found 2026-06-20 while closing the url-fetch SSRF-guard real-DNS test (#260).

Companion: [`PLAN-agent-api.md`](PLAN-agent-api.md) (the agent-py MCP proxy)
and the multi-tenant cross-cutting dependency in
[`MASTER_PLAN.md`](MASTER_PLAN.md).

## The gap

The MCP proxy connects to the **user-configured** MCP server URL with only a
syntactic check (`z.string().url()`), **not** the outbound SSRF guard
(`validateOutboundUrl` / `validate_outbound_url`) that url-fetch + image-gen
use:

- In-Next: `app/api/mcp/[serverId]/[action]/route.ts` → MCP client connects to
  `server.url`.
- agent-py: `routers/mcp.py::mcp_proxy` → `McpEndpoint(url=body.server.url)` →
  `mcp_client._open_session` → `streamablehttp_client(endpoint.url, …)`.

So a configured `server.url` of `http://169.254.169.254/…` (cloud metadata),
`http://localhost:…`, or a public name that DNS-rebinds to a private IP makes
the **server** issue that request.

## Why it's deferred (not a bug today)

In the current **single-user, self-hosted** model the MCP server URL is the
user's own intentional config, and pointing at a **local** MCP server
(`localhost`, a private-LAN host) is a legitimate, common setup — exactly what
a filesystem / local-tool MCP server needs. Applying the SSRF guard here would
**break** that. This is the opposite of url-fetch, where the **model** supplies
URLs (untrusted → must be guarded).

## Why it matters later (the re-open trigger)

Once **multi-tenant / shared deployments** exist, the server's outbound
identity is shared: an attacker-tenant could configure an MCP server URL
pointing at cloud metadata / internal services / another tenant and have the
**shared server** connect to it → SSRF, credential exfiltration.

**Re-open when:** multi-tenant / shared-deployment work begins — the same gate
that governs A2A publishing, collaborative-editing Phase B, and guardrails in
`MASTER_PLAN.md`.

## Proposed fix (when re-opened)

The guard already exists — this is wiring + a policy flag, not new logic:

1. At proxy time, run `body.server.url` through `validateOutboundUrl` /
   `validate_outbound_url` (both backends) before connecting; reject on
   `private_address` / `blocked_host`.
2. Gate it behind a per-deployment policy so self-host keeps working — e.g.
   `MCP_ALLOW_PRIVATE_URLS=1` (default permissive for self-host; validated in
   multi-tenant), or tie validation to a multi-tenant mode flag.
3. Close the TOCTOU window: the guard resolves once, then the transport
   resolves again independently (rebinding window). `providers-config.ts`
   already notes rebinding is "out of scope for a synchronous gate" — for the
   MCP path, pin/recheck the resolved IP at connect time for full safety.
4. Test parity: a real-DNS rebinding test on the MCP path (mirrors #260).

## Out of scope

Not changing the single-user behaviour now. This file exists so the gap is
tracked and resurfaces with the multi-tenant work rather than being
rediscovered.
