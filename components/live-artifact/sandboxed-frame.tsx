"use client"

import { useLayoutEffect, useRef, type RefObject } from "react"

import {
  isShellReadyMessage,
  renderMessage,
  SANDBOX_FRAME_PATH,
} from "@/shared/sandbox-frame"

/**
 * The one iframe element both live artifacts and MCP apps render
 * untrusted HTML in. Loads the sandbox frame shell (`/sandbox/frame`,
 * which carries its own CSP — see `@/server/security/sandbox-frame`)
 * and posts `html` into it once the shell says it's ready. Protocol:
 * `@/shared/sandbox-frame`.
 *
 * Why not `srcdoc`: a `srcdoc` document inherits the app's CSP, which
 * blocks every artifact script once `CSP_MODE=enforce`.
 *
 * Updates: the shell accepts one render per navigation, so a new `html`
 * (or a bumped `reloadKey`) re-navigates the frame and the handshake
 * runs again — the same full reload a `srcdoc` change caused. If the
 * shell hasn't asked for its HTML yet, nothing reloads: the pending
 * handshake simply picks up the newest `html`.
 *
 * Callers own their message protocols (`live-artifact`, `mcp-app`) via
 * `frameRef` and must keep filtering on
 * `event.source === frameRef.current?.contentWindow`.
 */
export function SandboxedFrame({
  html,
  reloadKey = 0,
  title,
  className,
  frameRef,
}: {
  html: string
  /** Bump to re-render the same `html` from scratch. */
  reloadKey?: number
  title: string
  className?: string
  frameRef?: RefObject<HTMLIFrameElement | null>
}) {
  const localRef = useRef<HTMLIFrameElement | null>(null)
  const ref = frameRef ?? localRef
  /** Has the frame's current document already consumed a render? */
  const renderedRef = useRef(false)

  // Layout effect: the listener must be attached in the same commit
  // that inserts / re-navigates the iframe, so the shell's one
  // `shell-ready` can't arrive before anyone listens.
  useLayoutEffect(() => {
    const frame = ref.current
    if (frame && renderedRef.current) {
      // The shell already replaced itself with older HTML — reload it.
      // Assigning `src` navigates even when the value is unchanged.
      renderedRef.current = false
      frame.src = SANDBOX_FRAME_PATH
    }

    function onMessage(e: MessageEvent) {
      const current = ref.current
      if (!current || e.source !== current.contentWindow) return
      if (!isShellReadyMessage(e.data)) return
      // One render per navigation, even if something in the frame
      // replays `shell-ready`.
      if (renderedRef.current) return
      renderedRef.current = true
      // Opaque-origin frame: "*" is the only target that matches.
      // `e.source` above pins the recipient to this iframe's window.
      current.contentWindow?.postMessage(renderMessage(html), "*")
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [html, reloadKey, ref])

  return (
    <iframe
      ref={ref}
      src={SANDBOX_FRAME_PATH}
      title={title}
      // CRITICAL: do NOT add `allow-same-origin`. The opaque origin is
      // what keeps the untrusted script away from the app's cookies,
      // storage and same-origin API routes — the shell is served from
      // the app's own origin, so with that flag it would be same-origin.
      // The shell's CSP repeats `sandbox allow-scripts` as a backstop.
      // See PLAN-live-artifacts.md → Sandbox security model.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      // `loading="lazy"` so inline previews scrolled out of view
      // don't keep their iframes hot. Side-panel use cases are
      // always visible so the attr is a no-op there.
      loading="lazy"
      className={className}
    />
  )
}
