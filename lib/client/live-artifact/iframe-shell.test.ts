import { describe, expect, test } from "bun:test"

import { CDN_HOSTS, CDN_URLS } from "./cdn-urls"
import { buildShell, IFRAME_MESSAGE_NS } from "./iframe-shell"

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

describe("buildShell — html shell", () => {
  test("snippets get wrapped in a Tailwind envelope", () => {
    const out = buildShell("html", "<button>Click me</button>")
    expect(out).toContain("<!doctype html>")
    expect(out).toContain(CDN_URLS.tailwind)
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

describe("buildShell — tsx shell", () => {
  test("mounts a named App component", () => {
    const code = `function App() { return <div>hi</div>; }`
    const out = buildShell("tsx", code)
    expect(out).toContain("React.createElement(App)")
  })

  test("mounts a named Demo when App is absent", () => {
    const code = `function Demo() { return <div>hi</div>; }`
    const out = buildShell("tsx", code)
    expect(out).toContain("React.createElement(Demo)")
  })

  test("mounts the last declared identifier when App/Demo are absent", () => {
    const code = `function First() { return <span/>; }\nfunction Second() { return <em/>; }`
    const out = buildShell("tsx", code)
    expect(out).toContain("React.createElement(Second)")
  })

  test("honours `export default function Name`", () => {
    const code = `export default function Greeting() { return <p>hi</p>; }`
    const out = buildShell("tsx", code)
    expect(out).toContain("React.createElement(Greeting)")
    // export keyword stripped (would crash in non-module script context)
    expect(out).not.toContain("export default function Greeting")
  })

  test("honours `export default class Name`", () => {
    const code = `export default class Widget extends React.Component { render() { return <p/>; } }`
    const out = buildShell("tsx", code)
    expect(out).toContain("React.createElement(Widget)")
  })

  test("honours `export default <identifier>`", () => {
    const code = `function App() { return <p/>; }\nexport default App;`
    const out = buildShell("tsx", code)
    expect(out).toContain("React.createElement(App)")
    expect(out).not.toContain("export default App")
  })

  test("honours anonymous default export (`export default function() {}`)", () => {
    const code = `export default function() { return <p>anon</p>; }`
    const out = buildShell("tsx", code)
    expect(out).toContain("React.createElement(__defaultExport)")
  })

  test("strips `import React from \"react\"` lines", () => {
    const code = `import React from "react";\nfunction App() { return <p/>; }`
    const out = buildShell("tsx", code)
    expect(out).not.toContain('import React from "react"')
    expect(out).toContain("function App")
  })

  test("strips named imports", () => {
    const code = `import { useState, useEffect } from "react";\nfunction App() { return <p/>; }`
    const out = buildShell("tsx", code)
    expect(out).not.toContain("from \"react\"")
  })

  test("strips bare side-effect imports", () => {
    const code = `import "./styles.css";\nfunction App() { return <p/>; }`
    const out = buildShell("tsx", code)
    expect(out).not.toContain('import "./styles.css"')
  })

  test("renders an in-iframe error when nothing mountable found", () => {
    const code = `const x = 1; // just declarations, no JSX components`
    const out = buildShell("tsx", code)
    // No `React.createElement` mount call when we can't find a name.
    expect(out).not.toContain("React.createElement(x)")
    expect(out).toContain("No mountable component found")
  })

  test("includes Babel + React + ReactDOM + Tailwind CDN scripts", () => {
    const out = buildShell("tsx", "function App(){ return <p/>; }")
    expect(out).toContain(CDN_URLS.babel)
    expect(out).toContain(CDN_URLS.react)
    expect(out).toContain(CDN_URLS.reactDom)
    expect(out).toContain(CDN_URLS.tailwind)
  })

  test('uses data-presets="react,typescript" on the Babel script', () => {
    const out = buildShell("tsx", "function App(){ return <p/>; }")
    expect(out).toContain('data-presets="react,typescript"')
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

  test("calls mermaid.initialize with strict security", () => {
    const out = buildShell("mermaid", "graph TD")
    expect(out).toContain("securityLevel: 'strict'")
    expect(out).toContain(CDN_URLS.mermaid)
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
