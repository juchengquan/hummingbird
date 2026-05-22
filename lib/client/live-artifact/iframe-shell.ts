/**
 * Build the HTML document that goes into the live-artifact iframe's
 * `srcdoc`. Four shells (`html`, `tsx`, `svg`, `mermaid`) — each is a
 * pure string template so they can be snapshot-tested without a DOM.
 *
 * Security: every shell injects the same CSP `<meta>` tag locking
 * `connect-src` to none and `script-src` to the pinned CDN hosts. The
 * iframe itself runs under `sandbox="allow-scripts"` (set by the
 * frame component) so the document is at a null origin — no cookies,
 * no localStorage, no same-origin fetch to our app.
 *
 * Errors thrown from the user's script bubble up via a tiny
 * `window.onerror` hook that posts `{ type: 'live-artifact-error',
 * message }` to the parent. The frame component matches the source
 * iframe and surfaces the message in its toolbar.
 */

import { CDN_HOSTS, CDN_URLS } from "./cdn-urls"
import type { ShellKind } from "./detect"

/** Marker on every postMessage from the iframe so the parent can
 *  ignore unrelated cross-frame chatter (e.g. browser extensions). */
export const IFRAME_MESSAGE_NS = "live-artifact"

export function buildShell(shell: ShellKind, content: string): string {
  switch (shell) {
    case "html":
      return buildHtmlShell(content)
    case "tsx":
      return buildTsxShell(content)
    case "svg":
      return buildSvgShell(content)
    case "mermaid":
      return buildMermaidShell(content)
  }
}

// --------------------------------------------------------------------
// CSP + error-bridge — shared by every shell.
// --------------------------------------------------------------------

function cspMeta(): string {
  // 'unsafe-inline' is required because the user's script is inline
  // in the doc. 'unsafe-eval' is required by Babel standalone.
  // connect-src 'none' is the critical defense — even if a generated
  // script attempts a fetch to our origin (or anywhere else), the
  // iframe CSP blocks it.
  const scriptSrc = ["'self'", "'unsafe-inline'", "'unsafe-eval'", ...CDN_HOSTS].join(" ")
  const styleSrc = ["'self'", "'unsafe-inline'", ...CDN_HOSTS].join(" ")
  return [
    `<meta http-equiv="Content-Security-Policy" content="`,
    `default-src 'none';`,
    `script-src ${scriptSrc};`,
    `style-src ${styleSrc};`,
    `img-src 'self' data: blob: https:;`,
    `font-src 'self' data: https:;`,
    `connect-src 'none';`,
    `base-uri 'none';`,
    `form-action 'none';`,
    `">`,
  ].join(" ")
}

function errorBridge(): string {
  // Posts uncaught errors + unhandled promise rejections up to the
  // parent. The parent listener filters by `e.source` to ensure the
  // message came from the right iframe.
  return `<script>
(function () {
  function post(message) {
    try {
      parent.postMessage({ ns: "${IFRAME_MESSAGE_NS}", type: "error", message: String(message) }, "*");
    } catch (_) { /* posting failed — nothing more we can do */ }
  }
  window.addEventListener("error", function (e) {
    post(e.message || (e.error && e.error.message) || "Script error");
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    post(r && (r.message || String(r)) || "Unhandled rejection");
  });
  // Tell the parent we're alive once the doc is interactive — lets
  // the parent clear its loading state even if no scripts run.
  if (document.readyState === "complete" || document.readyState === "interactive") {
    parent.postMessage({ ns: "${IFRAME_MESSAGE_NS}", type: "ready" }, "*");
  } else {
    window.addEventListener("DOMContentLoaded", function () {
      parent.postMessage({ ns: "${IFRAME_MESSAGE_NS}", type: "ready" }, "*");
    });
  }
})();
</script>`
}

// --------------------------------------------------------------------
// HTML shell — passthrough for full docs, wrap snippets in a minimal
// Tailwind-aware envelope.
// --------------------------------------------------------------------

function isFullHtmlDocument(content: string): boolean {
  const head = content.replace(/^﻿/, "").trimStart().toLowerCase()
  return head.startsWith("<!doctype") || head.startsWith("<html")
}

function buildHtmlShell(content: string): string {
  if (isFullHtmlDocument(content)) {
    // Inject the CSP + error bridge just inside <head>. If we can't
    // find a head tag (rare — malformed docs), we let the doc through
    // unmodified, accepting that errors will be uncaught.
    const headMatch = content.match(/<head[^>]*>/i)
    if (headMatch) {
      const inject = cspMeta() + "\n" + errorBridge()
      return content.replace(headMatch[0], `${headMatch[0]}\n${inject}`)
    }
    return content
  }
  // Snippet — wrap in a minimal Tailwind-CDN envelope.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${cspMeta()}
<script src="${CDN_URLS.tailwind}"></script>
${errorBridge()}
<style>html,body{margin:0;padding:0;}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}</style>
</head>
<body>
${content}
</body>
</html>`
}

// --------------------------------------------------------------------
// TSX shell — React + ReactDOM + Babel standalone, with import lines
// stripped and a mount call appended for the detected component.
// --------------------------------------------------------------------

/** Strip ES module syntax that breaks in non-module Babel scripts:
 *
 *  - `import …` lines (React/ReactDOM are globals from the UMD bundles)
 *  - `export default <Name>` → keeps the identifier so we can mount it
 *  - `export default function/class/const …` → drops the `export
 *    default` keyword
 *  - `export {…}` / `export const/function/class` → drops `export`
 */
function stripModuleSyntax(code: string): { code: string; defaultExportName: string | null } {
  let out = code
  // Strip `import … from "..."` lines (single & multi-line variants).
  out = out.replace(/^\s*import\s+[^;]+?;?\s*$/gm, "")
  // Strip side-effect imports `import "..."` or `import '...'`.
  out = out.replace(/^\s*import\s+["'][^"']+["'];?\s*$/gm, "")

  // `export default function Name` / `export default class Name` /
  // `export default const Name` — drop the `export default` and
  // remember the name.
  let defaultExportName: string | null = null
  out = out.replace(
    /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    (_m, name) => {
      defaultExportName = name
      return `function ${name}`
    }
  )
  // `export default function() {…}` / `export default function () {…}`
  out = out.replace(
    /export\s+default\s+(?:async\s+)?function\s*\(/,
    () => {
      defaultExportName = "__defaultExport"
      return "function __defaultExport("
    }
  )
  // `export default class Name`
  out = out.replace(
    /export\s+default\s+class\s+([A-Za-z_$][\w$]*)/,
    (_m, name) => {
      defaultExportName = name
      return `class ${name}`
    }
  )
  // `export default <identifier>;` — keep the identifier, just drop the keywords.
  out = out.replace(
    /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/,
    (_m, name) => {
      defaultExportName = name
      return ""
    }
  )
  // `export default <arrow expression>` — assign to a temp var.
  out = out.replace(
    /export\s+default\s+(?=[(\[{])/,
    () => {
      defaultExportName = "__defaultExport"
      return "const __defaultExport = "
    }
  )
  // Bare `export ` keywords on non-default declarations.
  out = out.replace(/^\s*export\s+(?=function|class|const|let|var)/gm, "")
  // `export { Name, Other }` — drop entirely.
  out = out.replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "")
  return { code: out, defaultExportName }
}

/** Find the identifier we should mount. Order of preference:
 *
 *  1. The default export (captured by `stripModuleSyntax`)
 *  2. A declaration named `App`
 *  3. A declaration named `Demo`
 *  4. The LAST function/class/const declaration in the file
 *
 *  Falls back to null when nothing looks mountable — the shell then
 *  renders an in-iframe error rather than running broken code.
 */
function findMountName(code: string, defaultExportName: string | null): string | null {
  if (defaultExportName) return defaultExportName

  const namedDeclRe = /(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g
  const names: string[] = []
  let m: RegExpExecArray | null
  while ((m = namedDeclRe.exec(code)) !== null) names.push(m[1])

  if (names.includes("App")) return "App"
  if (names.includes("Demo")) return "Demo"
  // Restrict the last-decl fallback to PascalCase identifiers. React
  // convention: components are PascalCase, hooks are camelCase
  // starting with `use`, regular vars are camelCase. Mounting a
  // `const x = 1` as a component would crash; skipping it lets the
  // "nothing mountable" error message take over instead.
  const pascalCase = names.filter((n) => /^[A-Z]/.test(n))
  if (pascalCase.length > 0) return pascalCase[pascalCase.length - 1]
  return null
}

function buildTsxShell(content: string): string {
  const { code, defaultExportName } = stripModuleSyntax(content)
  const mountName = findMountName(code, defaultExportName)

  const tail = mountName
    ? `\n;ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(${mountName}));`
    : `\n;document.getElementById("root").innerHTML = '<div style="padding:1rem;font-family:sans-serif;color:#b91c1c;">No mountable component found. Expected an <code>App</code>, <code>Demo</code>, or a default-exported component.</div>';`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${cspMeta()}
<script src="${CDN_URLS.tailwind}"></script>
<script crossorigin src="${CDN_URLS.react}"></script>
<script crossorigin src="${CDN_URLS.reactDom}"></script>
<script src="${CDN_URLS.babel}"></script>
${errorBridge()}
<style>html,body{margin:0;padding:0;}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}#root{padding:1rem;}</style>
</head>
<body>
<div id="root"></div>
<script type="text/babel" data-presets="react,typescript">
${code}
${tail}
</script>
</body>
</html>`
}

// --------------------------------------------------------------------
// SVG shell — center the SVG, transparent background.
// --------------------------------------------------------------------

function buildSvgShell(content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${cspMeta()}
${errorBridge()}
<style>
html,body{margin:0;padding:0;height:100%;}
body{display:flex;align-items:center;justify-content:center;padding:1rem;}
svg{max-width:100%;max-height:100%;}
</style>
</head>
<body>
${content}
</body>
</html>`
}

// --------------------------------------------------------------------
// Mermaid shell.
// --------------------------------------------------------------------

function buildMermaidShell(content: string): string {
  // We embed the diagram source inside a `<pre class="mermaid">`
  // (Mermaid's documented bootstrap convention). Then call
  // `mermaid.initialize` + `mermaid.run` on load. `securityLevel:
  // 'strict'` prevents click handlers and HTML injection from the
  // diagram source itself.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${cspMeta()}
${errorBridge()}
<style>
html,body{margin:0;padding:0;height:100%;}
body{display:flex;align-items:center;justify-content:center;padding:1rem;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
.mermaid{max-width:100%;max-height:100%;}
</style>
</head>
<body>
<pre class="mermaid">${escapeHtml(content)}</pre>
<script src="${CDN_URLS.mermaid}"></script>
<script>
  mermaid.initialize({ startOnLoad: true, securityLevel: 'strict' });
</script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
