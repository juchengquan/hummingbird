import { describe, expect, test } from "bun:test"

import { CDN_HOSTS, CDN_SCRIPTS } from "@/shared/live-artifact/cdn-urls"
import {
  parseRenderMessage,
  renderMessage,
  SANDBOX_FRAME_NS,
  shellReadyMessage,
} from "@/shared/sandbox-frame"

import { CSP_REPORT_PATH } from "./csp"
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

  test("keeps the image / font reach the srcdoc shells had", () => {
    expect(d.get("img-src")).toEqual(["data:", "blob:", "https:"])
    expect(d.get("font-src")).toEqual(["data:", "https:"])
  })

  test("framable only by the app; opaque origin even without the iframe attribute", () => {
    expect(d.get("frame-ancestors")).toEqual(["'self'"])
    expect(d.get("sandbox")).toEqual(["allow-scripts"])
    expect(d.get("sandbox")).not.toContain("allow-same-origin")
  })

  test("doesn't report untrusted code's violations to the app's endpoint", () => {
    expect(d.has("report-uri")).toBe(false)
    expect(d.has("report-to")).toBe(false)
    expect(buildSandboxFrameCsp()).not.toContain(CSP_REPORT_PATH)
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

interface Posted {
  data: unknown
  target: string
}

function runBootstrap(opts: { topLevel?: boolean; readyState?: string } = {}) {
  const posted: Posted[] = []
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const docListeners = new Map<string, Array<() => void>>()
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
    readyState: opts.readyState ?? "interactive",
    addEventListener: (t: string, fn: () => void) => {
      docListeners.set(t, [...(docListeners.get(t) ?? []), fn])
    },
    open: () => calls.push("open"),
    write: (html: string) => {
      calls.push("write")
      written.push(html)
    },
    close: () => calls.push("close"),
  }
  const location = { origin: APP_ORIGIN }

  new Function("window", "document", "location", sandboxFrameBootstrapScript())(win, doc, location)

  return {
    posted,
    written,
    calls,
    parent,
    win,
    listenerCount: () => listeners.get("message")?.size ?? 0,
    fireDomContentLoaded: () => docListeners.get("DOMContentLoaded")?.forEach((fn) => fn()),
    deliver: (data: unknown, from: { source?: unknown; origin?: string } = {}) => {
      const e = { data, source: from.source ?? parent, origin: from.origin ?? APP_ORIGIN }
      for (const fn of [...(listeners.get("message") ?? [])]) fn(e)
    },
  }
}

describe("sandbox frame bootstrap", () => {
  test("announces shell-ready to the parent once parsed", () => {
    const f = runBootstrap()
    expect(f.posted).toEqual([{ data: shellReadyMessage(), target: "*" }])
  })

  test("waits for DOMContentLoaded while the shell is still parsing", () => {
    const f = runBootstrap({ readyState: "loading" })
    expect(f.posted).toEqual([])
    f.fireDomContentLoaded()
    expect(f.posted).toEqual([{ data: shellReadyMessage(), target: "*" }])
  })

  test("renders a valid render message from the parent exactly once", () => {
    const f = runBootstrap()
    f.deliver(renderMessage("<p>one</p>"))
    expect(f.calls).toEqual(["open", "write", "close"])
    expect(f.written).toEqual(["<p>one</p>"])
    // The listener is gone; a second render can't replace the content.
    expect(f.listenerCount()).toBe(0)
    f.deliver(renderMessage("<p>two</p>"))
    expect(f.written).toEqual(["<p>one</p>"])
  })

  test("ignores render messages from anything but the framing app page", () => {
    const f = runBootstrap()
    f.deliver(renderMessage("x"), { source: {} }) // sibling frame / popup
    f.deliver(renderMessage("x"), { source: f.win }) // itself
    f.deliver(renderMessage("x"), { origin: "https://evil.example" })
    f.deliver(renderMessage("x"), { origin: "null" })
    expect(f.calls).toEqual([])
    expect(f.listenerCount()).toBe(1)
  })

  test("accepts exactly what parseRenderMessage accepts", () => {
    const candidates: unknown[] = [
      renderMessage("<i>ok</i>"),
      renderMessage(""),
      null,
      "string",
      { ns: SANDBOX_FRAME_NS, type: "render" },
      { ns: SANDBOX_FRAME_NS, type: "render", html: 7 },
      { ns: SANDBOX_FRAME_NS, type: "shell-ready", html: "x" },
      { ns: "live-artifact", type: "render", html: "x" },
    ]
    for (const c of candidates) {
      const f = runBootstrap()
      f.deliver(c)
      const expected = parseRenderMessage(c)
      expect(f.written).toEqual(expected === null ? [] : [expected])
    }
  })

  test("opened top-level (not framed): never announces, never renders", () => {
    const f = runBootstrap({ topLevel: true })
    expect(f.posted).toEqual([])
    f.deliver(renderMessage("x"), { source: f.win })
    expect(f.calls).toEqual([])
  })
})
