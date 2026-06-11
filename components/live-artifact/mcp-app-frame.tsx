"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import { apiClient } from "@/client/api-client"
import { useStore } from "@/client/hooks/use-store"
import { buildShell, IFRAME_MESSAGE_NS } from "@/client/live-artifact/iframe-shell"
import {
  mcpAppToolResult,
  parseMcpAppToolCall,
} from "@/client/live-artifact/mcp-app-bridge"
import { getLocalCred, serializeCredentialHeader } from "@/client/mcp/local-creds"
import type { McpAppPart } from "@/shared/types"

/**
 * Renders an MCP App panel — bundled HTML read from an MCP tool's
 * `ui://` resource — in the same sandboxed iframe shell as live
 * artifacts (`sandbox="allow-scripts"`, null origin, CSP
 * `connect-src 'none'`). The HTML is untrusted server output, so the
 * sandbox is the security boundary.
 *
 * Phase 2 adds the **tool-call bridge**: the panel can post a
 * `{ ns: "mcp-app", type: "tool-call", ... }` message; this component
 * forwards it to the producing MCP server via the `/api/mcp/:id/call`
 * proxy and posts the result back. Hard guards: same-server only (the
 * panel can only call tools on the server that produced it), a per-app
 * call cap, and the strict `event.source` filter. See
 * `docs/PLAN-mcp-apps.md`.
 */

/** Cap on tool calls a single panel can make — a runaway widget can't
 *  hammer the server. */
const MAX_CALLS_PER_APP = 50

export function McpAppFrame({ app }: { app: McpAppPart }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const theme = useStore((s) => s.theme)
  const mcpServers = useStore((s) => s.mcpServers)
  const [scriptError, setScriptError] = useState<string | null>(null)
  const callCountRef = useRef(0)

  const scheme = theme === "light" ? "light" : "dark"
  const srcDoc = useMemo(() => {
    // Minimal theming — a color-scheme hint so default controls /
    // scrollbars match the host. Full token passing is deferred.
    const themed = `<meta name="color-scheme" content="dark light" /><style>:root{color-scheme:${scheme}}</style>\n${app.html}`
    return buildShell("html", themed)
  }, [app.html, scheme])

  useEffect(() => {
    async function handle(e: MessageEvent) {
      // Strict source filter — only this iframe's window may talk to us.
      if (!iframeRef.current) return
      if (e.source !== iframeRef.current.contentWindow) return
      const data = e.data as unknown
      if (!data || typeof data !== "object") return

      // live-artifact ns: the shell's ready/error bridge.
      const base = data as { ns?: string; type?: string; message?: string }
      if (base.ns === IFRAME_MESSAGE_NS) {
        if (base.type === "error") {
          setScriptError(base.message ?? "Script error")
        }
        return
      }

      // mcp-app ns: the tool-call bridge.
      const call = parseMcpAppToolCall(data)
      if (!call) return
      const reply = (payload: { ok: boolean; result?: unknown; error?: string }) =>
        iframeRef.current?.contentWindow?.postMessage(
          mcpAppToolResult(call.callId, payload),
          "*"
        )

      callCountRef.current += 1
      if (callCountRef.current > MAX_CALLS_PER_APP) {
        reply({ ok: false, error: "Too many tool calls from this panel" })
        return
      }

      // Same-server only — resolve the *producing* server by id.
      const server = mcpServers.find(
        (s) => s.id === app.serverId && !s.deletedAt
      )
      if (!server) {
        reply({ ok: false, error: "MCP server not available" })
        return
      }
      const cred = getLocalCred(server.id)
      try {
        const result = await apiClient.mcp.proxy(
          "call",
          {
            server: {
              id: server.id,
              name: server.name,
              url: server.url,
              transport: server.transport,
            },
            tool: call.name,
            input: call.args,
          },
          cred && cred.type !== "none"
            ? { credentialHeader: serializeCredentialHeader(cred) }
            : undefined
        )
        if (result.ok) {
          reply({
            ok: true,
            result: (result.data as { result?: unknown }).result,
          })
        } else {
          reply({ ok: false, error: result.error.message ?? "Tool call failed" })
        }
      } catch (err) {
        reply({
          ok: false,
          error: err instanceof Error ? err.message : "Tool call failed",
        })
      }
    }
    window.addEventListener("message", handle)
    return () => window.removeEventListener("message", handle)
  }, [app.serverId, mcpServers])

  return (
    <div className="my-2 overflow-hidden rounded-md border border-[var(--border)]">
      {scriptError && (
        <div className="px-3 py-1.5 text-[11px] text-[var(--destructive)] bg-[var(--destructive)]/5 border-b border-[var(--border)]">
          Panel error: {scriptError}
        </div>
      )}
      <iframe
        ref={iframeRef}
        title="MCP App"
        // CRITICAL: no `allow-same-origin` — the null origin protects
        // parent cookies / storage from the untrusted panel script.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        srcDoc={srcDoc}
        className="w-full h-[420px] border-0 bg-white"
      />
    </div>
  )
}
