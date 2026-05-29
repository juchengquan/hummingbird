import { describe, expect, test } from "bun:test"
import type { McpResourceBinding } from "@/shared/types"
import { diffMcpResourceBindings } from "./handlers"

function make(
  id: string,
  overrides: Partial<McpResourceBinding> = {}
): McpResourceBinding {
  return {
    id,
    workspaceId: "ws-1",
    resourceId: `res-${id}`,
    addedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffMcpResourceBindings", () => {
  test("no ops when identical", () => {
    expect(diffMcpResourceBindings([make("a")], [make("a")])).toEqual([])
  })

  test("upsert for a new workspace binding", () => {
    const ops = diffMcpResourceBindings([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].target).toBe("mcp_resource_bindings")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.workspace_id).toBe("ws-1")
      expect(ops[0].row.resource_id).toBe("res-a")
    }
  })

  test("hard delete when binding is removed", () => {
    const ops = diffMcpResourceBindings(
      [make("a"), make("b")],
      [make("a")]
    )
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
  })
})
