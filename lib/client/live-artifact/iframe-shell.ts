/**
 * Build the HTML document the live-artifact iframe renders — posted
 * into the `/sandbox/frame` shell by `SandboxedFrame`, which writes it
 * over itself. Four shells (`html`, `tsx`, `svg`, `mermaid`) — each is
 * a pure string template so they can be snapshot-tested without a DOM.
 *
 * Security: every shell injects the same CSP `<meta>` tag locking
 * `connect-src` to none and `script-src` to the pinned CDN hosts. It
 * stacks on the shell's response CSP (`lib/server/security/sandbox-frame.ts`),
 * which enforces the same limits even for a full document without a
 * `<head>` to inject into. The iframe itself runs under
 * `sandbox="allow-scripts"` (set by the frame component) so the
 * document is at an opaque origin — no cookies, no localStorage, no
 * same-origin fetch to our app.
 *
 * Errors thrown from the user's script bubble up via a tiny
 * `window.onerror` hook that posts `{ type: 'live-artifact-error',
 * message }` to the parent. The frame component matches the source
 * iframe and surfaces the message in its toolbar.
 */

import { CDN_HOSTS, CDN_SCRIPTS, type CdnScriptName } from "@/shared/live-artifact/cdn-urls"
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

/** `<script>` tag for a pinned CDN script, with its SRI hash when the
 *  host supports one. `crossorigin="anonymous"` makes the fetch a CORS
 *  request, which an `integrity` check requires; it's left off for
 *  hosts without CORS headers, where it would make the load fail. */
export function cdnScriptTag(name: CdnScriptName): string {
  const { src, integrity } = CDN_SCRIPTS[name]
  return integrity
    ? `<script src="${src}" integrity="${integrity}" crossorigin="anonymous"></script>`
    : `<script src="${src}"></script>`
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
${cdnScriptTag("tailwind")}
${errorBridge()}
<style>html,body{margin:0;padding:0;}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}</style>
</head>
<body>
${content}
</body>
</html>`
}

// --------------------------------------------------------------------
// TSX shell — React 18 + ReactDOM (UMD globals) + Babel standalone.
// The artifact is compiled in the frame as a CommonJS module, so every
// import / export form works without regex surgery on the source.
// --------------------------------------------------------------------

/** Babel options the frame compiles the artifact with: strip TS types
 *  (TSX syntax for every artifact, even when the fence said `jsx`),
 *  classic JSX runtime (`React.createElement`, so no
 *  `react/jsx-runtime` module is needed), and ES modules → CommonJS so
 *  imports resolve through the frame's `require` shim and the default
 *  export lands on `module.exports.default`. */
export const TSX_BABEL_OPTIONS = {
  filename: "artifact.tsx",
  presets: [["typescript", { isTSX: true, allExtensions: true }], "react"],
  plugins: ["transform-modules-commonjs"],
} as const

/** Modules a TSX artifact can import, mapped to the UMD globals. Any
 *  other bare import fails with a message naming the module (rather
 *  than a later "X is not defined"); relative paths and stylesheets
 *  are no-ops. */
export const TSX_MODULES = {
  react: "React",
  "react-dom": "ReactDOM",
  "react-dom/client": "ReactDOM",
} as const

/** Code that calls `createRoot` / `ReactDOM.render` itself gets no
 *  second root mounted on the same container. */
const SELF_MOUNT_RE = /\b(?:createRoot|hydrateRoot)\s*\(|\bReactDOM\s*\.\s*render\s*\(/

/** Fallback component name for when there's no default export (the
 *  default export always wins, at runtime). Order of preference:
 *
 *  1. A declaration named `App`
 *  2. A declaration named `Demo`
 *  3. The LAST PascalCase function/class/const declaration in the file
 *
 *  Null when nothing looks mountable — the frame then renders an
 *  in-iframe error rather than mounting `const x = 1` as a component.
 */
export function findMountName(code: string): string | null {
  const namedDeclRe = /(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g
  const names: string[] = []
  let m: RegExpExecArray | null
  while ((m = namedDeclRe.exec(code)) !== null) names.push(m[1])

  if (names.includes("App")) return "App"
  if (names.includes("Demo")) return "Demo"
  // React convention: components are PascalCase, hooks are camelCase
  // starting with `use`, regular vars are camelCase.
  const pascalCase = names.filter((n) => /^[A-Z]/.test(n))
  if (pascalCase.length > 0) return pascalCase[pascalCase.length - 1]
  return null
}

/** JSON-encode a value for an inline `<script>`. `<` is escaped so the
 *  artifact source can't close the element (`</script>`) or open an
 *  HTML comment (`<!--`) that changes how the tag is parsed. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

/** The inline script that compiles, runs and mounts the artifact. It
 *  runs as-is in the frame (no Babel pass of its own), so plain ES5. */
export function tsxRuntimeScript(source: string): string {
  const modules = Object.entries(TSX_MODULES)
    .map(([name, global]) => `${JSON.stringify(name)}: ${global}`)
    .join(", ")
  return `(function () {
  var root = document.getElementById("root");
  function showError(title, err) {
    var box = document.createElement("div");
    box.setAttribute("style", "padding:1rem;font-family:sans-serif;color:#b91c1c;");
    var strong = document.createElement("strong");
    strong.textContent = title;
    box.appendChild(strong);
    if (err) {
      var pre = document.createElement("pre");
      pre.setAttribute("style", "white-space:pre-wrap;font-size:12px;");
      pre.textContent = String((err && err.message) || err);
      box.appendChild(pre);
    }
    root.replaceChildren(box);
  }
  if (typeof React === "undefined" || typeof ReactDOM === "undefined" || typeof Babel === "undefined") {
    showError("Couldn't load React / Babel from the CDN.");
    throw new Error("Live preview runtime (React / ReactDOM / Babel) failed to load");
  }

  var SOURCE = ${inlineJson(source)};
  var BABEL_OPTIONS = ${inlineJson(TSX_BABEL_OPTIONS)};
  var FALLBACK_NAME = ${inlineJson(findMountName(source))};
  var SELF_MOUNTS = ${SELF_MOUNT_RE.test(source) ? "true" : "false"};
  var MODULES = { ${modules} };

  function require(name) {
    if (Object.prototype.hasOwnProperty.call(MODULES, name)) return MODULES[name];
    if (/^\\.{0,2}\\//.test(name) || /\\.css$/.test(name)) return {};
    throw new Error('Cannot import "' + name + '" in a live preview: only react and react-dom are available.');
  }

  var code;
  try {
    code = Babel.transform(SOURCE, BABEL_OPTIONS).code;
  } catch (err) {
    showError("Couldn't compile this component.", err);
    throw err;
  }

  var module = { exports: {} };
  var named;
  try {
    var tail = FALLBACK_NAME
      ? "\\n;return typeof " + FALLBACK_NAME + ' !== "undefined" ? ' + FALLBACK_NAME + " : undefined;"
      : "";
    named = new Function("require", "module", "exports", "React", "ReactDOM", code + tail)(
      require, module, module.exports, React, ReactDOM
    );
  } catch (err) {
    showError("This component threw while loading.", err);
    throw err;
  }
  if (SELF_MOUNTS) return;

  var exp = module.exports;
  var Component = exp && exp["default"] != null ? exp["default"] : named;
  var mountable = typeof Component === "function" ||
    (Component !== null && typeof Component === "object" && Component.$$typeof != null);
  if (!mountable) {
    showError("No mountable component found. Expected an App, Demo, or a default-exported component.");
    return;
  }
  ReactDOM.createRoot(root).render(React.createElement(Component));
})();`
}

function buildTsxShell(content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${cspMeta()}
${errorBridge()}
${cdnScriptTag("tailwind")}
${cdnScriptTag("react")}
${cdnScriptTag("reactDom")}
${cdnScriptTag("babel")}
<style>html,body{margin:0;padding:0;}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}#root{padding:1rem;}</style>
</head>
<body>
<div id="root"></div>
<script>
${tsxRuntimeScript(content)}
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
${cdnScriptTag("mermaid")}
<script>
  mermaid.initialize({ startOnLoad: true, securityLevel: 'strict' });
</script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
