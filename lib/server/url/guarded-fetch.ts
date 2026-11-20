import "server-only"

import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns"
import { isIP } from "node:net"

import { Agent } from "undici"

import {
  isAddressAllowed,
  validateOutboundUrl,
  type OutboundUrlPolicy,
} from "@/server/url/validate"

/**
 * DNS-rebinding-safe outbound fetch.
 *
 * `validateOutboundUrl` resolves the hostname and checks every address,
 * but `fetch()` then resolves the name *again* when it connects. A
 * TTL-0 record can answer with a public IP for the check and with
 * 127.0.0.1 / 169.254.169.254 for the connect. To close that gap every
 * outbound request goes through an undici `Agent` whose
 * `connect.lookup` re-applies `isAddressAllowed` to the addresses the
 * socket will actually dial — check and connect use the same answer.
 *
 * Node's built-in `fetch` (undici) honours the `dispatcher` init
 * field, and Next.js's patched fetch forwards it untouched. Under Bun
 * the field is ignored (Bun's fetch has no pluggable resolver); there
 * the per-hop `validateOutboundUrl` pre-flight is the only guard.
 *
 * IP-literal hosts never hit `lookup` (net skips resolution for them),
 * which is why redirects must still be followed manually and each hop
 * re-validated — `createGuardedFetch` does that.
 */

/** Error code surfaced on the `cause` of a fetch rejected at connect time. */
export const BLOCKED_ADDRESS_CODE = "ESSRFBLOCKED"

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void

type Resolver = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void

const defaultResolver: Resolver = (hostname, options, callback) =>
  dnsLookup(hostname, options, callback)

function blockedError(hostname: string, address: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    `Refusing to connect to ${hostname}: resolved address ${address} is not allowed`
  )
  err.code = BLOCKED_ADDRESS_CODE
  return err
}

/**
 * Build a `net`/`tls`-compatible `lookup` that resolves every address
 * for `hostname` and fails the whole connection if any of them is
 * disallowed under `policy` (same "any private record → deny" rule as
 * `validateOutboundUrl`). `resolver` is injectable for tests.
 */
export function createGuardedLookup(
  policy: OutboundUrlPolicy = {},
  resolver: Resolver = defaultResolver
) {
  return function guardedLookup(
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback
  ): void {
    if (isIP(hostname)) {
      if (!isAddressAllowed(hostname, policy)) {
        callback(blockedError(hostname, hostname), "")
        return
      }
      const family = isIP(hostname)
      if (options.all) callback(null, [{ address: hostname, family }])
      else callback(null, hostname, family)
      return
    }
    resolver(
      hostname,
      { family: options.family, hints: options.hints, all: true },
      (err, addresses) => {
        if (err) {
          callback(err, "")
          return
        }
        if (!addresses || addresses.length === 0) {
          const notFound: NodeJS.ErrnoException = new Error(
            `No addresses for ${hostname}`
          )
          notFound.code = "ENOTFOUND"
          callback(notFound, "")
          return
        }
        for (const rec of addresses) {
          if (!isAddressAllowed(rec.address, policy)) {
            callback(blockedError(hostname, rec.address), "")
            return
          }
        }
        if (options.all) callback(null, addresses)
        else callback(null, addresses[0].address, addresses[0].family)
      }
    )
  }
}

const dispatchers = new Map<string, Agent>()

/** Shared (pooled) undici Agent for a policy. */
export function getGuardedDispatcher(policy: OutboundUrlPolicy = {}): Agent {
  const key = policy.allowPrivateHosts === true ? "private" : "public"
  let agent = dispatchers.get(key)
  if (!agent) {
    agent = new Agent({ connect: { lookup: createGuardedLookup(policy) } })
    dispatchers.set(key, agent)
  }
  return agent
}

/** Attach the guarded dispatcher to a `fetch` init. Single hop — the
 *  caller must use `redirect: "manual"` and re-validate each hop (or
 *  use `createGuardedFetch`). */
export function withGuardedDispatcher(
  init: RequestInit,
  policy: OutboundUrlPolicy = {}
): RequestInit {
  return { ...init, dispatcher: getGuardedDispatcher(policy) } as RequestInit
}

export class OutboundUrlBlockedError extends Error {
  readonly code = "outbound_url_blocked"
  constructor(
    readonly url: string,
    readonly reason: string
  ) {
    super(`Outbound URL blocked: ${reason}`)
    this.name = "OutboundUrlBlockedError"
  }
}

const DEFAULT_MAX_REDIRECTS = 5

/** Headers forwarded across a cross-origin redirect. Everything else
 *  (Authorization, API-key headers, session ids, cookies) stays with
 *  the origin the caller chose. */
const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "user-agent",
  "mcp-protocol-version",
])

/**
 * A `fetch`-compatible function that validates the URL, connects
 * through the guarded dispatcher, and follows redirects manually —
 * re-validating every hop so a 302 to `http://169.254.169.254/` (an
 * IP literal that would skip the lookup hook) is refused. Throws
 * `OutboundUrlBlockedError` when any hop fails validation.
 *
 * Callers passing `redirect: "manual"` / `"error"` get those
 * semantics unchanged (but still validated + guarded).
 */
export function createGuardedFetch(
  policy: OutboundUrlPolicy = {},
  opts: { maxRedirects?: number } = {}
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  return async function guardedFetch(url, init = {}) {
    const mode = init.redirect ?? "follow"
    let currentUrl = url.toString()
    let method = (init.method ?? "GET").toUpperCase()
    let body = init.body
    let headers = new Headers(init.headers)
    const originalOrigin = new URL(currentUrl).origin

    for (let hop = 0; ; hop++) {
      const validation = await validateOutboundUrl(currentUrl, policy)
      if (!validation.ok) {
        throw new OutboundUrlBlockedError(currentUrl, validation.error.message)
      }
      const res = await fetch(
        validation.url,
        withGuardedDispatcher(
          { ...init, method, body, headers, redirect: "manual" },
          policy
        )
      )
      const location = res.headers.get("location")
      const isRedirect = res.status >= 300 && res.status < 400 && location
      if (!isRedirect || mode === "manual") return res
      if (mode === "error") {
        await res.body?.cancel().catch(() => undefined)
        throw new TypeError(`Redirect to ${location} refused (redirect: "error")`)
      }
      if (hop >= maxRedirects) {
        await res.body?.cancel().catch(() => undefined)
        throw new TypeError(`Exceeded ${maxRedirects} redirects`)
      }
      await res.body?.cancel().catch(() => undefined)

      const next = new URL(location, validation.url)
      // Fetch-spec method rewriting: 303 (non-HEAD) and 301/302 on POST
      // become a bodyless GET; 307/308 replay the original request.
      if (
        (res.status === 303 && method !== "HEAD") ||
        ((res.status === 301 || res.status === 302) && method === "POST")
      ) {
        method = "GET"
        body = undefined
        headers.delete("content-type")
        headers.delete("content-length")
      } else if (body instanceof ReadableStream) {
        throw new TypeError("Cannot replay a streamed request body across a redirect")
      }
      if (next.origin !== originalOrigin) {
        const kept = new Headers()
        headers.forEach((value, name) => {
          if (CROSS_ORIGIN_SAFE_HEADERS.has(name.toLowerCase())) kept.set(name, value)
        })
        headers = kept
      }
      currentUrl = next.toString()
    }
  }
}
