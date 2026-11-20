import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { LookupAddress } from "node:dns"

import {
  BLOCKED_ADDRESS_CODE,
  OutboundUrlBlockedError,
  createGuardedFetch,
  createGuardedLookup,
  withGuardedDispatcher,
} from "./guarded-fetch"

/** Fake resolver returning a fixed answer — simulates a DNS server. */
function fakeResolver(addresses: LookupAddress[]) {
  return (
    _host: string,
    _opts: unknown,
    cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void
  ) => cb(null, addresses)
}

function runLookup(
  lookup: ReturnType<typeof createGuardedLookup>,
  hostname: string,
  all: boolean
): Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }> {
  return new Promise((resolve) => {
    lookup(hostname, { all }, (err, address, family) => resolve({ err, address, family }))
  })
}

describe("createGuardedLookup — connect-time re-validation (DNS rebinding)", () => {
  test("rebinding answer to loopback is rejected at connect time", async () => {
    // The pre-flight saw a public IP; at connect time the TTL-0 record
    // now answers 127.0.0.1. The guarded lookup must refuse it.
    const lookup = createGuardedLookup({}, fakeResolver([{ address: "127.0.0.1", family: 4 }]))
    const r = await runLookup(lookup, "rebind.example", false)
    expect(r.err?.code).toBe(BLOCKED_ADDRESS_CODE)
  })

  test("metadata address rejected", async () => {
    const lookup = createGuardedLookup(
      {},
      fakeResolver([{ address: "169.254.169.254", family: 4 }])
    )
    const r = await runLookup(lookup, "rebind.example", true)
    expect(r.err?.code).toBe(BLOCKED_ADDRESS_CODE)
  })

  test("mixed public + private answer rejected (any private → deny)", async () => {
    const lookup = createGuardedLookup(
      {},
      fakeResolver([
        { address: "93.184.216.34", family: 4 },
        { address: "::1", family: 6 },
      ])
    )
    const r = await runLookup(lookup, "rebind.example", true)
    expect(r.err?.code).toBe(BLOCKED_ADDRESS_CODE)
  })

  test("public answer passes through in both callback shapes", async () => {
    const answer = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]
    const lookup = createGuardedLookup({}, fakeResolver(answer))
    const single = await runLookup(lookup, "example.com", false)
    expect(single.err).toBeNull()
    expect(single.address).toBe("93.184.216.34")
    expect(single.family).toBe(4)
    const all = await runLookup(lookup, "example.com", true)
    expect(all.err).toBeNull()
    expect(all.address).toEqual(answer)
  })

  test("allowPrivateHosts permits loopback but not link-local", async () => {
    const ok = createGuardedLookup(
      { allowPrivateHosts: true },
      fakeResolver([{ address: "127.0.0.1", family: 4 }])
    )
    expect((await runLookup(ok, "localhost", false)).err).toBeNull()
    const bad = createGuardedLookup(
      { allowPrivateHosts: true },
      fakeResolver([{ address: "169.254.169.254", family: 4 }])
    )
    expect((await runLookup(bad, "rebind.example", false)).err?.code).toBe(
      BLOCKED_ADDRESS_CODE
    )
  })

  test("IP-literal hostnames are checked directly", async () => {
    const lookup = createGuardedLookup({}, fakeResolver([]))
    expect((await runLookup(lookup, "10.0.0.1", false)).err?.code).toBe(
      BLOCKED_ADDRESS_CODE
    )
  })

  test("resolver error is propagated", async () => {
    const lookup = createGuardedLookup({}, (_h, _o, cb) => {
      const e: NodeJS.ErrnoException = new Error("nope")
      e.code = "ENOTFOUND"
      cb(e, [])
    })
    expect((await runLookup(lookup, "x.example", false)).err?.code).toBe("ENOTFOUND")
  })
})

describe("withGuardedDispatcher", () => {
  test("attaches a dispatcher and keeps the caller's init", () => {
    const init = withGuardedDispatcher({ method: "GET", redirect: "manual" })
    expect((init as { dispatcher?: unknown }).dispatcher).toBeDefined()
    expect(init.redirect).toBe("manual")
  })
})

describe("createGuardedFetch — redirects re-validated", () => {
  // Local servers need the private-host opt-in to be reachable at all;
  // link-local / metadata stays blocked under it, which is what we test.
  const policy = { allowPrivateHosts: true }
  let a: ReturnType<typeof Bun.serve>
  let b: ReturnType<typeof Bun.serve>

  beforeAll(() => {
    b = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) =>
        Response.json({
          method: req.method,
          auth: req.headers.get("authorization"),
          apiKey: req.headers.get("x-api-key"),
          contentType: req.headers.get("content-type"),
          body: await req.text(),
        }),
    })
    a = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const path = new URL(req.url).pathname
        if (path === "/to-metadata") {
          return new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          })
        }
        if (path === "/to-b-307") {
          return new Response(null, {
            status: 307,
            headers: { location: `http://127.0.0.1:${b.port}/echo` },
          })
        }
        if (path === "/to-b-303") {
          return new Response(null, {
            status: 303,
            headers: { location: `http://127.0.0.1:${b.port}/echo` },
          })
        }
        if (path === "/loop") {
          return new Response(null, { status: 302, headers: { location: "/loop" } })
        }
        return new Response("hello")
      },
    })
  })

  afterAll(() => {
    a.stop(true)
    b.stop(true)
  })

  test("redirect to the metadata IP literal is refused", async () => {
    const f = createGuardedFetch(policy)
    await expect(f(`http://127.0.0.1:${a.port}/to-metadata`)).rejects.toBeInstanceOf(
      OutboundUrlBlockedError
    )
  })

  test("initial private URL refused under the default policy", async () => {
    const f = createGuardedFetch()
    await expect(f(`http://127.0.0.1:${a.port}/`)).rejects.toBeInstanceOf(
      OutboundUrlBlockedError
    )
  })

  test("307 replays method + body; cross-origin drops credential headers", async () => {
    const f = createGuardedFetch(policy)
    const res = await f(`http://127.0.0.1:${a.port}/to-b-307`, {
      method: "POST",
      body: '{"x":1}',
      headers: {
        authorization: "Bearer secret",
        "x-api-key": "secret",
        "content-type": "application/json",
      },
    })
    const echoed = (await res.json()) as Record<string, unknown>
    expect(echoed.method).toBe("POST")
    expect(echoed.body).toBe('{"x":1}')
    expect(echoed.contentType).toBe("application/json")
    expect(echoed.auth).toBeNull()
    expect(echoed.apiKey).toBeNull()
  })

  test("303 turns POST into a bodyless GET", async () => {
    const f = createGuardedFetch(policy)
    const res = await f(`http://127.0.0.1:${a.port}/to-b-303`, {
      method: "POST",
      body: "payload",
    })
    const echoed = (await res.json()) as Record<string, unknown>
    expect(echoed.method).toBe("GET")
    expect(echoed.body).toBe("")
  })

  test("redirect loop capped", async () => {
    const f = createGuardedFetch(policy, { maxRedirects: 2 })
    await expect(f(`http://127.0.0.1:${a.port}/loop`)).rejects.toThrow(/redirects/)
  })

  test("redirect: manual returns the 3xx untouched", async () => {
    const f = createGuardedFetch(policy)
    const res = await f(`http://127.0.0.1:${a.port}/to-metadata`, { redirect: "manual" })
    expect(res.status).toBe(302)
  })
})
