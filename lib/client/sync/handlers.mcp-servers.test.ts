import { describe, expect, test } from "bun:test"
import type { McpServer } from "@/shared/types"
import { diffMcpServers } from "./handlers"

function make(id: string, overrides: Partial<McpServer> = {}): McpServer {
  return {
    id,
    workspaceId: "ws-1",
    name: `Server ${id}`,
    url: `https://mcp.example/${id}`,
    transport: "http",
    credentialMode: "cloud",
    enabled: true,
    createdAt: new Date("2026-05-23T00:00:00Z"),
    updatedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffMcpServers", () => {
  test("no ops when identical", () => {
    expect(diffMcpServers([make("a")], [make("a")])).toEqual([])
  })

  test("upsert for a new server with defaults", () => {
    const ops = diffMcpServers([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].target).toBe("mcp_servers")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.transport).toBe("http")
      expect(ops[0].row.credential_mode).toBe("cloud")
      expect(ops[0].row.enabled).toBe(true)
    }
  })

  test("flipping enabled triggers upsert", () => {
    const ops = diffMcpServers(
      [make("a")],
      [
        make("a", {
          enabled: false,
          updatedAt: new Date("2026-05-23T02:00:00Z"),
        }),
      ]
    )
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") expect(ops[0].row.enabled).toBe(false)
  })

  test("soft-delete tombstone (deletedAt flips on) emits upsert", () => {
    const ops = diffMcpServers(
      [make("a")],
      [
        make("a", {
          deletedAt: new Date("2026-05-23T02:00:00Z"),
          updatedAt: new Date("2026-05-23T02:00:00Z"),
        }),
      ]
    )
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.deleted_at).toBeTypeOf("string")
    }
  })

  test("hard delete when the server vanishes outright", () => {
    const ops = diffMcpServers([make("a"), make("b")], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
  })
})
