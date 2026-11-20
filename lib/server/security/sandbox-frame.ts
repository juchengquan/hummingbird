import "server-only"

import { CDN_HOSTS } from "@/shared/live-artifact/cdn-urls"
import { SANDBOX_FRAME_NS } from "@/shared/sandbox-frame"

/**
 * The sandbox frame shell: the document `GET /sandbox/frame` serves
 * (`app/sandbox/frame/route.ts`) and the response CSP it carries.
 *
 * Live-artifact and MCP-app iframes used to be `srcdoc` frames. A
 * `srcdoc` document inherits the parent's policy container, so the
 * app's nonce + 'strict-dynamic' policy (`csp.ts`) applied inside them
 * and, under `CSP_MODE=enforce`, blocked every artifact script. The
 * shell is a real navigation with its own response CSP, written for
 * untrusted artifact code. The parent posts the HTML in after the
 * handshake in `@/shared/sandbox-frame`.
 *
 * This policy is always ENFORCED, whatever `CSP_MODE` says: it is the
 * security boundary for untrusted HTML (as the shells' `<meta>` CSP
 * always was), not the app policy being rolled out. The proxy matcher
 * excludes the route so the app policy never overwrites it.
 */

/** Directive name → source list, in emission order. */
export function buildSandboxFrameDirectives(): Array<[string, string[]]> {
  return [
    ["default-src", ["'none'"]],
    // Artifact code is inline (`<script>…</script>`, the shell's own
    // bootstrap and error bridge too), so 'unsafe-inline' — and no
    // nonce/hash, which would make browsers ignore it. 'unsafe-eval':
    // Babel standalone compiles TSX artifacts at runtime. The CDN hosts
    // serve React/ReactDOM/Babel (unpkg), Tailwind's JIT runtime and
    // Mermaid (jsdelivr). No 'self': artifacts have no business loading
    // the app's own scripts.
    ["script-src", ["'unsafe-inline'", "'unsafe-eval'", ...CDN_HOSTS]],
    ["style-src", ["'unsafe-inline'", ...CDN_HOSTS]],
    // Same image/font reach the shells' <meta> CSP has always granted.
    ["img-src", ["data:", "blob:", "https:"]],
    ["font-src", ["data:", "https:"]],
    // The critical line: generated code can't fetch / XHR / WebSocket /
    // EventSource anywhere. MCP-app tool calls go through the parent's
    // postMessage bridge instead.
    ["connect-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]],
    // Only app pages may frame the shell.
    ["frame-ancestors", ["'self'"]],
    // Belt and braces for the iframe's `sandbox="allow-scripts"`: even
    // when the shell is opened top-level (typed URL, window.open) or
    // framed without the attribute, it still runs at an opaque origin,
    // away from the app's cookies and storage.
    ["sandbox", ["allow-scripts"]],
    // No report-uri: violations in here are untrusted code hitting the
    // fence (blocked fetches etc.), not app regressions — reporting
    // them would only bury real reports in noise.
  ]
}

export function buildSandboxFrameCsp(): string {
  return buildSandboxFrameDirectives()
    .map(([name, sources]) => (sources.length ? `${name} ${sources.join(" ")}` : name))
    .join("; ")
}

/**
 * Inline bootstrap. Accepts exactly one `render` message, and only from
 * the app page that framed it (`source === parent`, `origin ===
 * location.origin` — `location` reports the URL's origin even though
 * the document's own origin is opaque), then replaces the document
 * with the HTML. `document.open()` also drops this listener, so the
 * rendered content can't be swapped by a later message; the parent
 * re-navigates the frame to render something else.
 *
 * Mirrors `parseRenderMessage` in `@/shared/sandbox-frame`; the
 * shell test runs this source against stub globals to keep them aligned.
 */
export function sandboxFrameBootstrapScript(): string {
  const ns = JSON.stringify(SANDBOX_FRAME_NS)
  return `(function () {
  var NS = ${ns};
  var rendered = false;
  function onMessage(e) {
    if (rendered) return;
    if (e.source !== window.parent || e.source === window) return;
    if (e.origin !== location.origin) return;
    var d = e.data;
    if (!d || typeof d !== "object" || d.ns !== NS || d.type !== "render") return;
    if (typeof d.html !== "string") return;
    rendered = true;
    window.removeEventListener("message", onMessage);
    document.open();
    document.write(d.html);
    document.close();
  }
  window.addEventListener("message", onMessage);
  function announce() {
    if (window.parent !== window) window.parent.postMessage({ ns: NS, type: "shell-ready" }, "*");
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", announce);
  } else {
    announce();
  }
})();`
}

export function buildSandboxFrameDocument(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Sandbox</title>
</head>
<body>
<script>
${sandboxFrameBootstrapScript()}
</script>
</body>
</html>
`
}

/** Response headers for the shell document. */
export function sandboxFrameHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": buildSandboxFrameCsp(),
    // `frame-ancestors` supersedes X-Frame-Options in every current
    // browser; this keeps the legacy header (next.config.ts sends DENY
    // everywhere else) consistent with it for older ones.
    "X-Frame-Options": "SAMEORIGIN",
    // Revalidate every load so a deploy that changes the policy takes
    // effect immediately; the ETag keeps that a 304.
    "Cache-Control": "no-cache",
  }
}
