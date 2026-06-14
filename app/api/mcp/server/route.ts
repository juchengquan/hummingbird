import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { z } from "zod"

import { upsertServerWithCredential } from "@/server/mcp/credentials"
import { getSupabaseServerClient } from "@/server/supabase/server"

/**
 * Create or update a cloud-mode MCP server config. The browser can't
 * call the encrypt RPC directly because the encryption key lives in
 * `MCP_ENCRYPTION_KEY` server-side. This route is the only path that
 * can write `credentials_encrypted`.
 *
 * Local-mode servers don't need this route — they go through the
 * sync layer like any other slice.
 */

const BodySchema = z.object({
  id: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  url: z.string().url().max(2000),
  credentials: z.object({
    type: z.string().max(40).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  capabilities: z
    .object({
      tools: z.array(z.unknown()).optional(),
      resources: z.array(z.unknown()).optional(),
      prompts: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
  enabled: z.boolean().optional(),
  requires_approval: z.boolean().optional(),
})

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseServerClient()
  if (!supabase) {
    return NextResponse.json({ error: "no_session" }, { status: 401 })
  }
  // Verify the user actually has a session — getSupabaseServerClient
  // returns a client whenever the env is configured, but we still need
  // an authenticated user for `auth.uid()` to resolve inside the RPC.
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) {
    return NextResponse.json({ error: "no_session" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.message },
      { status: 400 }
    )
  }

  const result = await upsertServerWithCredential(supabase, {
    id: parsed.data.id,
    workspaceId: parsed.data.workspaceId,
    name: parsed.data.name,
    url: parsed.data.url,
    credentials: parsed.data.credentials,
    capabilities:
      parsed.data.capabilities as unknown as Parameters<
        typeof upsertServerWithCredential
      >[1]["capabilities"],
    enabled: parsed.data.enabled,
    requiresApproval: parsed.data.requires_approval,
  })
  if (!result.ok) {
    return NextResponse.json(
      { error: "upsert_failed", message: result.error },
      { status: result.error === "encryption_key_unset" ? 500 : 502 }
    )
  }
  return NextResponse.json({ ok: true })
}
