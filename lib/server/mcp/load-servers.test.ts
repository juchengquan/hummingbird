import { describe, expect, test } from "bun:test"

import { ChatRequestSchema } from "@/shared/api-schemas"

import { loadEffectiveMcpServers } from "./load-servers"

/**
 * Q48: the chat route passes the persona's `allowedMcpServerIds` to
 * `loadEffectiveMcpServers` (`app/api/chat/route.ts`). Absent → no
 * restriction; `[]` → no MCP; a list → only those servers. The same `allow`
 * set filters cloud rows and body servers; the body servers exercise it
 * here without a Supabase session (no `workspaceId` → no cloud query).
 * Literal public IPs keep the SSRF check off the network.
 */

const SERVERS = [
  { id: "a", name: "A", url: "https://93.184.216.34/mcp", transport: "http" as const },
  { id: "b", name: "B", url: "https://93.184.216.35/mcp", transport: "http" as const },
]

describe("loadEffectiveMcpServers — allowedServerIds (Q48)", () => {
  test("absent → every server", async () => {
    const out = await loadEffectiveMcpServers(undefined, SERVERS, {})
    expect(out.map((s) => s.id)).toEqual(["a", "b"])
    const none = await loadEffectiveMcpServers(undefined, SERVERS, { allowedServerIds: undefined })
    expect(none.map((s) => s.id)).toEqual(["a", "b"])
  })

  test("[] → no MCP", async () => {
    const out = await loadEffectiveMcpServers(undefined, SERVERS, { allowedServerIds: [] })
    expect(out).toEqual([])
  })

  test("a subset → only those", async () => {
    const out = await loadEffectiveMcpServers(undefined, SERVERS, { allowedServerIds: ["b"] })
    expect(out.map((s) => s.id)).toEqual(["b"])
  })
})

describe("ChatRequestSchema.allowedMcpServerIds", () => {
  const base = { messages: [{ role: "user", content: "hi" }] }

  test("kept when sent, including []", () => {
    expect(ChatRequestSchema.parse({ ...base, allowedMcpServerIds: ["a"] }).allowedMcpServerIds).toEqual([
      "a",
    ])
    expect(ChatRequestSchema.parse({ ...base, allowedMcpServerIds: [] }).allowedMcpServerIds).toEqual([])
  })

  test("absent stays absent (no restriction)", () => {
    expect(ChatRequestSchema.parse(base).allowedMcpServerIds).toBeUndefined()
  })
})
