import "server-only"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import type {
  McpCapabilities,
  McpServer,
  McpToolDescriptor,
  McpResourceDescriptor,
} from "@/shared/types"
import type { McpCredentials } from "@/shared/mcp/credentials"

/**
 * Thin wrapper around `@modelcontextprotocol/sdk` exposing the three
 * operations Hummingbird uses today. Streamable HTTP transport only —
 * stdio support is deferred per `docs/PLAN-mcp-integration.md`.
 *
 * Each call opens a fresh session (connect → operation → close). Cheap
 * enough for v1; if call volume grows we can pool clients per
 * (serverId, fingerprint).
 */

function buildClient() {
  return new Client({
    name: "hummingbird",
    version: "0.1.0",
  })
}

function buildTransport(server: McpServer, credentials?: McpCredentials) {
  const url = new URL(server.url)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(credentials?.headers ?? {})) {
    // MCP server expects raw header names — preserve case the caller
    // supplied, fall back to lowercase canonical form for `authorization`.
    headers[k] = v
  }
  return new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers,
    },
  })
}

async function withSession<T>(
  server: McpServer,
  credentials: McpCredentials | undefined,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = buildClient()
  const transport = buildTransport(server, credentials)
  try {
    await client.connect(transport)
    return await fn(client)
  } finally {
    // Best-effort cleanup. SDK may have already closed the transport on
    // error; swallow secondary failures so we don't mask the real one.
    try {
      await client.close()
    } catch {
      // ignore
    }
  }
}

/**
 * Run the MCP discovery handshake and return the server's reported
 * capabilities. Used by the workspace settings UI when adding /
 * refreshing a server, and by the chat route when the cached entry
 * is older than the TTL.
 */
export async function discover(
  server: McpServer,
  credentials: McpCredentials | undefined
): Promise<McpCapabilities> {
  return withSession(server, credentials, async (client) => {
    const out: McpCapabilities = {}
    const serverCaps = client.getServerCapabilities() ?? {}

    if (serverCaps.tools) {
      const res = await client.listTools()
      out.tools = res.tools.map(
        (t): McpToolDescriptor => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })
      )
    }
    if (serverCaps.resources) {
      const res = await client.listResources()
      out.resources = res.resources.map(
        (r): McpResourceDescriptor => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        })
      )
    }
    if (serverCaps.prompts) {
      try {
        const res = await client.listPrompts()
        out.prompts = res.prompts.map((p) => ({
          name: p.name,
          description: p.description,
        }))
      } catch {
        // Prompts are optional; tolerate servers that advertise them
        // in capabilities but error on listPrompts (some early
        // implementations).
      }
    }
    return out
  })
}

/**
 * Invoke a tool on the MCP server. Caller provides the tool name and
 * input matching the tool's JSON schema; we forward verbatim.
 *
 * Returns the unwrapped result content. MCP servers may return
 * `content` as text/image/embedded resources; we concatenate text
 * parts and return as a string for the chat route's tool-call result.
 */
export async function callTool(
  server: McpServer,
  credentials: McpCredentials | undefined,
  toolName: string,
  input: unknown
): Promise<{ text: string; isError: boolean }> {
  return withSession(server, credentials, async (client) => {
    const res = await client.callTool({
      name: toolName,
      arguments: (input ?? {}) as Record<string, unknown>,
    })
    const parts: string[] = []
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>
    for (const part of content) {
      if (part.type === "text" && typeof part.text === "string") {
        parts.push(part.text)
      } else if (part.type === "resource" && "resource" in part) {
        const resource = (part as { resource?: { text?: string } }).resource
        if (resource?.text) parts.push(resource.text)
      }
    }
    return {
      text: parts.join("\n\n"),
      isError: Boolean(res.isError),
    }
  })
}

/**
 * Read a resource by URI. Returns the resource's text content (or a
 * placeholder for binary). Used by the chat-route resource-injection
 * path in Stage 3.
 */
export async function readResource(
  server: McpServer,
  credentials: McpCredentials | undefined,
  uri: string
): Promise<{ text?: string; mimeType?: string }> {
  return withSession(server, credentials, async (client) => {
    const res = await client.readResource({ uri })
    const first = (res.contents ?? [])[0] as
      | { text?: string; mimeType?: string }
      | undefined
    return {
      text: first?.text,
      mimeType: first?.mimeType,
    }
  })
}
