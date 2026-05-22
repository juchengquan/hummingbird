"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import { buildShell, IFRAME_MESSAGE_NS } from "@/client/live-artifact/iframe-shell"
import type { ShellKind } from "@/client/live-artifact/detect"
import { cn } from "@/shared/utils"

/**
 * Renders an artifact inside a sandboxed iframe.
 *
 * Sandbox flags: `allow-scripts` ONLY. Crucially no `allow-same-origin`
 * — the iframe runs at a null origin so it can't read our cookies,
 * localStorage, or make same-origin fetches against our API routes.
 * The iframe's own CSP meta tag (injected by `iframe-shell.ts`)
 * additionally blocks `connect-src` to keep generated `fetch()` calls
 * from talking to attacker-controlled hosts.
 *
 * Errors thrown inside the iframe (synchronous + unhandled-rejection)
 * post a `{ type: 'error', message }` message up via the bridge in
 * `iframe-shell.ts`. The parent matches `event.source` against this
 * iframe's contentWindow so cross-frame chatter from unrelated frames
 * doesn't leak in.
 *
 * `key`-based remount on `refreshKey` change is the cheapest reload —
 * cleaner than reaching into the iframe and assigning srcdoc.
 */

export interface LiveArtifactFrameProps {
  shell: ShellKind
  content: string
  /** Bump to force a fresh render (toolbar "Refresh" button). */
  refreshKey?: number
  className?: string
  /** Notified once the iframe's `DOMContentLoaded` fires. Lets the
   *  parent clear loading UI even when the artifact takes time to
   *  bootstrap (e.g. waiting for the React CDN bundles). */
  onReady?: () => void
  /** Notified when the iframe's bridge posts an error. Multiple errors
   *  per render are possible (uncaught + unhandledrejection); the
   *  parent usually shows the most recent. */
  onError?: (message: string) => void
}

export function LiveArtifactFrame({
  shell,
  content,
  refreshKey = 0,
  className,
  onReady,
  onError,
}: LiveArtifactFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const srcDoc = useMemo(() => buildShell(shell, content), [shell, content])

  useEffect(() => {
    function handle(e: MessageEvent) {
      // Filter strictly: same iframe element, same NS, expected shape.
      if (!iframeRef.current) return
      if (e.source !== iframeRef.current.contentWindow) return
      const data = e.data as unknown
      if (!data || typeof data !== "object") return
      const msg = data as { ns?: string; type?: string; message?: string }
      if (msg.ns !== IFRAME_MESSAGE_NS) return
      if (msg.type === "ready") onReady?.()
      else if (msg.type === "error") onError?.(msg.message ?? "Script error")
    }
    window.addEventListener("message", handle)
    return () => window.removeEventListener("message", handle)
  }, [onReady, onError])

  return (
    <iframe
      ref={iframeRef}
      // Refresh by remounting — `key` is the smallest change that
      // gets the browser to re-evaluate `srcDoc`.
      key={refreshKey}
      title="Live artifact"
      // CRITICAL: do NOT add `allow-same-origin`. The null origin is
      // what protects parent cookies / storage from the generated
      // script. See PLAN-live-artifacts.md → Sandbox security model.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      // `loading="lazy"` so inline previews scrolled out of view
      // don't keep their iframes hot. Side-panel use cases are
      // always visible so the attr is a no-op there.
      loading="lazy"
      srcDoc={srcDoc}
      className={cn("w-full h-full border-0 bg-white", className)}
    />
  )
}

/** Tiny stateful wrapper: shows a "render error" surface above the
 *  iframe when the in-iframe error bridge fires. The iframe itself
 *  stays mounted so the user can refresh once they've fixed the
 *  artifact. */
export function LiveArtifactFrameWithStatus({
  shell,
  content,
  refreshKey,
  className,
}: Omit<LiveArtifactFrameProps, "onReady" | "onError">) {
  const [error, setError] = useState<string | null>(null)

  // Clear stale errors on a deliberate refresh.
  useEffect(() => {
    setError(null)
  }, [refreshKey, content, shell])

  return (
    <div className={cn("relative flex flex-col h-full", className)}>
      <LiveArtifactFrame
        shell={shell}
        content={content}
        refreshKey={refreshKey}
        onError={setError}
      />
      {error && (
        <div className="absolute bottom-0 inset-x-0 px-3 py-2 text-xs bg-[var(--destructive)]/10 text-[var(--destructive)] border-t border-[var(--destructive)]/40 truncate" title={error}>
          <span className="font-medium">Render error:</span> {error}
        </div>
      )}
    </div>
  )
}
