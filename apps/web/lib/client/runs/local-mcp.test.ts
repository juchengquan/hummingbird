/** `localMcpForRun` — the local MCP servers of a turn on runs and their
 *  credentials (wave 5b-D, Q42/Q45), and how `buildRunInput` places them. */

import { describe, expect, test } from "bun:test"

import type { McpCredentials } from "@/shared/mcp/credentials"
import type { McpServer } from "@/shared/types"

import { buildRunInput, LOCAL_MCP_STATE_KEY } from "./build-input"
import { localMcpForRun } from "./local-mcp"

const WS = "ws-1"
const SECRET = "Bearer sk-local-never-in-forwarded-props"

function server(id: string, over: Partial<McpServer> = {}): McpServer {
  return {
    id,
    workspaceId: WS,
    name: `Server ${id}`,
    url: `http://localhost:9/${id}`,
    transport: "http",
    credentialMode: "local",
    enabled: true,
    capabilities: {
      tools: [
        { name: "echo", description: "Echo", inputSchema: { type: "object" } },
        { name: "panel", uiResourceUri: "ui://x/panel" },
      ],
    },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }
}

const creds: Record<string, McpCredentials> = {
  a: { type: "bearer", headers: { Authorization: SECRET } },
  b: { type: "none" },
}
const getCred = (id: string) => creds[id]

describe("localMcpForRun", () => {
  test("the workspace's enabled local servers with tools, their tools (with uiResourceUri), and credentials", () => {
    const out = localMcpForRun(
      [
        server("a", { requiresApproval: true }),
        server("b"),
        server("cloud", { credentialMode: "cloud" }),
        server("off", { enabled: false }),
        server("gone", { deletedAt: new Date(1) }),
        server("other", { workspaceId: "ws-2" }),
        server("empty", { capabilities: { tools: [] } }),
      ],
      WS,
      getCred,
    )
    expect(out.localMcpServers).toEqual([
      {
        id: "a",
        name: "Server a",
        url: "http://localhost:9/a",
        transport: "http",
        requiresApproval: true,
        capabilities: {
          tools: [
            { name: "echo", description: "Echo", inputSchema: { type: "object" } },
            { name: "panel", uiResourceUri: "ui://x/panel" },
          ],
        },
      },
      expect.objectContaining({ id: "b" }),
    ])
    expect(out.localMcpServers?.[1]).not.toHaveProperty("requiresApproval")
    expect(out.localMcpCredentials).toEqual({
      a: { type: "bearer", headers: { Authorization: SECRET } },
      b: { type: "none" },
    })
  })

  test("the persona's allow-list: [] = none, absent = all", () => {
    const servers = [server("a"), server("b")]
    expect(localMcpForRun(servers, WS, getCred, { allowedMcpServerIds: [] })).toEqual({})
    const onlyB = localMcpForRun(servers, WS, getCred, { allowedMcpServerIds: ["b"] })
    expect(onlyB.localMcpServers?.map((s) => s.id)).toEqual(["b"])
    // A server outside the list sends no credential either.
    expect(onlyB.localMcpCredentials).toEqual({ b: { type: "none" } })
    expect(localMcpForRun(servers, WS, getCred).localMcpServers).toHaveLength(2)
  })

  test("a server without a stored credential goes without one", () => {
    const out = localMcpForRun([server("x")], WS, () => undefined)
    expect(out.localMcpServers?.map((s) => s.id)).toEqual(["x"])
    expect(out.localMcpCredentials).toBeUndefined()
  })

  test("clamped to the contract's limits", () => {
    const many = Array.from({ length: 12 }, (_, i) => server(`s${i}`))
    expect(localMcpForRun(many, WS, getCred).localMcpServers).toHaveLength(8)
    const tools = Array.from({ length: 70 }, (_, i) => ({ name: `t${i}` }))
    const big = localMcpForRun(
      [
        server("t", {
          capabilities: {
            tools: [
              { name: "x".repeat(201) },
              { name: "long", description: "d".repeat(3000), uiResourceUri: `ui://${"u".repeat(2001)}` },
              ...tools,
            ],
          },
        }),
      ],
      WS,
      () => ({
        headers: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`h${i}`, i === 0 ? "v".repeat(9000) : "v"])),
      }),
    )
    const t = big.localMcpServers![0].capabilities!.tools!
    expect(t).toHaveLength(64)
    expect(t[0]).toEqual({ name: "long", description: "d".repeat(2000) })
    const headers = big.localMcpCredentials!.t.headers!
    expect(Object.keys(headers)).toHaveLength(32)
    expect(headers).not.toHaveProperty("h0")
  })

  test("buildRunInput: servers in forwardedProps, credentials only in state", () => {
    const body = buildRunInput({
      conversationId: "c-1",
      history: [],
      ...localMcpForRun([server("a")], WS, getCred),
    })
    expect(body.forwardedProps?.localMcpServers?.map((s) => s.id)).toEqual(["a"])
    expect(JSON.stringify(body.forwardedProps)).not.toContain(SECRET)
    expect(body.state).toEqual({ [LOCAL_MCP_STATE_KEY]: { a: { type: "bearer", headers: { Authorization: SECRET } } } })
  })
})
