import "server-only"

import { BodyTooLargeError, readBodyCapped } from "@/server/read-body-capped"
import { createSlidingWindow, rateLimitKey, type SlidingWindow } from "@/server/rate-limit"

/**
 * CSP violation-report intake (`POST /api/csp-report`). Accepts both
 * wire formats browsers send:
 *
 *   - `application/csp-report` — legacy `report-uri`:
 *       `{ "csp-report": { "document-uri", "effective-directive", … } }`
 *   - `application/reports+json` — Reporting API (`report-to`):
 *       `[{ "type": "csp-violation", "body": { "documentURL", … } }, …]`
 *
 * Each violation becomes ONE compact structured log line. Reports are
 * attacker-controllable input (anyone can POST here), so the handler
 * never echoes anything back (always an empty-bodied status), caps the
 * body size, rate-limits per client IP, logs only a fixed allow-list of
 * fields, truncates each one, reduces URLs to origin + path (query
 * strings can carry signed-URL tokens) and redacts share tokens.
 * `script-sample` is dropped — it can contain user content.
 */

export const CSP_REPORT_MAX_BYTES = 16 * 1024
/** Upper bound on violations logged from one Reporting-API batch. */
export const CSP_REPORT_MAX_ENTRIES = 20
const FIELD_MAX = 200

const ACCEPTED_TYPES = new Set([
  "application/csp-report",
  "application/reports+json",
  // Some browsers / proxies label report-uri bodies as plain JSON.
  "application/json",
])

export interface CspViolationLog {
  evt: "csp_violation"
  /** Which delivery path the browser used — `report-uri` (legacy,
   *  immediate) or the Reporting API (`report-to`, batched). */
  via: "report-uri" | "reporting-api"
  directive: string
  blocked: string
  document: string
  source?: string
  line?: number
  column?: number
  disposition?: string
  /** True when the violating document is a `srcdoc` frame (live
   *  artifact / MCP app) that inherited the app policy. */
  srcdoc?: boolean
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, FIELD_MAX * 4) : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined
}

function clip(s: string): string {
  return s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX)}…` : s
}

const SHARE_TOKEN_RE = /\/share\/(conversation|document)\/[^/]+/

/**
 * Reduce a reported URL to something safe to log. CSP keywords the
 * browser reports instead of a URL (`inline`, `eval`, `wasm-eval`,
 * `trusted-types-…`) pass through; non-network schemes collapse to the
 * scheme; http(s)/ws(s) URLs keep origin + path only.
 */
export function sanitizeReportedUrl(raw: string | undefined): string {
  if (!raw) return ""
  if (/^[a-z][a-z0-9-]*$/i.test(raw)) return clip(raw)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return "invalid"
  }
  if (!/^(https?|wss?):$/.test(url.protocol)) {
    // about:srcdoc is worth keeping verbatim — it marks inherited
    // policy in sandboxed frames.
    return url.href === "about:srcdoc" ? "about:srcdoc" : url.protocol
  }
  return clip(`${url.origin}${url.pathname.replace(SHARE_TOKEN_RE, "/share/$1/:token")}`)
}

/** Normalise one violation object (either format's field names). */
function toLog(body: Record<string, unknown>, via: CspViolationLog["via"]): CspViolationLog {
  const directive =
    str(body["effective-directive"]) ??
    str(body.effectiveDirective) ??
    str(body["violated-directive"]) ??
    str(body.violatedDirective) ??
    "unknown"
  const document = sanitizeReportedUrl(str(body["document-uri"]) ?? str(body.documentURL))
  const log: CspViolationLog = {
    evt: "csp_violation",
    via,
    directive: clip(directive.split(" ")[0] ?? directive),
    blocked: sanitizeReportedUrl(str(body["blocked-uri"]) ?? str(body.blockedURL)),
    document,
  }
  const source = str(body["source-file"]) ?? str(body.sourceFile)
  if (source) log.source = sanitizeReportedUrl(source)
  const line = num(body["line-number"]) ?? num(body.lineNumber)
  if (line !== undefined) log.line = line
  const column = num(body["column-number"]) ?? num(body.columnNumber)
  if (column !== undefined) log.column = column
  const disposition = str(body.disposition)
  if (disposition === "enforce" || disposition === "report") log.disposition = disposition
  if (document === "about:srcdoc") log.srcdoc = true
  return log
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Extract the violations from a parsed body. Unknown shapes and
 * non-CSP Reporting-API entries (deprecation, intervention, …) yield
 * nothing rather than an error.
 */
export function parseCspReports(payload: unknown): CspViolationLog[] {
  if (Array.isArray(payload)) {
    const out: CspViolationLog[] = []
    for (const entry of payload.slice(0, CSP_REPORT_MAX_ENTRIES)) {
      if (!isRecord(entry) || entry.type !== "csp-violation" || !isRecord(entry.body)) continue
      out.push(toLog(entry.body, "reporting-api"))
    }
    return out
  }
  if (isRecord(payload) && isRecord(payload["csp-report"])) {
    return [toLog(payload["csp-report"], "report-uri")]
  }
  return []
}

export interface CspReportHandlerDeps {
  limiter?: SlidingWindow
  log?: (line: string) => void
}

/** 60 report POSTs / minute / client IP. A page with a broken policy
 *  can fire many violations at once; beyond this they're dropped. */
const defaultLimiter = createSlidingWindow({ windowMs: 60_000, max: 60 })

export function createCspReportHandler(deps: CspReportHandlerDeps = {}) {
  const limiter = deps.limiter ?? defaultLimiter
  const log = deps.log ?? ((line: string) => console.warn(line))

  return async function handleCspReport(req: Request): Promise<Response> {
    const verdict = limiter.consume(rateLimitKey(req))
    if (!verdict.allowed) {
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": String(verdict.retryAfterSec) },
      })
    }

    const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
    if (!ACCEPTED_TYPES.has(contentType)) {
      return new Response(null, { status: 415 })
    }

    let bytes: Uint8Array
    try {
      bytes = await readBodyCapped(req, CSP_REPORT_MAX_BYTES)
    } catch (err) {
      if (err instanceof BodyTooLargeError) return new Response(null, { status: 413 })
      return new Response(null, { status: 400 })
    }

    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return new Response(null, { status: 400 })
    }

    for (const violation of parseCspReports(payload)) {
      log(JSON.stringify(violation))
    }
    return new Response(null, { status: 204 })
  }
}
