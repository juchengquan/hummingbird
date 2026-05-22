import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  __test,
  buildWebSearchTool,
  isBraveConfigured,
  isExaConfigured,
  isTavilyConfigured,
  isWebSearchConfigured,
  type WebSearchLog,
} from "./web-search"

const { clipSnippet, dedupKey, interleaveAndDedupe } = __test

// --- Pure helpers ----------------------------------------------------------

describe("clipSnippet", () => {
  test("short string passes through unchanged", () => {
    expect(clipSnippet("hi")).toBe("hi")
  })
  test("empty string is empty", () => {
    expect(clipSnippet("")).toBe("")
  })
  test("string at the 600-char boundary is unchanged", () => {
    const s = "x".repeat(600)
    expect(clipSnippet(s)).toBe(s)
  })
  test("string over the boundary is clipped with an ellipsis", () => {
    const s = "x".repeat(601)
    const out = clipSnippet(s)
    expect(out.length).toBe(601) // 600 chars + 1-codepoint ellipsis
    expect(out.endsWith("…")).toBe(true)
    expect(out.startsWith("x".repeat(600))).toBe(true)
  })
})

describe("dedupKey", () => {
  test("trailing slash on path is dropped", () => {
    expect(dedupKey("https://example.com/foo/")).toBe(
      dedupKey("https://example.com/foo")
    )
  })
  test("trailing slash on bare host normalises to '/'", () => {
    // Both forms collapse to the same key. Implementation detail: the
    // key uses '/' as the fallback path so a slash and no-slash root
    // are equivalent.
    expect(dedupKey("https://example.com")).toBe(
      dedupKey("https://example.com/")
    )
  })
  test("host casing does not affect the key", () => {
    expect(dedupKey("https://Example.COM/foo")).toBe(
      dedupKey("https://example.com/foo")
    )
  })
  test("utm_* tracking params are stripped", () => {
    expect(dedupKey("https://example.com/p?utm_source=x&id=42")).toBe(
      dedupKey("https://example.com/p?id=42")
    )
  })
  test("fbclid / gclid / igshid / ref / si tracking params are stripped", () => {
    const base = dedupKey("https://example.com/p")
    expect(dedupKey("https://example.com/p?fbclid=abc")).toBe(base)
    expect(dedupKey("https://example.com/p?gclid=abc")).toBe(base)
    expect(dedupKey("https://example.com/p?igshid=abc")).toBe(base)
    expect(dedupKey("https://example.com/p?ref=newsletter")).toBe(base)
    expect(dedupKey("https://example.com/p?si=abc")).toBe(base)
  })
  test("non-tracking query params are preserved (different keys)", () => {
    expect(dedupKey("https://example.com/p?id=1")).not.toBe(
      dedupKey("https://example.com/p?id=2")
    )
  })
  test("different paths produce different keys", () => {
    expect(dedupKey("https://example.com/a")).not.toBe(
      dedupKey("https://example.com/b")
    )
  })
  test("scheme is part of the key (http vs https)", () => {
    // Intentional: we treat http and https as different pages, even
    // when host+path match, since security context differs.
    expect(dedupKey("http://example.com/p")).not.toBe(
      dedupKey("https://example.com/p")
    )
  })
  test("invalid URL falls back to lowercased trimmed string", () => {
    expect(dedupKey("  NOT A URL  ")).toBe("not a url")
  })
})

describe("interleaveAndDedupe", () => {
  const r = (url: string, title = ""): { title: string; url: string; snippet: string } => ({
    title,
    url,
    snippet: "",
  })

  test("empty input → empty output", () => {
    expect(interleaveAndDedupe([])).toEqual([])
    expect(interleaveAndDedupe([[], []])).toEqual([])
  })

  test("single list passes through in order", () => {
    const a = [r("https://a/1"), r("https://a/2")]
    expect(interleaveAndDedupe([a]).map((x) => x.url)).toEqual([
      "https://a/1",
      "https://a/2",
    ])
  })

  test("round-robin across two equal-length lists", () => {
    const a = [r("https://a/1"), r("https://a/2")]
    const b = [r("https://b/1"), r("https://b/2")]
    expect(interleaveAndDedupe([a, b]).map((x) => x.url)).toEqual([
      "https://a/1",
      "https://b/1",
      "https://a/2",
      "https://b/2",
    ])
  })

  test("uneven lengths: shorter list contributes only while it has items", () => {
    const a = [r("https://a/1"), r("https://a/2"), r("https://a/3")]
    const b = [r("https://b/1")]
    expect(interleaveAndDedupe([a, b]).map((x) => x.url)).toEqual([
      "https://a/1",
      "https://b/1",
      "https://a/2",
      "https://a/3",
    ])
  })

  test("three-way round-robin", () => {
    const a = [r("https://a/1"), r("https://a/2")]
    const b = [r("https://b/1"), r("https://b/2")]
    const c = [r("https://c/1"), r("https://c/2")]
    expect(interleaveAndDedupe([a, b, c]).map((x) => x.url)).toEqual([
      "https://a/1",
      "https://b/1",
      "https://c/1",
      "https://a/2",
      "https://b/2",
      "https://c/2",
    ])
  })

  test("dupes within the same list are removed; first occurrence wins", () => {
    const a = [r("https://a/1"), r("https://a/1"), r("https://a/2")]
    expect(interleaveAndDedupe([a]).map((x) => x.url)).toEqual([
      "https://a/1",
      "https://a/2",
    ])
  })

  test("dupes across lists are removed; earlier-list occurrence wins via round-robin", () => {
    // List A's "https://shared" is emitted first (i=0, list A);
    // list B's copy is skipped at (i=0, list B).
    const a = [r("https://shared", "from-a"), r("https://a/2")]
    const b = [r("https://shared", "from-b"), r("https://b/2")]
    const out = interleaveAndDedupe([a, b])
    expect(out.map((x) => x.url)).toEqual([
      "https://shared",
      "https://a/2",
      "https://b/2",
    ])
    expect(out[0].title).toBe("from-a")
  })

  test("URLs that share a dedup key (e.g. utm_* difference) collapse", () => {
    const a = [r("https://example.com/p?utm_source=x")]
    const b = [r("https://example.com/p")]
    expect(interleaveAndDedupe([a, b]).map((x) => x.url)).toEqual([
      "https://example.com/p?utm_source=x",
    ])
  })
})

// --- Provider config detection --------------------------------------------

describe("isXConfigured", () => {
  const ENV = process.env
  beforeEach(() => {
    process.env = { ...ENV }
    delete process.env.TAVILY_API_KEY
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.EXA_API_KEY
  })
  afterEach(() => {
    process.env = ENV
  })
  test("each returns false when its env var is unset", () => {
    expect(isTavilyConfigured()).toBe(false)
    expect(isBraveConfigured()).toBe(false)
    expect(isExaConfigured()).toBe(false)
    expect(isWebSearchConfigured()).toBe(false)
  })
  test("each returns true when its env var is set", () => {
    process.env.TAVILY_API_KEY = "x"
    process.env.BRAVE_SEARCH_API_KEY = "x"
    process.env.EXA_API_KEY = "x"
    expect(isTavilyConfigured()).toBe(true)
    expect(isBraveConfigured()).toBe(true)
    expect(isExaConfigured()).toBe(true)
    expect(isWebSearchConfigured()).toBe(true)
  })
  test("isWebSearchConfigured is true when any single provider is set", () => {
    process.env.EXA_API_KEY = "x"
    expect(isWebSearchConfigured()).toBe(true)
  })
})

// --- Integration via buildWebSearchTool -----------------------------------

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Per-URL fetch router. Tests register a handler per upstream endpoint;
 * unmatched URLs throw so an unexpected outbound call is loud rather
 * than silently returning an empty response.
 */
function installFetchRouter(handlers: Record<string, FetchHandler>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (url.startsWith(prefix)) return handler(url, init)
    }
    throw new Error(`unrouted fetch: ${url}`)
  }) as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function execTool(t: ReturnType<typeof buildWebSearchTool>, query: string) {
  if (!t || typeof t.execute !== "function") {
    throw new Error("expected a tool with execute()")
  }
  return t.execute(
    { query },
    { toolCallId: "test", messages: [] }
  ) as Promise<{
    query?: string
    results: { title: string; url: string; snippet: string }[]
    error?: string
  }>
}

describe("buildWebSearchTool", () => {
  const ENV = process.env
  const REAL_FETCH = globalThis.fetch

  beforeEach(() => {
    process.env = { ...ENV }
    delete process.env.TAVILY_API_KEY
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.EXA_API_KEY
  })
  afterEach(() => {
    process.env = ENV
    globalThis.fetch = REAL_FETCH
  })

  test("returns null when no provider has an API key", () => {
    expect(buildWebSearchTool([])).toBeNull()
  })

  test("returns null when every provider is explicitly disabled", () => {
    process.env.TAVILY_API_KEY = "x"
    process.env.BRAVE_SEARCH_API_KEY = "x"
    process.env.EXA_API_KEY = "x"
    const t = buildWebSearchTool([], {
      tavily: { enabled: false, searchDepth: "basic" },
      brave: { enabled: false, freshness: "any" },
      exa: { enabled: false, type: "auto" },
    })
    expect(t).toBeNull()
  })

  test("happy path: dispatches to enabled providers in parallel and interleaves", async () => {
    process.env.TAVILY_API_KEY = "tav"
    process.env.BRAVE_SEARCH_API_KEY = "brv"
    process.env.EXA_API_KEY = "exa"
    installFetchRouter({
      "https://api.tavily.com": async () =>
        jsonResponse({
          results: [
            { title: "T1", url: "https://t/1", content: "t-snippet-1" },
            { title: "T2", url: "https://t/2", content: "t-snippet-2" },
          ],
        }),
      "https://api.search.brave.com": async () =>
        jsonResponse({
          web: {
            results: [
              { title: "B1", url: "https://b/1", description: "b-snippet-1" },
            ],
          },
        }),
      "https://api.exa.ai": async () =>
        jsonResponse({
          results: [
            { title: "E1", url: "https://e/1", text: "e-snippet-1" },
          ],
        }),
    })
    const log: WebSearchLog = []
    const t = buildWebSearchTool(log)
    const out = await execTool(t, "anything")
    expect(out.error).toBeUndefined()
    // Provider order is tavily → brave → exa (registration order).
    expect(out.results.map((r) => r.url)).toEqual([
      "https://t/1",
      "https://b/1",
      "https://e/1",
      "https://t/2",
    ])
    expect(out.results[0]).toMatchObject({ title: "T1", snippet: "t-snippet-1" })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      providers: expect.arrayContaining(["tavily", "brave", "exa"]),
      query: "anything",
      resultCount: 4,
    })
  })

  test("one provider's HTTP 500 doesn't suppress the others", async () => {
    process.env.TAVILY_API_KEY = "tav"
    process.env.BRAVE_SEARCH_API_KEY = "brv"
    installFetchRouter({
      "https://api.tavily.com": async () => jsonResponse({}, 500),
      "https://api.search.brave.com": async () =>
        jsonResponse({
          web: {
            results: [
              { title: "B1", url: "https://b/1", description: "ok" },
            ],
          },
        }),
    })
    const t = buildWebSearchTool([])
    const out = await execTool(t, "q")
    expect(out.error).toBeUndefined()
    expect(out.results.map((r) => r.url)).toEqual(["https://b/1"])
  })

  test("all providers failing surfaces an aggregated error", async () => {
    process.env.TAVILY_API_KEY = "tav"
    process.env.BRAVE_SEARCH_API_KEY = "brv"
    installFetchRouter({
      "https://api.tavily.com": async () => jsonResponse({}, 500),
      "https://api.search.brave.com": async () => jsonResponse({}, 502),
    })
    const t = buildWebSearchTool([])
    const out = await execTool(t, "q")
    expect(out.results).toEqual([])
    expect(out.error).toMatch(/All providers failed/)
    expect(out.error).toMatch(/tavily:/)
    expect(out.error).toMatch(/brave:/)
  })

  test("dedupes by URL across providers (utm differences collapse)", async () => {
    process.env.TAVILY_API_KEY = "tav"
    process.env.BRAVE_SEARCH_API_KEY = "brv"
    installFetchRouter({
      "https://api.tavily.com": async () =>
        jsonResponse({
          results: [
            {
              title: "T",
              url: "https://shared.example/p?utm_source=t",
              content: "from-tavily",
            },
          ],
        }),
      "https://api.search.brave.com": async () =>
        jsonResponse({
          web: {
            results: [
              { title: "B", url: "https://shared.example/p", description: "from-brave" },
            ],
          },
        }),
    })
    const t = buildWebSearchTool([])
    const out = await execTool(t, "q")
    expect(out.results).toHaveLength(1)
    // Tavily ran first in registration order → its result wins.
    expect(out.results[0].title).toBe("T")
  })

  test("caps each provider's results at PER_PROVIDER_RESULTS (5)", async () => {
    process.env.TAVILY_API_KEY = "tav"
    const tavilyResults = Array.from({ length: 10 }, (_, i) => ({
      title: `T${i}`,
      url: `https://t/${i}`,
      content: `s${i}`,
    }))
    installFetchRouter({
      "https://api.tavily.com": async () => jsonResponse({ results: tavilyResults }),
    })
    const t = buildWebSearchTool([])
    const out = await execTool(t, "q")
    expect(out.results).toHaveLength(5)
    expect(out.results.map((r) => r.url)).toEqual([
      "https://t/0",
      "https://t/1",
      "https://t/2",
      "https://t/3",
      "https://t/4",
    ])
  })

  test("Brave: freshness='any' is NOT sent as a query param", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "brv"
    let observedUrl = ""
    installFetchRouter({
      "https://api.search.brave.com": async (u) => {
        observedUrl = u
        return jsonResponse({ web: { results: [] } })
      },
    })
    const t = buildWebSearchTool([], { brave: { enabled: true, freshness: "any" } })
    await execTool(t, "q")
    expect(observedUrl).toContain("q=q")
    expect(observedUrl).not.toContain("freshness=")
  })

  test("Brave: non-'any' freshness IS sent through", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "brv"
    let observedUrl = ""
    installFetchRouter({
      "https://api.search.brave.com": async (u) => {
        observedUrl = u
        return jsonResponse({ web: { results: [] } })
      },
    })
    const t = buildWebSearchTool([], { brave: { enabled: true, freshness: "pw" } })
    await execTool(t, "q")
    expect(observedUrl).toContain("freshness=pw")
  })

  test("Exa: 'type' is forwarded in the request body", async () => {
    process.env.EXA_API_KEY = "exa"
    let observedBody: Record<string, unknown> = {}
    installFetchRouter({
      "https://api.exa.ai": async (_u, init) => {
        observedBody = JSON.parse(init?.body as string)
        return jsonResponse({ results: [] })
      },
    })
    const t = buildWebSearchTool([], { exa: { enabled: true, type: "neural" } })
    await execTool(t, "q")
    expect(observedBody.type).toBe("neural")
    expect(observedBody.query).toBe("q")
  })

  test("Exa: falls back to `summary` when `text` is null/missing", async () => {
    process.env.EXA_API_KEY = "exa"
    installFetchRouter({
      "https://api.exa.ai": async () =>
        jsonResponse({
          results: [
            { title: "E1", url: "https://e/1", text: null, summary: "fallback-summary" },
            { title: "E2", url: "https://e/2", text: "from-text", summary: "ignored" },
          ],
        }),
    })
    const t = buildWebSearchTool([])
    const out = await execTool(t, "q")
    expect(out.results[0].snippet).toBe("fallback-summary")
    expect(out.results[1].snippet).toBe("from-text")
  })

  test("Brave: results without a string url are filtered out", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "brv"
    installFetchRouter({
      "https://api.search.brave.com": async () =>
        jsonResponse({
          web: {
            results: [
              { title: "no-url-1" },
              { title: "B1", url: "https://b/1", description: "ok" },
              { title: "wrong-type", url: 42 as unknown },
            ],
          },
        }),
    })
    const t = buildWebSearchTool([])
    const out = await execTool(t, "q")
    expect(out.results.map((r) => r.url)).toEqual(["https://b/1"])
  })

  test("per-turn maxCalls cap refuses the (N+1)th invocation", async () => {
    process.env.TAVILY_API_KEY = "tav"
    installFetchRouter({
      "https://api.tavily.com": async () =>
        jsonResponse({ results: [{ title: "T", url: "https://t/1", content: "" }] }),
    })
    const log: WebSearchLog = []
    const t = buildWebSearchTool(log, { maxCalls: 1 })
    const first = await execTool(t, "q1")
    expect(first.error).toBeUndefined()
    const second = await execTool(t, "q2")
    expect(second.results).toEqual([])
    expect(second.error).toMatch(/budget exhausted/i)
    // The refused call should not be logged.
    expect(log).toHaveLength(1)
  })

  test("per-IP budget refused returns retry-after error and skips dispatch", async () => {
    process.env.TAVILY_API_KEY = "tav"
    let fetchCalls = 0
    installFetchRouter({
      "https://api.tavily.com": async () => {
        fetchCalls++
        return jsonResponse({ results: [] })
      },
    })
    const t = buildWebSearchTool(
      [],
      undefined,
      undefined,
      () => ({ allowed: false, retryAfterSec: 42 })
    )
    const out = await execTool(t, "q")
    expect(out.error).toMatch(/rate limit/i)
    expect(out.error).toMatch(/42s/)
    expect(fetchCalls).toBe(0)
  })

  test("upstream abort signal triggers timeout error", async () => {
    process.env.TAVILY_API_KEY = "tav"
    // A handler that hangs until the per-call signal aborts.
    installFetchRouter({
      "https://api.tavily.com": (_u, init) =>
        new Promise((_, reject) => {
          const signal = init?.signal
          if (!signal) {
            reject(new Error("test: expected an abort signal"))
            return
          }
          signal.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted") as Error & { name: string }
              err.name = "AbortError"
              reject(err)
            },
            { once: true }
          )
        }),
    })
    const upstream = new AbortController()
    const t = buildWebSearchTool([], undefined, upstream.signal)
    const pending = execTool(t, "q")
    upstream.abort()
    const out = await pending
    // With only one provider and that provider aborted, merged === []
    // → tool surfaces the aggregated "All providers failed: tavily: …"
    // error with the provider's message ("timed out" or "aborted",
    // depending on which signal fires first).
    expect(out.results).toEqual([])
    expect(out.error).toMatch(/tavily:/i)
  })
})
