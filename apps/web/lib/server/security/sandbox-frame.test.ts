import { describe, expect, test } from "bun:test"

import { CDN_HOSTS, CDN_SCRIPTS } from "@/shared/live-artifact/cdn-urls"
import {
  navigatingMessage,
  parseRenderMessage,
  renderMessage,
  SANDBOX_FRAME_NS,
  shellReadyMessage,
} from "@/shared/sandbox-frame"

import { BACKEND_CSP_REPORT_PATH } from "./csp"
import {
  buildSandboxFrameCsp,
  buildSandboxFrameDirectives,
  buildSandboxFrameDocument,
  sandboxFrameBootstrapScript,
  sandboxFrameHeaders,
} from "./sandbox-frame"

function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) out.set(name, sources)
  }
  return out
}

describe("buildSandboxFrameCsp", () => {
  const d = directives(buildSandboxFrameCsp())

  test("serialises every directive once", () => {
    const names = buildSandboxFrameDirectives().map(([n]) => n)
    expect(new Set(names).size).toBe(names.length)
    expect([...d.keys()]).toEqual(names)
  })

  test("locks everything down by default", () => {
    expect(d.get("default-src")).toEqual(["'none'"])
    expect(d.get("connect-src")).toEqual(["'none'"])
    expect(d.get("base-uri")).toEqual(["'none'"])
    expect(d.get("form-action")).toEqual(["'none'"])
  })

  test("lets inline / eval / pinned-CDN artifact scripts run", () => {
    expect(d.get("script-src")).toEqual(["'unsafe-inline'", "'unsafe-eval'", ...CDN_HOSTS])
    expect(d.get("style-src")).toEqual(["'unsafe-inline'", ...CDN_HOSTS])
  })

  test("never carries a nonce, hash or 'strict-dynamic' (they disable 'unsafe-inline')", () => {
    const policy = buildSandboxFrameCsp()
    expect(policy).not.toMatch(/'nonce-|'sha(256|384|512)-|'strict-dynamic'/)
  })

  test("no 'self' in script-src: artifacts can't load the app's own scripts", () => {
    expect(d.get("script-src")).not.toContain("'self'")
  })

  test("every pinned CDN URL is served from an allowed host", () => {
    for (const { src } of Object.values(CDN_SCRIPTS)) {
      expect(CDN_HOSTS as readonly string[]).toContain(new URL(src).origin)
    }
  })

  test("allows no CDN host that no pinned script uses", () => {
    const used = new Set(Object.values(CDN_SCRIPTS).map(({ src }) => new URL(src).origin))
    expect([...used].sort()).toEqual([...CDN_HOSTS].sort())
  })

  test("remote images stay allowed; fonts only inline or from the pinned CDNs", () => {
    expect(d.get("img-src")).toEqual(["data:", "blob:", "https:"])
    expect(d.get("font-src")).toEqual(["data:", "blob:", ...CDN_HOSTS])
    expect(d.get("font-src")).not.toContain("https:")
  })

  test("framable only by the app; opaque origin even without the iframe attribute", () => {
    expect(d.get("frame-ancestors")).toEqual(["'self'"])
    expect(d.get("sandbox")).toEqual(["allow-scripts"])
    expect(d.get("sandbox")).not.toContain("allow-same-origin")
  })

  test("doesn't report untrusted code's violations to the app's endpoint", () => {
    expect(d.has("report-uri")).toBe(false)
    expect(d.has("report-to")).toBe(false)
    expect(buildSandboxFrameCsp()).not.toContain(BACKEND_CSP_REPORT_PATH)
  })
})

describe("sandboxFrameHeaders", () => {
  test("enforced CSP (never Report-Only), framable by same origin, HTML", () => {
    const h = sandboxFrameHeaders()
    expect(h["Content-Security-Policy"]).toBe(buildSandboxFrameCsp())
    expect(Object.keys(h)).not.toContain("Content-Security-Policy-Report-Only")
    expect(h["X-Frame-Options"]).toBe("SAMEORIGIN")
    expect(h["Content-Type"]).toBe("text/html; charset=utf-8")
  })
})

describe("buildSandboxFrameDocument", () => {
  test("is a tiny inline-bootstrap document with no external resources", () => {
    const doc = buildSandboxFrameDocument()
    expect(doc.startsWith("<!doctype html>")).toBe(true)
    expect(doc).toContain(sandboxFrameBootstrapScript())
    expect(doc).not.toMatch(/\ssrc=|<link\b/)
  })
})

// ---------------------------------------------------------------------
// The bootstrap runs in the browser, so drive it against stub globals.
// ---------------------------------------------------------------------

const APP_ORIGIN = "https://app.example"
const N = "0123456789abcdef0123456789abcdef"

interface Posted {
  data: unknown
  target: string
}

function runBootstrap(
  opts: { topLevel?: boolean; readyState?: string; search?: string } = {}
) {
  const posted: Posted[] = []
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const written: string[] = []
  const calls: string[] = []

  const parent = {
    postMessage: (data: unknown, target: string) => posted.push({ data, target }),
  }
  const win: Record<string, unknown> = {
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set())
      listeners.get(t)!.add(fn)
    },
    removeEventListener: (t: string, fn: (e: unknown) => void) => {
      listeners.get(t)?.delete(fn)
    },
  }
  win.parent = opts.topLevel ? win : parent
  const doc = {
    readyState: opts.readyState ?? "complete",
    open: () => {
      calls.push("open")
      // document.open() erases every listener on the window.
      listeners.clear()
    },
    write: (html: string) => {
      calls.push("write")
      written.push(html)
    },
    close: () => calls.push("close"),
  }
  const location = { origin: APP_ORIGIN, search: opts.search ?? `?n=${N}` }

  new Function("window", "document", "location", sandboxFrameBootstrapScript())(win, doc, location)

  const fire = (type: string, e: unknown = {}) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(e)
  }
  return {
    posted,
    written,
    calls,
    parent,
    win,
    listenerCount: () => listeners.get("message")?.size ?? 0,
    fire,
    deliver: (data: unknown, from: { source?: unknown; origin?: string } = {}) => {
      fire("message", { data, source: from.source ?? parent, origin: from.origin ?? APP_ORIGIN })
    },
  }
}

describe("sandbox frame bootstrap", () => {
  test("announces shell-ready with this navigation's nonce once loaded", () => {
    const f = runBootstrap()
    expect(f.posted).toEqual([{ data: shellReadyMessage(N), target: "*" }])
  })

  test("waits for load while the shell is still loading", () => {
    for (const readyState of ["loading", "interactive"]) {
      const f = runBootstrap({ readyState })
      expect(f.posted).toEqual([])
      f.fire("load")
      expect(f.posted).toEqual([{ data: shellReadyMessage(N), target: "*" }])
    }
  })

  test("no (valid) nonce in the URL: inert", () => {
    for (const search of ["", "?x=1", "?n=short", "?n=<script>aaaaaaaaaaaaaaaa", `?nn=${N}`]) {
      const f = runBootstrap({ search })
      expect(f.posted).toEqual([])
      f.deliver(renderMessage("x", N))
      expect(f.calls).toEqual([])
    }
  })

  test("reads the nonce among other query params", () => {
    const f = runBootstrap({ search: `?a=1&n=${N}&b=2` })
    expect(f.posted).toEqual([{ data: shellReadyMessage(N), target: "*" }])
  })

  test("renders a valid render message from the parent exactly once", () => {
    const f = runBootstrap()
    f.deliver(renderMessage("<p>one</p>", N))
    expect(f.calls).toEqual(["open", "write", "close"])
    expect(f.written).toEqual(["<p>one</p>"])
    // The listener is gone; a second render can't replace the content.
    expect(f.listenerCount()).toBe(0)
    f.deliver(renderMessage("<p>two</p>", N))
    expect(f.written).toEqual(["<p>one</p>"])
  })

  test("a render for another navigation's nonce is ignored", () => {
    const f = runBootstrap()
    f.deliver(renderMessage("<p>stale</p>", "ffffffffffffffffffffffffffffffff"))
    expect(f.calls).toEqual([])
    expect(f.listenerCount()).toBe(1)
  })

  test("after rendering, pagehide tells the parent the frame is navigating away", () => {
    const f = runBootstrap()
    f.deliver(renderMessage("<p>one</p>", N))
    f.posted.length = 0
    f.fire("pagehide")
    expect(f.posted).toEqual([{ data: navigatingMessage(N), target: "*" }])
  })

  test("the rendered content can't stub addEventListener before the hook is added", () => {
    const f = runBootstrap()
    const realAdd = f.win.addEventListener
    // What `document.write(html)` running a script could do.
    f.win.addEventListener = () => {}
    f.deliver(renderMessage("<p>one</p>", N))
    f.win.addEventListener = realAdd
    f.posted.length = 0
    f.fire("pagehide")
    expect(f.posted).toEqual([{ data: navigatingMessage(N), target: "*" }])
  })

  test("ignores render messages from anything but the framing app page", () => {
    const f = runBootstrap()
    f.deliver(renderMessage("x", N), { source: {} }) // sibling frame / popup
    f.deliver(renderMessage("x", N), { source: f.win }) // itself
    f.deliver(renderMessage("x", N), { origin: "https://evil.example" })
    f.deliver(renderMessage("x", N), { origin: "null" })
    expect(f.calls).toEqual([])
    expect(f.listenerCount()).toBe(1)
  })

  test("accepts exactly what parseRenderMessage accepts", () => {
    const candidates: unknown[] = [
      renderMessage("<i>ok</i>", N),
      renderMessage("", N),
      renderMessage("x", "ffffffffffffffffffffffffffffffff"),
      null,
      "string",
      { ns: SANDBOX_FRAME_NS, type: "render", nonce: N },
      { ns: SANDBOX_FRAME_NS, type: "render", nonce: N, html: 7 },
      { ns: SANDBOX_FRAME_NS, type: "render", html: "x" },
      { ns: SANDBOX_FRAME_NS, type: "shell-ready", nonce: N, html: "x" },
      { ns: "live-artifact", type: "render", nonce: N, html: "x" },
    ]
    for (const c of candidates) {
      const f = runBootstrap()
      f.deliver(c)
      const expected = parseRenderMessage(c, N)
      expect(f.written).toEqual(expected === null ? [] : [expected])
    }
  })

  test("opened top-level (not framed): never announces, never renders", () => {
    const f = runBootstrap({ topLevel: true })
    expect(f.posted).toEqual([])
    f.deliver(renderMessage("x", N), { source: f.win })
    expect(f.calls).toEqual([])
  })
})
