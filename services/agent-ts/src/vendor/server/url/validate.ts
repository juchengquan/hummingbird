// VENDORED from `lib/server/url/validate.ts` (Next app) at commit afc33009135d6166adb4196598350638a8aafc3f.
// Frozen copy — agent-ts is frozen (docs/PLAN-frontend-backend-split.md Q11); do not extend.
// Fixes to the original no longer propagate here. Only import specifiers were rewritten
// (`@/server/*` / `@/shared/*` → relative, `@/config/*` → `@config/*`) unless a
// "VENDOR DEVIATION" note below says otherwise.

import "server-only"

import { promises as dns } from "node:dns"
import { isIP } from "node:net"

/**
 * Anti-SSRF guard for the URL bookmark fetcher. Treat every reject
 * as a security boundary — when in doubt, deny.
 *
 * Two passes:
 *   1. URL parse + scheme/hostname syntactic checks (fast, no network).
 *   2. DNS resolution + check every resolved IP against the private
 *      blocklists (catches DNS rebinding where `evil.com` resolves to
 *      127.0.0.1).
 *
 * Caller must re-run validation on each redirect (the fetch helper
 * does this) — a 302 to a private IP would otherwise sneak through.
 *
 * See `docs/PLAN-url-bookmarks.md` "Validation + anti-SSRF" for the
 * full rationale.
 */

export type ValidationError =
  | { code: "invalid_url"; message: string }
  | { code: "bad_scheme"; message: string }
  | { code: "blocked_host"; message: string }
  | { code: "dns_lookup_failed"; message: string }
  | { code: "private_address"; message: string }

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"])

/**
 * Per-call relaxation of the private-host rules. Default (`{}`) is the
 * strict public-internet-only posture used by the bookmark fetcher.
 *
 * `allowPrivateHosts` lets loopback / RFC 1918 / ULA / `.local`-style
 * hosts through — used by MCP when the operator opts in via
 * `MCP_ALLOW_PRIVATE_HOSTS=true` (local dev MCP servers on
 * `localhost`). Even then, link-local (169.254.0.0/16, fe80::/10 —
 * which covers the 169.254.169.254 cloud metadata endpoint) and the
 * named metadata hosts stay blocked: no legitimate MCP server lives
 * there, and they are the single most valuable SSRF target.
 */
export interface OutboundUrlPolicy {
  allowPrivateHosts?: boolean
}

/** Blocked even under `allowPrivateHosts`. */
const ALWAYS_BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.azure.com",
  "metadata",
])

/**
 * Hostnames that resolve to non-public destinations regardless of DNS.
 * Pure textual match — `.local` covers mDNS / Bonjour, `.internal` is
 * common for corp DNS, the `*.svc.cluster.local` form is Kubernetes
 * service discovery.
 */
const BLOCKED_HOST_SUFFIXES = [
  ".local",
  ".internal",
  ".localhost",
  ".lan",
  ".intranet",
  ".corp",
  ".home",
  ".svc.cluster.local",
]

const BLOCKED_EXACT_HOSTS = new Set([
  "localhost",
  // Cloud-provider metadata endpoints — these resolve to 169.254.169.254
  // (caught by the private-range check too, but listed here for
  // defense-in-depth and clearer error messages).
  "metadata.google.internal",
  "metadata.azure.com",
])

/** Normalize a user-supplied URL string. Returns the canonical form
 *  (lowercased hostname, no fragment, no trailing slash on path), or
 *  null when the input isn't parseable. Used for dedup before
 *  validation. */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim()
  // Accept "example.com" by treating it as https://. Bare-domain input is
  // what users actually type; without this, every "google.com" landed as
  // an invalid_url 400 even though `validateOutboundUrl` would have been
  // happy with `https://google.com`.
  //
  // The scheme detector is split in two so `example.com:8080` (host +
  // port) doesn't get mistaken for the scheme `example.com:`. URL schemes
  // end in `://`; non-URL schemes (mailto:, javascript:, etc.) end in a
  // non-digit character. A `:` followed directly by a digit is a port,
  // not a scheme — fall through to the prepend.
  const hasUrlScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const hasNonUrlScheme = /^[a-z][a-z0-9+.-]*:[^/\d]/i.test(trimmed)
  const hasScheme = hasUrlScheme || hasNonUrlScheme
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(withScheme)
    u.hash = ""
    u.hostname = u.hostname.toLowerCase()
    // Strip a single trailing slash from the path so equivalent forms
    // collide on dedup. Keep "/" itself (root) as-is.
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "")
    }
    return u.toString()
  } catch {
    return null
  }
}

/**
 * Validate a URL for safe outbound fetch. Returns `{ ok: true, url }`
 * with the parsed URL on success, or `{ ok: false, error }` with a
 * structured failure.
 */
export async function validateOutboundUrl(
  rawUrl: string,
  policy: OutboundUrlPolicy = {}
): Promise<
  | { ok: true; url: URL }
  | { ok: false; error: ValidationError }
> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return {
      ok: false,
      error: { code: "invalid_url", message: "URL is not parseable" },
    }
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      error: {
        code: "bad_scheme",
        message: `Only http(s) URLs are allowed; got ${parsed.protocol}`,
      },
    }
  }

  const hostLower = parsed.hostname.toLowerCase()
  // WHATWG URL surfaces IPv6 literals as `[::1]` (with brackets) on
  // `.hostname`. Strip them before any IP check — otherwise `isIP`
  // returns 0 and the literal falls through to a DNS lookup that
  // shouldn't happen for an address literal.
  const hostForIpCheck = stripIpv6Brackets(hostLower)

  const allowPrivate = policy.allowPrivateHosts === true
  // Strip a trailing root dot so `localhost.` / `metadata.google.internal.`
  // can't dodge the textual blocklists.
  const hostForMatch = hostLower.endsWith(".") ? hostLower.slice(0, -1) : hostLower

  if (ALWAYS_BLOCKED_HOSTS.has(hostForMatch)) {
    return {
      ok: false,
      error: {
        code: "blocked_host",
        message: `Hostname "${hostForMatch}" is blocked`,
      },
    }
  }

  if (!allowPrivate) {
    if (BLOCKED_EXACT_HOSTS.has(hostForMatch)) {
      return {
        ok: false,
        error: {
          code: "blocked_host",
          message: `Hostname "${hostForMatch}" is blocked`,
        },
      }
    }
    for (const suffix of BLOCKED_HOST_SUFFIXES) {
      if (hostForMatch === suffix.slice(1) || hostForMatch.endsWith(suffix)) {
        return {
          ok: false,
          error: {
            code: "blocked_host",
            message: `Hostnames ending in "${suffix}" are blocked`,
          },
        }
      }
    }
  }

  // If the hostname is already a literal IP, check it directly.
  if (isIP(hostForIpCheck)) {
    if (!isAddressAllowed(hostForIpCheck, policy)) {
      return {
        ok: false,
        error: {
          code: "private_address",
          message: `Address ${hostForIpCheck} is in a private range`,
        },
      }
    }
    return { ok: true, url: parsed }
  }

  // DNS lookup — resolves both A and AAAA. Reject if any returned
  // address is private. `all: true` returns every record; we check
  // them all rather than the first.
  //
  // NOTE: this pre-flight alone is NOT a DNS-rebinding defense — a
  // TTL-0 record can answer differently when `fetch()` resolves again
  // at connect time. Outbound requests must also go through
  // `@/server/url/guarded-fetch`, whose connect-time lookup re-applies
  // `isAddressAllowed` to the address actually dialled.
  let records: Array<{ address: string; family: number }>
  try {
    records = await dns.lookup(hostLower, { all: true })
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "dns_lookup_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    }
  }
  for (const rec of records) {
    if (!isAddressAllowed(rec.address, policy)) {
      return {
        ok: false,
        error: {
          code: "private_address",
          message: `Hostname "${hostLower}" resolves to private address ${rec.address}`,
        },
      }
    }
  }

  return { ok: true, url: parsed }
}

/**
 * Strip the surrounding `[...]` brackets that WHATWG URL puts on
 * IPv6 hostnames. No-op for hostnames that aren't bracketed.
 */
function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1)
  }
  return host
}

/**
 * Returns true when the given numeric IP (v4 or v6) is in a private,
 * loopback, link-local, or otherwise non-public range. Hand-rolled
 * over CIDR matching rather than pulling in a dep — the ranges are
 * stable and well-documented.
 */
export function isPrivateAddress(addr: string): boolean {
  const family = isIP(addr)
  if (family === 4) return isPrivateIpv4(addr)
  if (family === 6) return isPrivateIpv6(addr)
  return true // unknown format = deny
}

function isPrivateIpv4(addr: string): boolean {
  const parts = addr.split(".").map((p) => Number(p))
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true
  }
  const [a, b] = parts
  return (
    a === 0 ||                                  // 0.0.0.0/8 (this network)
    a === 10 ||                                 // 10.0.0.0/8 (RFC 1918)
    (a === 100 && b >= 64 && b <= 127) ||       // 100.64.0.0/10 (CGNAT)
    a === 127 ||                                // 127.0.0.0/8 (loopback)
    (a === 169 && b === 254) ||                 // 169.254.0.0/16 (link-local)
    (a === 172 && b >= 16 && b <= 31) ||        // 172.16.0.0/12 (RFC 1918)
    (a === 192 && b === 0) ||                   // 192.0.0.0/24 (IETF protocol)
    (a === 192 && b === 168) ||                 // 192.168.0.0/16 (RFC 1918)
    (a === 198 && (b === 18 || b === 19)) ||    // 198.18.0.0/15 (benchmarking)
    a >= 224                                    // 224.0.0.0/4 + 240.0.0.0/4
  )
}

function isPrivateIpv6(addr: string): boolean {
  const lower = addr.toLowerCase()
  if (lower === "::" || lower === "::1") return true
  // IPv4-mapped IPv6 (`::ffff:*`) covers both the dotted form
  // (`::ffff:127.0.0.1`) and the canonical form WHATWG URL normalizes
  // to (`::ffff:7f00:1`). User-supplied URLs almost never need this;
  // a legitimate request to a public IPv4 address should arrive as
  // an IPv4 literal, not an IPv4-mapped IPv6 one. Reject the whole
  // family — safest default and matches the conservative posture of
  // the rest of the blocklist.
  if (lower.startsWith("::ffff:")) return true
  // Anything else in ::/96 (deprecated IPv4-compatible form, e.g.
  // `::7f00:1`) and the NAT64 well-known prefix 64:ff9b::/96 embed an
  // IPv4 address we'd otherwise not inspect. Deny both families.
  if (lower.startsWith("::")) return true
  if (lower.startsWith("64:ff9b:")) return true
  // First-byte heuristics for the common private prefixes:
  //   fc00::/7  — unique local (fc00, fd00)
  //   fe80::/10 — link-local (fe80, fe90, fea0, feb0)
  //   ff00::/8  — multicast
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true
  }
  if (lower.startsWith("ff")) return true
  return false
}

/**
 * Whether a numeric address may be connected to under `policy`.
 * Shared by `validateOutboundUrl` (pre-flight) and the guarded
 * dispatcher's connect-time lookup (`@/server/url/guarded-fetch`) so
 * check and connect apply the exact same rules.
 */
export function isAddressAllowed(
  addr: string,
  policy: OutboundUrlPolicy = {}
): boolean {
  if (isAlwaysBlockedAddress(addr)) return false
  if (policy.allowPrivateHosts === true) return true
  return !isPrivateAddress(addr)
}

/**
 * Addresses no outbound request may reach regardless of policy:
 * link-local (incl. the 169.254.169.254 cloud metadata endpoint, in
 * plain or IPv4-mapped-IPv6 form) and AWS's IPv6 IMDS address.
 * Unparseable input is denied.
 */
function isAlwaysBlockedAddress(addr: string): boolean {
  const family = isIP(addr)
  if (family === 0) return true
  if (family === 4) return isLinkLocalIpv4(addr)
  const lower = addr.toLowerCase()
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true
  }
  if (lower === "fd00:ec2::254") return true
  const mapped = ipv4FromMappedIpv6(lower)
  return mapped !== null && isLinkLocalIpv4(mapped)
}

function isLinkLocalIpv4(addr: string): boolean {
  const [a, b] = addr.split(".").map((p) => Number(p))
  return a === 169 && b === 254
}

/** `::ffff:1.2.3.4` / `::ffff:102:304` → `1.2.3.4`; otherwise null. */
function ipv4FromMappedIpv6(lower: string): string | null {
  if (!lower.startsWith("::ffff:")) return null
  const rest = lower.slice("::ffff:".length)
  if (isIP(rest) === 4) return rest
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest)
  if (!m) return null
  const hi = parseInt(m[1], 16)
  const lo = parseInt(m[2], 16)
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}
