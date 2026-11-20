import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { discover } from "./client"
import { loadEffectiveMcpServers } from "./load-servers"
import {
  McpUrlBlockedError,
  mcpOutboundPolicy,
  sanitizeCredentialHeaders,
  validateMcpServerUrl,
} from "./outbound"

const ENV_KEY = "MCP_ALLOW_PRIVATE_HOSTS"
let saved: string | undefined

beforeEach(() => {
  saved = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = saved
})

describe("validateMcpServerUrl", () => {
  test("private hosts rejected by default", async () => {
    for (const url of [
      "http://127.0.0.1:8080/mcp",
      "http://localhost:8080/mcp",
      "http://10.0.0.2/mcp",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      const r = await validateMcpServerUrl(url)
      expect(r.ok).toBe(false)
    }
  })

  test("MCP_ALLOW_PRIVATE_HOSTS=true allows localhost", async () => {
    process.env[ENV_KEY] = "true"
    expect(mcpOutboundPolicy()).toEqual({ allowPrivateHosts: true })
    expect((await validateMcpServerUrl("http://127.0.0.1:8080/mcp")).ok).toBe(true)
    expect((await validateMcpServerUrl("http://localhost:8080/mcp")).ok).toBe(true)
  })

  test("opt-in still blocks cloud metadata", async () => {
    process.env[ENV_KEY] = "true"
    const r = await validateMcpServerUrl("http://169.254.169.254/latest/meta-data/")
    expect(r.ok).toBe(false)
  })

  test("only the literal 'true' opts in", async () => {
    process.env[ENV_KEY] = "1"
    expect(mcpOutboundPolicy()).toEqual({ allowPrivateHosts: false })
  })
})

describe("MCP client wrapper refuses blocked URLs before connecting", () => {
  test("discover() on a loopback URL throws McpUrlBlockedError", async () => {
    const server = { id: "s1", name: "s", url: "http://127.0.0.1:1/mcp", transport: "http" as const }
    await expect(discover(server, undefined)).rejects.toBeInstanceOf(McpUrlBlockedError)
  })
})

describe("loadEffectiveMcpServers drops blocked URLs", () => {
  test("local-mode body servers with private URLs are filtered out", async () => {
    const out = await loadEffectiveMcpServers(undefined, [
      { id: "bad", name: "bad", url: "http://169.254.169.254/", transport: "http" },
      { id: "bad2", name: "bad2", url: "http://localhost:3000/mcp", transport: "http" },
      { id: "good", name: "good", url: "https://93.184.216.34/mcp", transport: "http" },
    ])
    expect(out.map((s) => s.id)).toEqual(["good"])
  })

  test("opt-in keeps localhost servers", async () => {
    process.env[ENV_KEY] = "true"
    const out = await loadEffectiveMcpServers(undefined, [
      { id: "local", name: "local", url: "http://127.0.0.1:3001/mcp", transport: "http" },
    ])
    expect(out.map((s) => s.id)).toEqual(["local"])
  })
})

describe("sanitizeCredentialHeaders", () => {
  test("keeps ordinary auth headers, preserving case", () => {
    expect(
      sanitizeCredentialHeaders({ Authorization: "Bearer x", "x-api-key": "k" })
    ).toEqual({ Authorization: "Bearer x", "x-api-key": "k" })
  })

  test("drops hop-by-hop, Host, proxy, forwarding and transport-owned headers", () => {
    const out = sanitizeCredentialHeaders({
      Host: "169.254.169.254",
      Connection: "close",
      "Transfer-Encoding": "chunked",
      "Content-Length": "0",
      Upgrade: "websocket",
      "Proxy-Authorization": "x",
      "X-Forwarded-For": "127.0.0.1",
      "Mcp-Session-Id": "s",
      "Content-Type": "text/plain",
      authorization: "Bearer ok",
    })
    expect(out).toEqual({ authorization: "Bearer ok" })
  })

  test("drops malformed names and CRLF-bearing values", () => {
    expect(
      sanitizeCredentialHeaders({
        "bad name": "x",
        "x-a": "ok\r\nHost: evil",
        "x-b": 42 as unknown as string,
        "x-ok": "fine",
      })
    ).toEqual({ "x-ok": "fine" })
  })

  test("tolerates missing / non-object input", () => {
    expect(sanitizeCredentialHeaders(undefined)).toEqual({})
  })
})
