import { describe, expect, test } from "bun:test"
import {
  clientIpFromHeaders,
  createSlidingWindow,
  proxyConfigWarning,
  rateLimitKey,
  trustedProxyHopsFromEnv,
  warnOnProxyConfig,
} from "./rate-limit"

describe("createSlidingWindow", () => {
  test("first N calls allowed; (N+1)th refused with retry-after", () => {
    const realNow = Date.now
    const t0 = realNow()
    Date.now = () => t0
    try {
      const limit = createSlidingWindow({ windowMs: 60_000, max: 3 })
      expect(limit.consume("a").allowed).toBe(true)
      expect(limit.consume("a").allowed).toBe(true)
      expect(limit.consume("a").allowed).toBe(true)
      const refused = limit.consume("a")
      expect(refused.allowed).toBe(false)
      expect(refused.retryAfterSec).toBeGreaterThan(0)
      expect(refused.retryAfterSec).toBeLessThanOrEqual(60)
    } finally {
      Date.now = realNow
    }
  })

  test("buckets are per-key (one key's exhaustion doesn't block another)", () => {
    const limit = createSlidingWindow({ windowMs: 60_000, max: 1 })
    expect(limit.consume("a").allowed).toBe(true)
    expect(limit.consume("a").allowed).toBe(false)
    expect(limit.consume("b").allowed).toBe(true)
  })

  test("after the window expires, the key is allowed again", () => {
    const realNow = Date.now
    const t0 = realNow()
    Date.now = () => t0
    try {
      const limit = createSlidingWindow({ windowMs: 60_000, max: 1 })
      expect(limit.consume("a").allowed).toBe(true)
      expect(limit.consume("a").allowed).toBe(false)
      Date.now = () => t0 + 60_001
      expect(limit.consume("a").allowed).toBe(true)
    } finally {
      Date.now = realNow
    }
  })

  test("retryAfterSec reflects the oldest entry's age", () => {
    const realNow = Date.now
    const t0 = realNow()
    Date.now = () => t0
    try {
      const limit = createSlidingWindow({ windowMs: 60_000, max: 1 })
      limit.consume("a")
      Date.now = () => t0 + 30_000
      const refused = limit.consume("a")
      expect(refused.allowed).toBe(false)
      expect(refused.retryAfterSec).toBe(30)
    } finally {
      Date.now = realNow
    }
  })
})

describe("createSlidingWindow — bucket eviction", () => {
  test("periodic sweep drops buckets whose entries aged out", () => {
    const realNow = Date.now
    const t0 = realNow()
    Date.now = () => t0
    try {
      const limit = createSlidingWindow({ windowMs: 60_000, max: 5 })
      for (let i = 0; i < 100; i++) limit.consume(`ip-${i}`)
      expect(limit._size()).toBe(100)
      // One window later, the next consume sweeps every stale bucket.
      Date.now = () => t0 + 60_000
      limit.consume("fresh")
      expect(limit._size()).toBe(1)
    } finally {
      Date.now = realNow
    }
  })

  test("hard cap evicts least-recently-used buckets", () => {
    const limit = createSlidingWindow({ windowMs: 60_000, max: 5, maxBuckets: 3 })
    limit.consume("a")
    limit.consume("b")
    limit.consume("c")
    limit.consume("a") // touch → "b" is now least-recently-used
    limit.consume("d")
    expect(limit._size()).toBe(3)
    // "a" kept its history (2 hits) — "b" was the one evicted.
    for (let i = 0; i < 3; i++) expect(limit.consume("a").allowed).toBe(true)
    expect(limit.consume("a").allowed).toBe(false)
  })

  test("cap never exceeded under a flood of distinct keys", () => {
    const limit = createSlidingWindow({ windowMs: 60_000, max: 1, maxBuckets: 50 })
    for (let i = 0; i < 1_000; i++) limit.consume(`k-${i}`)
    expect(limit._size()).toBe(50)
  })
})

describe("clientIpFromHeaders", () => {
  const h = (init: Record<string, string>) => new Headers(init)
  const selfHosted = { trustedProxyHops: 1, trustPlatformHeaders: false }

  test("one trusted proxy → right-most XFF entry", () => {
    expect(
      clientIpFromHeaders(h({ "x-forwarded-for": "203.0.113.7" }), selfHosted),
    ).toBe("203.0.113.7")
  })

  test("spoofed left-most entries are ignored", () => {
    // Client sent `X-Forwarded-For: 1.1.1.1, 2.2.2.2`; our proxy appended
    // the real peer address.
    expect(
      clientIpFromHeaders(
        h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.7" }),
        selfHosted,
      ),
    ).toBe("203.0.113.7")
  })

  test("two trusted hops → second entry from the right", () => {
    expect(
      clientIpFromHeaders(
        h({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.2" }),
        { trustedProxyHops: 2, trustPlatformHeaders: false },
      ),
    ).toBe("203.0.113.7")
  })

  test("fewer entries than hops → left-most entry", () => {
    expect(
      clientIpFromHeaders(h({ "x-forwarded-for": "203.0.113.7" }), {
        trustedProxyHops: 3,
        trustPlatformHeaders: false,
      }),
    ).toBe("203.0.113.7")
  })

  test("zero hops → XFF ignored", () => {
    expect(
      clientIpFromHeaders(h({ "x-forwarded-for": "203.0.113.7" }), {
        trustedProxyHops: 0,
        trustPlatformHeaders: false,
      }),
    ).toBeNull()
  })

  test("platform headers win only when trusted", () => {
    const headers = h({
      "x-real-ip": "198.51.100.1",
      "x-forwarded-for": "6.6.6.6, 203.0.113.7",
    })
    expect(clientIpFromHeaders(headers, selfHosted)).toBe("203.0.113.7")
    expect(
      clientIpFromHeaders(headers, { trustedProxyHops: 1, trustPlatformHeaders: true }),
    ).toBe("198.51.100.1")
    expect(
      clientIpFromHeaders(h({ "x-vercel-forwarded-for": "198.51.100.2" }), {
        trustedProxyHops: 1,
        trustPlatformHeaders: true,
      }),
    ).toBe("198.51.100.2")
  })

  test("missing / empty / oversized values → null", () => {
    expect(clientIpFromHeaders(h({}), selfHosted)).toBeNull()
    expect(clientIpFromHeaders(h({ "x-forwarded-for": " , " }), selfHosted)).toBeNull()
    expect(
      clientIpFromHeaders(h({ "x-forwarded-for": "x".repeat(200) }), selfHosted),
    ).toBeNull()
  })
})

describe("trustedProxyHopsFromEnv", () => {
  test("defaults to 1 when unset / blank / invalid", () => {
    expect(trustedProxyHopsFromEnv(undefined)).toBe(1)
    expect(trustedProxyHopsFromEnv("")).toBe(1)
    expect(trustedProxyHopsFromEnv("-1")).toBe(1)
    expect(trustedProxyHopsFromEnv("1.5")).toBe(1)
    expect(trustedProxyHopsFromEnv("abc")).toBe(1)
  })
  test("accepts non-negative integers", () => {
    expect(trustedProxyHopsFromEnv("0")).toBe(0)
    expect(trustedProxyHopsFromEnv("2")).toBe(2)
  })
})

describe("rateLimitKey", () => {
  test("uses TRUSTED_PROXY_HOPS and falls back to the shared bucket", () => {
    const prevHops = process.env.TRUSTED_PROXY_HOPS
    const prevVercel = process.env.VERCEL
    delete process.env.VERCEL
    try {
      delete process.env.TRUSTED_PROXY_HOPS
      const req = { headers: new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }) }
      expect(rateLimitKey(req)).toBe("203.0.113.7")
      process.env.TRUSTED_PROXY_HOPS = "2"
      expect(rateLimitKey(req)).toBe("6.6.6.6")
      expect(rateLimitKey({ headers: new Headers() })).toBe("default")
    } finally {
      if (prevHops === undefined) delete process.env.TRUSTED_PROXY_HOPS
      else process.env.TRUSTED_PROXY_HOPS = prevHops
      if (prevVercel === undefined) delete process.env.VERCEL
      else process.env.VERCEL = prevVercel
    }
  })
})

describe("proxyConfigWarning", () => {
  const prod = { NODE_ENV: "production" }

  test("dev never warns", () => {
    expect(proxyConfigWarning({ NODE_ENV: "development" })).toBeNull()
  })

  test("known proxying platform → no warning", () => {
    expect(proxyConfigWarning({ ...prod, VERCEL: "1" })).toBeNull()
    expect(proxyConfigWarning({ ...prod, FLY_APP_NAME: "app" })).toBeNull()
  })

  test("production with TRUSTED_PROXY_HOPS unset → warns that XFF is spoofable", () => {
    expect(proxyConfigWarning(prod)).toMatch(/X-Forwarded-For/)
    expect(proxyConfigWarning({ ...prod, TRUSTED_PROXY_HOPS: " " })).toMatch(/reverse proxy/)
  })

  test("TRUSTED_PROXY_HOPS=0 → warns about the single shared bucket", () => {
    expect(proxyConfigWarning({ ...prod, TRUSTED_PROXY_HOPS: "0" })).toMatch(
      /ONE rate-limit bucket/
    )
  })

  test("an explicit hop count confirms the proxy → no warning", () => {
    expect(proxyConfigWarning({ ...prod, TRUSTED_PROXY_HOPS: "1" })).toBeNull()
    expect(proxyConfigWarning({ ...prod, TRUSTED_PROXY_HOPS: "2" })).toBeNull()
  })

  test("warnOnProxyConfig logs at most once per process", () => {
    const logged: string[] = []
    warnOnProxyConfig(prod, (m) => logged.push(m))
    warnOnProxyConfig(prod, (m) => logged.push(m))
    expect(logged).toHaveLength(1)
  })
})
