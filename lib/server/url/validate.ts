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
  try {
    const u = new URL(input.trim())
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
  rawUrl: string
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

  if (BLOCKED_EXACT_HOSTS.has(hostLower)) {
    return {
      ok: false,
      error: {
        code: "blocked_host",
        message: `Hostname "${hostLower}" is blocked`,
      },
    }
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (hostLower === suffix.slice(1) || hostLower.endsWith(suffix)) {
      return {
        ok: false,
        error: {
          code: "blocked_host",
          message: `Hostnames ending in "${suffix}" are blocked`,
        },
      }
    }
  }

  // If the hostname is already a literal IP, check it directly.
  if (isIP(hostLower)) {
    if (isPrivateAddress(hostLower)) {
      return {
        ok: false,
        error: {
          code: "private_address",
          message: `Address ${hostLower} is in a private range`,
        },
      }
    }
    return { ok: true, url: parsed }
  }

  // DNS lookup — resolves both A and AAAA. Reject if any returned
  // address is private (DNS rebinding defense). `all: true` returns
  // every record; we check them all rather than the first.
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
    if (isPrivateAddress(rec.address)) {
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
 * Returns true when the given numeric IP (v4 or v6) is in a private,
 * loopback, link-local, or otherwise non-public range. Hand-rolled
 * over CIDR matching rather than pulling in a dep — the ranges are
 * stable and well-documented.
 */
function isPrivateAddress(addr: string): boolean {
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
  // IPv4-mapped (::ffff:a.b.c.d) — extract the v4 part and re-check.
  const mappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mappedMatch) return isPrivateIpv4(mappedMatch[1])
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
