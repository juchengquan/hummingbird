import { describe, expect, test } from "bun:test"

import { CDN_HOSTS, CDN_SCRIPTS, type CdnScriptName } from "@/shared/live-artifact/cdn-urls"
import {
  buildShell,
  cdnScriptTag,
  findMountName,
  IFRAME_MESSAGE_NS,
  TSX_BABEL_OPTIONS,
  tsxRuntimeScript,
} from "./iframe-shell"

describe("buildShell — every shell injects CSP + error bridge", () => {
  const shells: Array<"html" | "tsx" | "svg" | "mermaid"> = [
    "html",
    "tsx",
    "svg",
    "mermaid",
  ]

  for (const shell of shells) {
    test(`${shell} shell has a CSP meta tag`, () => {
      const out = buildShell(shell, sampleContent(shell))
      expect(out).toContain(`http-equiv="Content-Security-Policy"`)
      expect(out).toContain("connect-src 'none'")
    })

    test(`${shell} shell allows the pinned CDN hosts in script-src`, () => {
      const out = buildShell(shell, sampleContent(shell))
      for (const host of CDN_HOSTS) {
        // Script-src should mention each host so the matching CDN
        // bundle can actually load.
        expect(out).toContain(host)
      }
    })

    test(`${shell} shell posts ready + errors to the parent`, () => {
      const out = buildShell(shell, sampleContent(shell))
      expect(out).toContain(`ns: "${IFRAME_MESSAGE_NS}"`)
      expect(out).toContain('type: "ready"')
      expect(out).toContain('type: "error"')
    })
  }
})

describe("CDN scripts — pinned, with SRI where the host supports it", () => {
  const names = Object.keys(CDN_SCRIPTS) as CdnScriptName[]

  test("every URL names an exact version (no ranges, no bare-host redirects)", () => {
    for (const name of names) {
      expect(CDN_SCRIPTS[name].src).toMatch(/[@/]\d+\.\d+\.\d+(?:\/|$)/)
    }
  })

  test("React is 18.3.1 — React 19 publishes no UMD build", () => {
    expect(CDN_SCRIPTS.react.src).toBe("https://unpkg.com/react@18.3.1/umd/react.development.js")
    expect(CDN_SCRIPTS.reactDom.src).toBe(
      "https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"
    )
  })

  test("React, ReactDOM, Babel and Mermaid carry a sha384 hash", () => {
    for (const name of ["react", "reactDom", "babel", "mermaid"] as const) {
      expect(CDN_SCRIPTS[name].integrity).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/)
    }
  })

  test("a script with a hash is loaded with integrity + crossorigin", () => {
    for (const name of names) {
      const { src, integrity } = CDN_SCRIPTS[name]
      const tag = cdnScriptTag(name)
      if (integrity) {
        expect(tag).toBe(
          `<script src="${src}" integrity="${integrity}" crossorigin="anonymous"></script>`
        )
      } else {
        // No CORS on the host → a crossorigin fetch would fail outright.
        expect(tag).toBe(`<script src="${src}"></script>`)
      }
    }
  })
})

describe("buildShell — html shell", () => {
  test("snippets get wrapped in a Tailwind envelope", () => {
    const out = buildShell("html", "<button>Click me</button>")
    expect(out).toContain("<!doctype html>")
    expect(out).toContain(cdnScriptTag("tailwind"))
    expect(out).toContain("<button>Click me</button>")
  })

  test("full docs pass through untouched (modulo injected CSP/bridge in head)", () => {
    const doc = "<!doctype html><html><head><title>X</title></head><body>hi</body></html>"
    const out = buildShell("html", doc)
    expect(out).toContain("<title>X</title>")
    expect(out).toContain("hi")
    // Injected CSP lands inside the existing <head>, not in a new wrapper.
    expect(out.indexOf("Content-Security-Policy")).toBeGreaterThan(out.indexOf("<head"))
  })

  test("detects full document with leading whitespace", () => {
    const doc = "  \n<!DOCTYPE html><html><head></head><body></body></html>"
    const out = buildShell("html", doc)
    // Should NOT add a second <!doctype>
    expect((out.match(/<!doctype html>/gi) ?? []).length).toBe(1)
  })

  test("falls back to passthrough when full doc has no <head> to inject into", () => {
    // Pathological: full doc declared but no head tag.
    const doc = "<!doctype html><html><body>just a body</body></html>"
    const out = buildShell("html", doc)
    expect(out).toContain("just a body")
    // We deliberately don't fabricate a head, so the doc passes
    // through unmodified.
    expect(out).toBe(doc)
  })
})

describe("buildShell — tsx shell document", () => {
  test("loads Tailwind, React, ReactDOM and Babel (in that order) with their pinned tags", () => {
    const out = buildShell("tsx", "function App(){ return <p/>; }")
    const at = (name: CdnScriptName) => out.indexOf(cdnScriptTag(name))
    for (const name of ["tailwind", "react", "reactDom", "babel"] as const) {
      expect(at(name)).toBeGreaterThan(-1)
    }
    expect(at("react")).toBeLessThan(at("reactDom"))
    expect(at("reactDom")).toBeLessThan(at("babel"))
    // The runtime script comes after every CDN script it relies on.
    expect(out.indexOf("Babel.transform")).toBeGreaterThan(at("babel"))
  })

  test("no text/babel script: the runtime compiles the source itself", () => {
    const out = buildShell("tsx", "function App(){ return <p/>; }")
    expect(out).not.toContain("text/babel")
  })

  test("embeds the source as a JSON string that can't close the script element", () => {
    const code = `export default function App() { return <p>{"</script><script>alert(1)</script>"}<!-- x --></p> }`
    const out = buildShell("tsx", code)
    expect(out).not.toContain("</script><script>alert(1)")
    expect(out).not.toContain("<!-- x")
    expect(out).toContain("\\u003c/script>")
  })

  test("compiles with TS + React presets and ES modules → CommonJS", () => {
    expect(TSX_BABEL_OPTIONS.presets).toContainEqual([
      "typescript",
      { isTSX: true, allExtensions: true },
    ])
    expect(TSX_BABEL_OPTIONS.presets).toContain("react")
    expect(TSX_BABEL_OPTIONS.plugins).toContain("transform-modules-commonjs")
  })
})

describe("findMountName — fallback when there's no default export", () => {
  test("prefers App", () => {
    expect(findMountName(`function Card() {}\nfunction App() {}\nfunction Z() {}`)).toBe("App")
  })

  test("then Demo", () => {
    expect(findMountName(`function Card() {}\nconst Demo = () => null`)).toBe("Demo")
  })

  test("then the last PascalCase declaration", () => {
    expect(findMountName(`function First() {}\nfunction Second() {}\nconst helper = 1`)).toBe(
      "Second"
    )
  })

  test("null when nothing looks like a component", () => {
    expect(findMountName(`const x = 1; function useThing() {}`)).toBeNull()
  })
})

// --------------------------------------------------------------------
// Runtime — runs the generated inline script against stub globals. The
// stub Babel returns hand-written CommonJS (what the real
// `transform-modules-commonjs` output looks like) and records the
// options it was called with; the real compile is covered by the
// headless-browser check described in docs/SECURITY.md.
// --------------------------------------------------------------------

interface FakeNode {
  tag: string
  attrs: Record<string, string>
  textContent: string
  children: FakeNode[]
  setAttribute(k: string, v: string): void
  appendChild(c: FakeNode): void
  replaceChildren(...c: FakeNode[]): void
}

function fakeNode(tag: string): FakeNode {
  return {
    tag,
    attrs: {},
    textContent: "",
    children: [],
    setAttribute(k, v) {
      this.attrs[k] = v
    },
    appendChild(c) {
      this.children.push(c)
    },
    replaceChildren(...c) {
      this.children = c
    },
  }
}

function text(node: FakeNode): string {
  return node.textContent + node.children.map(text).join(" ")
}

interface RunResult {
  root: FakeNode
  mounted: unknown[]
  createRootCalls: number
  babelCalls: Array<{ source: string; options: unknown }>
  error: unknown
}

const React = {
  createElement: (type: unknown) => ({ $$el: type }),
  useState: (v: unknown) => [v, () => {}],
}

function runTsx(source: string, compiled: string | (() => never)): RunResult {
  const root = fakeNode("div")
  const result: RunResult = { root, mounted: [], createRootCalls: 0, babelCalls: [], error: null }
  const ReactDOM = {
    createRoot: () => {
      result.createRootCalls++
      return { render: (el: unknown) => result.mounted.push(el) }
    },
  }
  const Babel = {
    transform(src: string, options: unknown) {
      result.babelCalls.push({ source: src, options })
      if (typeof compiled === "function") compiled()
      return { code: compiled }
    },
  }
  const document = {
    getElementById: (id: string) => (id === "root" ? root : null),
    createElement: fakeNode,
  }
  try {
    new Function("document", "React", "ReactDOM", "Babel", tsxRuntimeScript(source))(
      document,
      React,
      ReactDOM,
      Babel
    )
  } catch (err) {
    result.error = err
  }
  return result
}

describe("tsx runtime", () => {
  test("hands Babel the untouched source and the pinned options", () => {
    const source = `import { useState } from "react"\nexport default function App() { return <p/> }`
    const r = runTsx(source, `exports.default = function App() {};`)
    expect(r.babelCalls).toEqual([{ source, options: TSX_BABEL_OPTIONS }])
  })

  test("mounts the default export", () => {
    const r = runTsx(
      `export default function Greeting() { return <p/> }`,
      `function Greeting() {}\nexports.default = Greeting;`
    )
    expect(r.error).toBeNull()
    expect(r.createRootCalls).toBe(1)
    expect((r.mounted[0] as { $$el: { name: string } }).$$el.name).toBe("Greeting")
  })

  test("the default export beats an App declaration", () => {
    const r = runTsx(
      `function App() {}\nexport default function Real() {}`,
      `function App() {}\nfunction Real() {}\nexports.default = Real;`
    )
    expect((r.mounted[0] as { $$el: { name: string } }).$$el.name).toBe("Real")
  })

  test("without a default export, mounts App from the module scope", () => {
    const r = runTsx(`function Card() {}\nfunction App() {}`, `function Card() {}\nfunction App() {}`)
    expect(r.error).toBeNull()
    expect((r.mounted[0] as { $$el: { name: string } }).$$el.name).toBe("App")
  })

  test("mounts memo / forwardRef objects", () => {
    const r = runTsx(
      `export default memo(App)`,
      `exports.default = { $$typeof: Symbol.for("react.memo"), type: function App() {} };`
    )
    expect(r.error).toBeNull()
    expect(r.mounted).toHaveLength(1)
  })

  test("a non-component default export isn't mounted", () => {
    const r = runTsx(`export default 42`, `exports.default = 42;`)
    expect(r.mounted).toHaveLength(0)
    expect(text(r.root)).toContain("No mountable component found")
  })

  test("resolves react / react-dom / react-dom/client to the UMD globals", () => {
    const r = runTsx(
      `import React, { useState } from "react"\nimport { createRoot } from "react-dom/client"\nexport default function App() {}`,
      `var _react = require("react");
       var _client = require("react-dom/client");
       var _dom = require("react-dom");
       if (_react.useState !== React.useState) throw new Error("react");
       if (_client !== ReactDOM || _dom !== ReactDOM) throw new Error("react-dom");
       exports.default = function App() {};`
    )
    expect(r.error).toBeNull()
    expect(r.mounted).toHaveLength(1)
  })

  test("relative and stylesheet imports are no-ops", () => {
    const r = runTsx(
      `import "./styles.css"\nexport default function App() {}`,
      `require("./styles.css"); require("tailwindcss/tailwind.css"); exports.default = function App() {};`
    )
    expect(r.error).toBeNull()
    expect(r.mounted).toHaveLength(1)
  })

  test("an unavailable package fails with a message naming it", () => {
    const r = runTsx(
      `import { Heart } from "lucide-react"\nexport default function App() {}`,
      `var _l = require("lucide-react"); exports.default = function App() {};`
    )
    expect(String(r.error)).toContain('Cannot import "lucide-react"')
    expect(text(r.root)).toContain('Cannot import "lucide-react"')
    expect(r.mounted).toHaveLength(0)
  })

  test("code that mounts itself doesn't get a second root", () => {
    const r = runTsx(
      `function App() {}\nReactDOM.createRoot(document.getElementById("root")).render(<App />)`,
      `function App() {}\nReactDOM.createRoot(null).render(React.createElement(App));`
    )
    expect(r.error).toBeNull()
    expect(r.createRootCalls).toBe(1)
  })

  test("renders an in-frame error when nothing is mountable", () => {
    const r = runTsx(`const x = 1`, `const x = 1;`)
    expect(r.mounted).toHaveLength(0)
    expect(text(r.root)).toContain("No mountable component found")
  })

  test("a compile error is shown in the frame and rethrown for the error bridge", () => {
    const r = runTsx(`function App( {`, () => {
      throw new SyntaxError("Unexpected token (1:15)")
    })
    expect(r.error).toBeInstanceOf(SyntaxError)
    expect(text(r.root)).toContain("Couldn't compile this component.")
    expect(text(r.root)).toContain("Unexpected token (1:15)")
  })

  test("a missing CDN global is reported instead of a ReferenceError", () => {
    const root = fakeNode("div")
    const document = { getElementById: () => root, createElement: fakeNode }
    expect(() =>
      new Function("document", "React", "ReactDOM", "Babel", tsxRuntimeScript("function App(){}"))(
        document,
        React,
        undefined,
        undefined
      )
    ).toThrow("failed to load")
    expect(text(root)).toContain("Couldn't load React / Babel")
  })
})

describe("buildShell — svg shell", () => {
  test("embeds the raw SVG", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="5"/></svg>`
    const out = buildShell("svg", svg)
    expect(out).toContain(svg)
  })

  test("centers the SVG via flex layout", () => {
    const out = buildShell("svg", "<svg/>")
    expect(out).toContain("display:flex")
    expect(out).toContain("align-items:center")
    expect(out).toContain("justify-content:center")
  })
})

describe("buildShell — mermaid shell", () => {
  test("wraps the diagram source in <pre class=\"mermaid\">", () => {
    const out = buildShell("mermaid", "graph TD\nA --> B")
    expect(out).toContain('<pre class="mermaid">')
    expect(out).toContain("graph TD")
  })

  test("escapes HTML in the diagram source", () => {
    const out = buildShell("mermaid", "graph TD\nA[<script>x</script>] --> B")
    expect(out).toContain("&lt;script&gt;")
    expect(out).not.toContain("<script>x</script>")
  })

  test("calls mermaid.initialize with strict security, loading the pinned build", () => {
    const out = buildShell("mermaid", "graph TD")
    expect(out).toContain("securityLevel: 'strict'")
    expect(out).toContain(cdnScriptTag("mermaid"))
  })
})

// --------------------------------------------------------------------

function sampleContent(shell: "html" | "tsx" | "svg" | "mermaid"): string {
  switch (shell) {
    case "html":
      return "<p>hi</p>"
    case "tsx":
      return "function App(){ return <p>hi</p>; }"
    case "svg":
      return "<svg/>"
    case "mermaid":
      return "graph TD"
  }
}
