/**
 * Wire protocol between the app and the sandbox frame shell
 * (`GET /sandbox/frame`, `app/sandbox/frame/route.ts`).
 *
 * Live-artifact and MCP-app iframes load the shell with
 * `<iframe src="/sandbox/frame" sandbox="allow-scripts">` instead of
 * `srcdoc`, so the frame document carries the shell's own response CSP
 * rather than inheriting the app's nonce-based policy (which would block
 * every artifact script under `CSP_MODE=enforce`). See docs/SECURITY.md.
 *
 * Handshake, once per frame navigation:
 *
 *   1. shell  → parent  `{ ns, type: "shell-ready" }`   (targetOrigin "*")
 *   2. parent → shell   `{ ns, type: "render", html }`  (targetOrigin "*")
 *   3. the shell replaces itself with `html` (document.open/write/close)
 *      and ignores every later message; from here on the frame speaks
 *      only the artifact's own protocols (`live-artifact`, `mcp-app`).
 *
 * The frame is an opaque origin, so both directions must post with "*".
 * The checks that make that safe live on each receiver:
 *
 *   - parent: `event.source === iframe.contentWindow` (this frame, not a
 *     sibling or an extension), then `isShellReadyMessage`, and at most
 *     one `render` per navigation.
 *   - shell: `event.source === window.parent` and
 *     `event.origin === location.origin` (only the app page that framed
 *     it), then `parseRenderMessage`, and at most one render.
 *
 * Pure: no DOM, no I/O. The shell's inline bootstrap is generated from
 * the same constants (`lib/server/security/sandbox-frame.ts`).
 */

/** Route that serves the shell document. */
export const SANDBOX_FRAME_PATH = "/sandbox/frame"

/** postMessage namespace for the handshake — distinct from the
 *  `live-artifact` and `mcp-app` namespaces the rendered content uses. */
export const SANDBOX_FRAME_NS = "sandbox-frame"

export interface SandboxFrameShellReady {
  ns: typeof SANDBOX_FRAME_NS
  type: "shell-ready"
}

export interface SandboxFrameRender {
  ns: typeof SANDBOX_FRAME_NS
  type: "render"
  html: string
}

export function shellReadyMessage(): SandboxFrameShellReady {
  return { ns: SANDBOX_FRAME_NS, type: "shell-ready" }
}

export function renderMessage(html: string): SandboxFrameRender {
  return { ns: SANDBOX_FRAME_NS, type: "render", html }
}

function isObject(data: unknown): data is Record<string, unknown> {
  return typeof data === "object" && data !== null
}

/** Parent side: is this the shell announcing it can take a render? */
export function isShellReadyMessage(data: unknown): data is SandboxFrameShellReady {
  return isObject(data) && data.ns === SANDBOX_FRAME_NS && data.type === "shell-ready"
}

/** Shell side: the HTML to render, or `null` for anything that isn't a
 *  well-formed render message. */
export function parseRenderMessage(data: unknown): string | null {
  if (!isObject(data)) return null
  if (data.ns !== SANDBOX_FRAME_NS || data.type !== "render") return null
  return typeof data.html === "string" ? data.html : null
}
