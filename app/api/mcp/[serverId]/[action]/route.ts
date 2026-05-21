import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

/**
 * Stage 1 stub — MCP proxy. The shape and routing land here; the
 * actual MCP SDK wiring (discover / call / read), credential
 * resolution (cloud-encrypted vs local-header), and request forwarding
 * land in Stage 2. See `docs/PLAN-mcp-integration.md`.
 *
 * Routes handled (all `POST`):
 *   /api/mcp/{serverId}/discover    — fetch tools/list, resources/list, prompts/list
 *   /api/mcp/{serverId}/call        — invoke a tool
 *   /api/mcp/{serverId}/read        — read a resource by URI
 *
 * The proxy is the only component that ever holds credentials at
 * runtime — for cloud-mode servers it decrypts from Supabase; for
 * local-mode servers it reads the `X-MCP-Credentials` header from
 * the client. Credentials are never logged.
 */

const VALID_ACTIONS = new Set(["discover", "call", "read"])

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ serverId: string; action: string }> }
) {
  const { serverId, action } = await context.params

  if (!serverId || !VALID_ACTIONS.has(action)) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404 }
    )
  }

  return NextResponse.json(
    {
      error: "not_implemented",
      message:
        "MCP proxy is scaffolded but not yet wired. Stage 2 of the MCP " +
        "integration plan will implement discover / call / read. See " +
        "docs/PLAN-mcp-integration.md.",
      serverId,
      action,
    },
    { status: 501 }
  )
}
