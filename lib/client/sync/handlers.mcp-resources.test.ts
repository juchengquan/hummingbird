import { describe, expect, test } from "bun:test"
import type { McpResource } from "@/shared/types"
import { diffMcpResources } from "./handlers"

function make(id: string, overrides: Partial<McpResource> = {}): McpResource {
  return {
    id,
    workspaceId: "ws-1",
    serverId: "srv-1",
    uri: `mcp://srv/${id}`,
    name: `Resource ${id}`,
    addedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffMcpResources", () => {
  test("no ops when identical", () => {
    expect(diffMcpResources([make("a")], [make("a")])).toEqual([])
  })

  test("upsert for a new resource", () => {
    const ops = diffMcpResources([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].target).toBe("mcp_resources")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.server_id).toBe("srv-1")
      expect(ops[0].row.uri).toBe("mcp://srv/a")
    }
  })

  test("soft-delete tombstone", () => {
    const ops = diffMcpResources(
      [make("a")],
      [make("a", { deletedAt: new Date("2026-05-23T02:00:00Z") })]
    )
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.deleted_at).toBeTypeOf("string")
    }
  })

  test("hard delete when a resource vanishes", () => {
    const ops = diffMcpResources([make("a"), make("b")], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
  })
})
