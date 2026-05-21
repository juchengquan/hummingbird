import "server-only"

import { jsonSchema, tool } from "ai"

import { callTool } from "@/server/mcp/client"
import type { McpCredentials } from "@/shared/mcp/credentials"
import type { McpServer, McpToolDescriptor } from "@/shared/types"

/**
 * Build an AI SDK `tool` from a single MCP tool descriptor. Tool name
 * gets a `mcp__{serverId}__{toolName}` prefix so the tool-call log
 * shows provenance and tools from different servers can share a
 * name without colliding.
 *
 * `execute` calls the MCP server via the in-process client wrapper
 * (not over HTTP — direct function call to `@/server/mcp/client`).
 * Errors propagate up to the AI SDK, which marks the tool call as
 * failed and lets the model decide whether to retry or move on.
 */
export function buildMcpTool(
  server: Pick<McpServer, "id" | "name" | "url" | "transport">,
  descriptor: McpToolDescriptor,
  credentials: McpCredentials | undefined
) {
  // MCP tools advertise a JSON-Schema `inputSchema`. The AI SDK accepts
  // it via `jsonSchema()`. Some servers omit `inputSchema` entirely
  // for parameter-less tools — substitute an empty-object schema so
  // the SDK doesn't reject the tool registration.
  const schema =
    descriptor.inputSchema && typeof descriptor.inputSchema === "object"
      ? (descriptor.inputSchema as Parameters<typeof jsonSchema>[0])
      : ({ type: "object", properties: {} } as Parameters<typeof jsonSchema>[0])

  const fullServer = toFullServer(server)

  return tool({
    description:
      descriptor.description ??
      `MCP tool from "${server.name}" (no description provided).`,
    inputSchema: jsonSchema(schema),
    execute: async (input: unknown) => {
      const { text, isError } = await callTool(
        fullServer,
        credentials,
        descriptor.name,
        input
      )
      if (isError) {
        // The SDK convention is to throw — turns into an error tool
        // result the model can see.
        throw new Error(text || `MCP tool "${descriptor.name}" returned an error`)
      }
      return text
    },
  })
}

/** Stable name for a tool exposed by an MCP server. */
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`
}

function toFullServer(
  partial: Pick<McpServer, "id" | "name" | "url" | "transport">
): McpServer {
  return {
    ...partial,
    workspaceId: "",
    credentialMode: "local",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}
