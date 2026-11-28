"use client"

import { useLayoutEffect, useRef, type RefObject } from "react"

import {
  isNavigatingMessage,
  isShellReadyMessage,
  newSandboxFrameNonce,
  renderMessage,
  sandboxFrameUrl,
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
 * (or a bumped `reloadKey`) re-navigates the frame with a fresh nonce
 * and the handshake runs again — the same full reload a `srcdoc` change
 * caused. Only a `shell-ready` echoing the CURRENT nonce gets the HTML:
 * the previous (already rendered, untrusted) document can't claim the
 * next artifact's source. Callers should also key this component by the
 * artifact's id so switching artifacts gets a brand-new iframe.
 *
 * Navigation away: once rendered, the frame keeps the same
 * `contentWindow` even if it navigates itself (a link, `location = …`),
 * so `event.source` checks alone would keep trusting whatever loads
 * next. `onNavigatedAway` fires when the rendered document reports
 * `pagehide` (`navigating`, ordered before anything the next document
 * posts) or, as a backstop, on an iframe `load` beyond the handshake's
 * (the shell's own load can race the ready message, so up to two loads
 * after ready are the handshake's; a third is a navigation).
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
  onNavigatedAway,
}: {
  html: string
  /** Bump to re-render the same `html` from scratch. */
  reloadKey?: number
  title: string
  className?: string
  frameRef?: RefObject<HTMLIFrameElement | null>
  /** Called (synchronously, from the message / load handler) once the
   *  rendered document is navigated away from. Stop honouring the
   *  frame's messages from that point on. */
  onNavigatedAway?: () => void
}) {
  const localRef = useRef<HTMLIFrameElement | null>(null)
  const ref = frameRef ?? localRef
  const onNavigatedAwayRef = useRef(onNavigatedAway)
  useLayoutEffect(() => {
    onNavigatedAwayRef.current = onNavigatedAway
  })

  // Layout effect: the listener must be attached in the same commit
  // that inserts / re-navigates the iframe, so the shell's one
  // `shell-ready` can't arrive before anyone listens.
  useLayoutEffect(() => {
    const frame = ref.current
    if (!frame) return
    // Fresh nonce per navigation; assigning `src` navigates even when
    // only the query changes.
    const nonce = newSandboxFrameNonce()
    frame.src = sandboxFrameUrl(nonce)
    let rendered = false
    let loadsAfterReady = -1 // -1: no ready for this nonce yet
    let gone = false
    const navigatedAway = () => {
      if (gone) return
      gone = true
      onNavigatedAwayRef.current?.()
    }

    function onMessage(e: MessageEvent) {
      const current = ref.current
      if (!current) return
      // Posted from `pagehide`: by the time it arrives the document that
      // sent it is gone, and browsers (Chromium) deliver it with
      // `source === null`. The nonce — known only to this navigation —
      // is what authenticates it, and all it can do is cut the bridge.
      if (
        rendered &&
        (e.source === null || e.source === current.contentWindow) &&
        isNavigatingMessage(e.data, nonce)
      ) {
        navigatedAway()
        return
      }
      if (e.source !== current.contentWindow) return
      if (!isShellReadyMessage(e.data, nonce)) return
      // One render per navigation, even if something in the frame
      // replays `shell-ready`.
      if (rendered) return
      rendered = true
      loadsAfterReady = 0
      // Opaque-origin frame: "*" is the only target that matches.
      // `e.source` above pins the recipient to this iframe's window.
      current.contentWindow?.postMessage(renderMessage(html, nonce), "*")
    }
    function onLoad() {
      if (loadsAfterReady < 0) return
      loadsAfterReady += 1
      if (loadsAfterReady > 2) navigatedAway()
    }
    window.addEventListener("message", onMessage)
    frame.addEventListener("load", onLoad)
    return () => {
      window.removeEventListener("message", onMessage)
      frame.removeEventListener("load", onLoad)
    }
  }, [html, reloadKey, ref])

  return (
    <iframe
      ref={ref}
      // No `src` here: the layout effect navigates to the shell with this
      // navigation's nonce (`sandboxFrameUrl`, path SANDBOX_FRAME_PATH).
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
