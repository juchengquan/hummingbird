import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@/shared/supabase/types"

import { upsertFailureStatus, upsertServerWithCredential } from "./credentials"

const ORIGINAL_KEY = process.env.MCP_ENCRYPTION_KEY

beforeAll(() => {
  process.env.MCP_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef"
})
afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.MCP_ENCRYPTION_KEY
  else process.env.MCP_ENCRYPTION_KEY = ORIGINAL_KEY
})

function clientReturning(error: { message: string; code?: string } | null) {
  return {
    rpc: async () => ({ data: null, error }),
  } as unknown as SupabaseClient<Database>
}

const params = {
  id: "srv-1",
  workspaceId: "ws-1",
  name: "Server",
  url: "https://mcp.example.com",
  credentials: { headers: { Authorization: "Bearer x" } },
}

describe("upsertServerWithCredential → upsertFailureStatus", () => {
  test("a foreign server id (0039: 23505) is a 409, not a silent success", async () => {
    const result = await upsertServerWithCredential(
      clientReturning({
        message: "mcp_server_id_conflict: server id belongs to another user",
        code: "23505",
      }),
      params
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe("23505")
    expect(upsertFailureStatus(result)).toBe(409)
  })

  test("a foreign workspace (0039: P0002) is a 404", async () => {
    const result = await upsertServerWithCredential(
      clientReturning({ message: "workspace not found", code: "P0002" }),
      params
    )
    expect(upsertFailureStatus(result)).toBe(404)
  })

  test("other RPC failures stay 502; success is ok", async () => {
    const failed = await upsertServerWithCredential(
      clientReturning({ message: "boom", code: "XX000" }),
      params
    )
    expect(upsertFailureStatus(failed)).toBe(502)
    const ok = await upsertServerWithCredential(clientReturning(null), params)
    expect(ok).toEqual({ ok: true })
  })

  test("encryption key unset → 500", () => {
    expect(upsertFailureStatus({ error: "encryption_key_unset" })).toBe(500)
  })
})
