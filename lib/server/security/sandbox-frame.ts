import "server-only"

import { CDN_HOSTS } from "@/shared/live-artifact/cdn-urls"
import {
  SANDBOX_FRAME_NONCE_PARAM,
  SANDBOX_FRAME_NONCE_RE,
  SANDBOX_FRAME_NS,
} from "@/shared/sandbox-frame"

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
    // Babel standalone compiles TSX artifacts at runtime, and the TSX
    // shell runs the compiled module through `new Function`. The CDN
    // hosts are exactly the origins of the pinned `CDN_SCRIPTS`:
    // React 18 / ReactDOM / Babel (unpkg), Tailwind's v3 JIT runtime
    // (cdn.tailwindcss.com) and Mermaid (jsdelivr). No 'self':
    // artifacts have no business loading the app's own scripts.
    ["script-src", ["'unsafe-inline'", "'unsafe-eval'", ...CDN_HOSTS]],
    ["style-src", ["'unsafe-inline'", ...CDN_HOSTS]],
    // Images: any https host, deliberately. Generated pages routinely
    // show remote images (stock photos, logos, charts from a public
    // URL), and closing this would not close exfiltration anyway: the
    // frame can still navigate ITSELF to an attacker URL (no CSP
    // directive governs that; the MCP-app host then drops the frame's
    // bridge — see `mcp-app-frame.tsx`), and WebRTC / DNS prefetch
    // aren't governed by connect-src. What the frame can leak is what
    // it was given (its own source, MCP tool results); it never sees
    // the app's cookies or storage (opaque origin).
    ["img-src", ["data:", "blob:", "https:"]],
    // Fonts: inline / generated, plus the pinned CDN hosts. A font is
    // not something a generated page needs from an arbitrary host, and
    // `https:` here was one more beacon channel (@font-face url()).
    ["font-src", ["data:", "blob:", ...CDN_HOSTS]],
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
 * Inline bootstrap. Reads this navigation's nonce from `?n=` (no valid
 * nonce → inert), announces `shell-ready` with it once loaded, accepts
 * exactly one `render` message carrying the same nonce, and only from
 * the app page that framed it (`source === parent`, `origin ===
 * location.origin` — `location` reports the URL's origin even though
 * the document's own origin is opaque), then replaces the document
 * with the HTML. `document.open()` also drops this listener, so the
 * rendered content can't be swapped by a later message; the parent
 * re-navigates the frame to render something else.
 *
 * After rendering it re-registers (document.open erased every listener)
 * a `pagehide` hook that tells the parent the rendered document is
 * being navigated away from — `addEventListener` is captured up front
 * so the rendered content can't stub it out first.
 *
 * Announcing after `load` (not DOMContentLoaded) keeps the shell's own
 * iframe `load` event ahead of the render, so the parent's load
 * counting (`SandboxedFrame`) sees: shell load, ready, render load.
 *
 * Mirrors `parseRenderMessage` in `@/shared/sandbox-frame`; the
 * shell test runs this source against stub globals to keep them aligned.
 */
export function sandboxFrameBootstrapScript(): string {
  const ns = JSON.stringify(SANDBOX_FRAME_NS)
  const param = JSON.stringify(SANDBOX_FRAME_NONCE_PARAM)
  return `(function () {
  var NS = ${ns};
  var addEv = window.addEventListener;
  var nonce = null;
  var parts = String(location.search || "").replace(/^\\?/, "").split("&");
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].split("=");
    if (kv[0] === ${param} && ${SANDBOX_FRAME_NONCE_RE}.test(kv[1] || "")) nonce = kv[1];
  }
  if (nonce === null) return;
  var rendered = false;
  function onMessage(e) {
    if (rendered) return;
    if (e.source !== window.parent || e.source === window) return;
    if (e.origin !== location.origin) return;
    var d = e.data;
    if (!d || typeof d !== "object" || d.ns !== NS || d.type !== "render") return;
    if (d.nonce !== nonce || typeof d.html !== "string") return;
    rendered = true;
    window.removeEventListener("message", onMessage);
    document.open();
    document.write(d.html);
    document.close();
    addEv.call(window, "pagehide", function () {
      window.parent.postMessage({ ns: NS, type: "navigating", nonce: nonce }, "*");
    });
  }
  addEv.call(window, "message", onMessage);
  function announce() {
    if (window.parent !== window) window.parent.postMessage({ ns: NS, type: "shell-ready", nonce: nonce }, "*");
  }
  if (document.readyState === "complete") {
    announce();
  } else {
    addEv.call(window, "load", announce);
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
