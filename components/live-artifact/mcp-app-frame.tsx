"use client"

import { RefreshCw } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { apiClient } from "@/client/api-client"
import { useStore } from "@/client/hooks/use-store"
import { buildShell, IFRAME_MESSAGE_NS } from "@/client/live-artifact/iframe-shell"
import {
  mcpAppToolCallDenial,
  mcpAppToolResult,
  parseMcpAppToolCall,
} from "@/client/live-artifact/mcp-app-bridge"
import { getLocalCred, serializeCredentialHeader } from "@/client/mcp/local-creds"
import { cn } from "@/shared/utils"
import type { McpAppPart } from "@/shared/types"

import { SandboxedFrame } from "./sandboxed-frame"

/**
 * Renders an MCP App panel — bundled HTML read from an MCP tool's
 * `ui://` resource — in the same sandboxed iframe as live artifacts
 * (`SandboxedFrame`: the `/sandbox/frame` shell, `sandbox="allow-scripts"`,
 * opaque origin, CSP `connect-src 'none'`). The HTML is untrusted
 * server output, so the sandbox is the security boundary.
 *
 * Phase 2 adds the **tool-call bridge**: the panel can post a
 * `{ ns: "mcp-app", type: "tool-call", ... }` message; this component
 * forwards it to the producing MCP server via the `/api/mcp/:id/call`
 * proxy and posts the result back. Hard guards: same-server only (the
 * panel can only call tools on the server that produced it), the
 * server's `enabled` switch and `requiresApproval` policy
 * (`mcpAppToolCallDenial`), a per-app call cap, and the strict
 * `event.source` filter.
 *
 * Navigation: a panel that navigates itself (a link, `location = …`)
 * keeps the same `contentWindow`, so it would still pass the
 * `event.source` filter — and whatever page it landed on would inherit
 * the tool-call bridge. `SandboxedFrame` reports the navigation
 * (`onNavigatedAway`); from then on this component ignores the frame's
 * messages and shows a "navigated away — reload" plate instead.
 *
 * Phase 3 adds the **refresh affordance** (re-read the `ui://`
 * resource through the same proxy `read` action and swap the
 * stored HTML) and the explicit **"UI too large" stub** that
 * renders in place of the iframe when the server flagged the read
 * as truncated. See `docs/PLAN-mcp-apps.md`.
 */

/** Cap on tool calls a single panel can make — a runaway widget can't
 *  hammer the server. */
const MAX_CALLS_PER_APP = 50

export function McpAppFrame({
  app,
  messageId,
}: {
  app: McpAppPart
  /** Owning message id, used by the refresh button to write the
   *  re-read HTML back through `replaceMessageMcpAppHtml`. */
  messageId: string
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const theme = useStore((s) => s.theme)
  const mcpServers = useStore((s) => s.mcpServers)
  const replaceMessageMcpAppHtml = useStore(
    (s) => s.replaceMessageMcpAppHtml,
  )
  const [scriptError, setScriptError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const callCountRef = useRef(0)
  // Set synchronously by `SandboxedFrame` the moment the rendered panel
  // navigates away; read by the bridge handler before anything else.
  const navigatedAwayRef = useRef(false)
  const [navigatedAway, setNavigatedAway] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const handleNavigatedAway = useCallback(() => {
    navigatedAwayRef.current = true
    setNavigatedAway(true)
  }, [])
  const reloadPanel = useCallback(() => {
    // The fresh frame mounts with a new navigation nonce; only then is
    // its bridge trusted again.
    navigatedAwayRef.current = false
    callCountRef.current = 0
    setScriptError(null)
    setNavigatedAway(false)
    setReloadKey((k) => k + 1)
  }, [])

  const scheme = theme === "light" ? "light" : "dark"
  const html = useMemo(() => {
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
      // Not the panel we rendered any more — no bridge, no error relay.
      if (navigatedAwayRef.current) return
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
      const reply = (payload: { ok: boolean; result?: unknown; error?: string }) => {
        // The panel may have navigated away while the call was in
        // flight: never hand the result to whatever loaded since.
        if (navigatedAwayRef.current) return
        iframeRef.current?.contentWindow?.postMessage(
          mcpAppToolResult(call.callId, payload),
          "*"
        )
      }

      callCountRef.current += 1
      if (callCountRef.current > MAX_CALLS_PER_APP) {
        reply({ ok: false, error: "Too many tool calls from this panel" })
        return
      }

      // Same-server only — resolve the *producing* server by id, then
      // enforce its `enabled` switch and `requiresApproval` policy
      // (re-read on every call, so toggling either takes effect at once).
      const server = mcpServers.find(
        (s) => s.id === app.serverId && !s.deletedAt
      )
      const denial = mcpAppToolCallDenial(server)
      if (denial !== null || !server) {
        reply({ ok: false, error: denial ?? "MCP server not available" })
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

  // Refresh: re-read the panel's `ui://` resource through the same
  // proxy `read` action and swap the stored HTML. Server must
  // currently be reachable (refresh is intentionally a live action,
  // not a replay of cached HTML). `resourceUri` is absent on parts
  // emitted before phase 3 — the button hides itself in that case.
  const canRefresh = Boolean(app.resourceUri)
  async function handleRefresh() {
    if (!app.resourceUri) return
    const server = mcpServers.find(
      (s) => s.id === app.serverId && !s.deletedAt,
    )
    if (!server) {
      setRefreshError("MCP server not available")
      return
    }
    if (!server.enabled) {
      setRefreshError("MCP server is disabled")
      return
    }
    setRefreshing(true)
    setRefreshError(null)
    try {
      const cred = getLocalCred(server.id)
      const result = await apiClient.mcp.proxy(
        "read",
        {
          server: {
            id: server.id,
            name: server.name,
            url: server.url,
            transport: server.transport,
          },
          uri: app.resourceUri,
        },
        cred && cred.type !== "none"
          ? { credentialHeader: serializeCredentialHeader(cred) }
          : undefined,
      )
      if (!result.ok) {
        setRefreshError(result.error.message ?? "Refresh failed")
        return
      }
      const html = ((result.data as { result?: { text?: unknown } })
        .result?.text)
      if (typeof html !== "string" || html.length === 0) {
        setRefreshError("Empty resource")
        return
      }
      // Reset the panel error / script error on a successful swap so
      // the badge from a prior turn doesn't stick to the new render.
      replaceMessageMcpAppHtml(messageId, app.id, html)
      setScriptError(null)
      // Fresh HTML → fresh frame navigation (new nonce): trust it again.
      navigatedAwayRef.current = false
      setNavigatedAway(false)
    } catch (err) {
      setRefreshError(
        err instanceof Error ? err.message : "Refresh failed",
      )
    } finally {
      setRefreshing(false)
    }
  }

  // Truncation stub — the server flagged the read body as oversized,
  // so render an explicit "UI too large" plate instead of the
  // sentinel HTML. Same border / refresh button as a normal panel so
  // the user can re-read after the resource shrinks on the server
  // side.
  if (app.truncated) {
    return (
      <McpAppShell
        canRefresh={canRefresh}
        refreshing={refreshing}
        refreshError={refreshError}
        onRefresh={handleRefresh}
      >
        <div className="px-4 py-6 text-[13px] text-[var(--muted-foreground)] text-center">
          <p className="font-medium text-[var(--foreground)] mb-1">
            UI too large to render
          </p>
          <p className="text-[11px]">
            The MCP server returned a panel over the 512 KB limit.
            Run the tool in raw mode to see the output, or refresh
            once the resource shrinks.
          </p>
        </div>
      </McpAppShell>
    )
  }

  return (
    <McpAppShell
      canRefresh={canRefresh}
      refreshing={refreshing}
      refreshError={refreshError}
      onRefresh={handleRefresh}
    >
      {scriptError && (
        <div className="px-3 py-1.5 text-[11px] text-[var(--destructive)] bg-[var(--destructive)]/5 border-b border-[var(--border)]">
          Panel error: {scriptError}
        </div>
      )}
      {navigatedAway ? (
        <div className="flex h-[420px] flex-col items-center justify-center gap-2 px-4 text-center text-[13px] text-[var(--muted-foreground)]">
          <p className="font-medium text-[var(--foreground)]">
            Panel navigated away
          </p>
          <p className="text-[11px]">
            The panel left the page its server provided, so its tool access
            was cut off. Reload it to start over.
          </p>
          <button
            type="button"
            onClick={reloadPanel}
            className={cn(
              "inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[11px]",
              "text-[var(--foreground)] hover:bg-[var(--accent)] transition-colors",
            )}
          >
            <RefreshCw size={11} />
            Reload panel
          </button>
        </div>
      ) : (
        <SandboxedFrame
          key={reloadKey}
          frameRef={iframeRef}
          html={html}
          title="MCP App"
          className="w-full h-[420px] border-0 bg-white"
          onNavigatedAway={handleNavigatedAway}
        />
      )}
    </McpAppShell>
  )
}

/** Shared border + optional refresh-button header for both the
 *  normal-panel and the truncation-stub branches above. Kept inline
 *  rather than a separate file because it's not reused elsewhere. */
function McpAppShell({
  canRefresh,
  refreshing,
  refreshError,
  onRefresh,
  children,
}: {
  canRefresh: boolean
  refreshing: boolean
  refreshError: string | null
  onRefresh: () => void
  children: React.ReactNode
}) {
  return (
    <div className="my-2 overflow-hidden rounded-md border border-[var(--border)]">
      {canRefresh && (
        <div className="flex items-center justify-end gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--muted)]/30">
          {refreshError && (
            <span
              className="text-[10px] text-[var(--destructive)] truncate"
              title={refreshError}
            >
              {refreshError}
            </span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]",
              "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
              "hover:bg-[var(--accent)] transition-colors",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            )}
            title="Re-read the ui:// resource from the producing MCP server"
            aria-label="Refresh MCP App panel"
          >
            <RefreshCw
              size={11}
              className={cn(refreshing && "animate-spin")}
            />
            <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
          </button>
        </div>
      )}
      {children}
    </div>
  )
}
