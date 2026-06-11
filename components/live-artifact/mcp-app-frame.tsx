"use client"

import { LiveArtifactFrameWithStatus } from "@/components/live-artifact/live-artifact-frame"
import { useStore } from "@/client/hooks/use-store"
import type { McpAppPart } from "@/shared/types"

/**
 * Renders an MCP App panel — bundled HTML read from an MCP tool's
 * `ui://` resource — in the same sandboxed iframe shell as live
 * artifacts (`sandbox="allow-scripts"`, null origin, CSP
 * `connect-src 'none'`). The HTML is untrusted server output, so the
 * sandbox is the security boundary.
 *
 * Phase 1 is **read-only**: the panel renders, but there's no
 * postMessage tool-call bridge yet (a button inside can't call the tool
 * back). Minimal theming only — a `color-scheme` hint derived from the
 * app theme. See `docs/PLAN-mcp-apps.md`.
 */
export function McpAppFrame({ app }: { app: McpAppPart }) {
  const theme = useStore((s) => s.theme)
  const scheme = theme === "light" ? "light" : "dark"
  // Prepend a minimal color-scheme hint so the panel's default form
  // controls / scrollbars match the host theme. Kept tiny on purpose —
  // full token passing is deferred.
  const themed = `<meta name="color-scheme" content="dark light" /><style>:root{color-scheme:${scheme}}</style>\n${app.html}`
  return (
    <div className="my-2 overflow-hidden rounded-md border border-[var(--border)]">
      <LiveArtifactFrameWithStatus shell="html" content={themed} />
    </div>
  )
}
