/**
 * `upsertServerWithCredentials` carries the RPC's SQLSTATE so the
 * `/v1/mcp/server` route can map 0039's foreign-id / foreign-workspace
 * errors to 409 / 404 (parity with Next's `upsertFailureStatus`).
 */
import { describe, test, expect } from "bun:test"
import type { Sql } from "postgres"

import { upsertServerWithCredentials } from "../src/mcp"

function sqlThrowing(err: unknown): Sql {
  return {
    begin: async () => {
      throw err
    },
  } as unknown as Sql
}

const args = {
  userId: "00000000-0000-4000-8000-000000000001",
  serverId: "00000000-0000-4000-8000-000000000002",
  workspaceId: "00000000-0000-4000-8000-000000000003",
  name: "Server",
  url: "https://mcp.example.com",
  credentials: { headers: { Authorization: "Bearer x" } },
  encryptionKey: "0123456789abcdef0123456789abcdef",
}

describe("upsertServerWithCredentials SQLSTATE", () => {
  test("23505 (foreign server id) is surfaced as code", async () => {
    const err = Object.assign(new Error("mcp_server_id_conflict"), { code: "23505" })
    const r = await upsertServerWithCredentials(sqlThrowing(err), args)
    expect(r).toEqual({ ok: false, error: "mcp_server_id_conflict", code: "23505" })
  })

  test("P0002 (foreign workspace) is surfaced as code", async () => {
    const err = Object.assign(new Error("workspace not found"), { code: "P0002" })
    const r = await upsertServerWithCredentials(sqlThrowing(err), args)
    expect(r.code).toBe("P0002")
  })

  test("errors without a code stay codeless (→ 502 in the route)", async () => {
    const r = await upsertServerWithCredentials(sqlThrowing(new Error("boom")), args)
    expect(r).toEqual({ ok: false, error: "boom" })
  })
})
