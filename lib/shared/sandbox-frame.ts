/**
 * Wire protocol between the app and the sandbox frame shell
 * (`GET /sandbox/frame`, `app/sandbox/frame/route.ts`).
 *
 * Live-artifact and MCP-app iframes load the shell with
 * `<iframe src="/sandbox/frame?n=<nonce>" sandbox="allow-scripts">`
 * instead of `srcdoc`, so the frame document carries the shell's own
 * response CSP rather than inheriting the app's nonce-based policy (which
 * would block every artifact script under `CSP_MODE=enforce`). See
 * docs/SECURITY.md.
 *
 * Handshake, once per frame navigation. Every navigation gets a fresh
 * random nonce in the URL (`?n=`), which the shell echoes:
 *
 *   1. shell  → parent  `{ ns, type: "shell-ready", nonce }` after load
 *   2. parent → shell   `{ ns, type: "render", nonce, html }`
 *   3. the shell replaces itself with `html` (document.open/write/close)
 *      and ignores every later message; from here on the frame speaks
 *      only the artifact's own protocols (`live-artifact`, `mcp-app`) —
 *      plus one shell message:
 *   4. shell  → parent  `{ ns, type: "navigating", nonce }` on `pagehide`
 *      of the rendered document: the frame is navigating away (a link,
 *      `location = …`). The iframe keeps the same `contentWindow`, so
 *      `event.source` alone can't tell the next document apart; posted
 *      messages from one frame arrive in order, so this one lands
 *      before anything the next document posts. Its sender is gone by
 *      then, so it arrives with `event.source === null` (Chromium): the
 *      nonce is what authenticates it.
 *
 * Why the nonce: when `html` changes the parent re-navigates the frame,
 * but until that navigation commits the OLD (already rendered, untrusted)
 * document can still post a `shell-ready` — without a nonce it would be
 * handed the next artifact's source, and the real shell's ready would be
 * ignored (one render per navigation) → blank frame.
 *
 * The frame is an opaque origin, so both directions must post with "*".
 * The checks that make that safe live on each receiver:
 *
 *   - parent: `event.source === iframe.contentWindow` (this frame, not a
 *     sibling or an extension), then `isShellReadyMessage(data, nonce)`
 *     for the navigation it started, and at most one `render` per nonce.
 *   - shell: `event.source === window.parent` and
 *     `event.origin === location.origin` (only the app page that framed
 *     it), then `parseRenderMessage(data, nonce)`, and at most one render.
 *
 * Pure: no DOM, no I/O. The shell's inline bootstrap is generated from
 * the same constants (`lib/server/security/sandbox-frame.ts`).
 */

/** Route that serves the shell document. */
export const SANDBOX_FRAME_PATH = "/sandbox/frame"

/** postMessage namespace for the handshake — distinct from the
 *  `live-artifact` and `mcp-app` namespaces the rendered content uses. */
export const SANDBOX_FRAME_NS = "sandbox-frame"

/** Query parameter carrying the per-navigation nonce. */
export const SANDBOX_FRAME_NONCE_PARAM = "n"

/** Shape of a nonce (also enforced by the shell's bootstrap). */
export const SANDBOX_FRAME_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/

export interface SandboxFrameShellReady {
  ns: typeof SANDBOX_FRAME_NS
  type: "shell-ready"
  nonce: string
}

export interface SandboxFrameRender {
  ns: typeof SANDBOX_FRAME_NS
  type: "render"
  nonce: string
  html: string
}

export interface SandboxFrameNavigating {
  ns: typeof SANDBOX_FRAME_NS
  type: "navigating"
  nonce: string
}

/** A fresh random nonce for one frame navigation. */
export function newSandboxFrameNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** The shell URL for one navigation. */
export function sandboxFrameUrl(nonce: string): string {
  return `${SANDBOX_FRAME_PATH}?${SANDBOX_FRAME_NONCE_PARAM}=${encodeURIComponent(nonce)}`
}

export function shellReadyMessage(nonce: string): SandboxFrameShellReady {
  return { ns: SANDBOX_FRAME_NS, type: "shell-ready", nonce }
}

export function renderMessage(html: string, nonce: string): SandboxFrameRender {
  return { ns: SANDBOX_FRAME_NS, type: "render", nonce, html }
}

export function navigatingMessage(nonce: string): SandboxFrameNavigating {
  return { ns: SANDBOX_FRAME_NS, type: "navigating", nonce }
}

function isObject(data: unknown): data is Record<string, unknown> {
  return typeof data === "object" && data !== null
}

function isFor(data: Record<string, unknown>, type: string, nonce: string): boolean {
  return (
    data.ns === SANDBOX_FRAME_NS &&
    data.type === type &&
    typeof data.nonce === "string" &&
    data.nonce === nonce
  )
}

/** Parent side: is this the shell of navigation `nonce` announcing it
 *  can take a render? */
export function isShellReadyMessage(
  data: unknown,
  nonce: string
): data is SandboxFrameShellReady {
  return isObject(data) && isFor(data, "shell-ready", nonce)
}

/** Parent side: is the document rendered for navigation `nonce` being
 *  navigated away from? */
export function isNavigatingMessage(
  data: unknown,
  nonce: string
): data is SandboxFrameNavigating {
  return isObject(data) && isFor(data, "navigating", nonce)
}

/** Shell side: the HTML to render, or `null` for anything that isn't a
 *  well-formed render message for this shell's `nonce`. */
export function parseRenderMessage(data: unknown, nonce: string): string | null {
  if (!isObject(data) || !isFor(data, "render", nonce)) return null
  return typeof data.html === "string" ? data.html : null
}
