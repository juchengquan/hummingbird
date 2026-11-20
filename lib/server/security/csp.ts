import "server-only"

/**
 * Content-Security-Policy builder. Pure: every env-derived input comes
 * in through `CspPolicyOptions`, so the policy is unit-testable and the
 * proxy (`proxy.ts`) is the only place that reads `process.env`.
 *
 * Shape: nonce + 'strict-dynamic' for scripts (the Next.js strict-CSP
 * recipe — Next reads the nonce back out of the request's CSP header
 * and stamps it on its own `<script>` tags). See `docs/SECURITY.md`
 * for the rationale behind each directive and how to read reports.
 */

export type CspMode = "report-only" | "enforce" | "off"

/** Endpoint the browser POSTs violation reports to (`report-uri`) and
 *  the Reporting-API group name that points at it (`report-to`). */
export const CSP_REPORT_PATH = "/api/csp-report"
export const CSP_REPORT_GROUP = "csp-endpoint"

/**
 * `CSP_MODE` → mode. Unset / empty / unrecognised → `report-only` so a
 * typo can never silently disable reporting, and never silently starts
 * enforcing either.
 */
export function parseCspMode(raw: string | undefined): CspMode {
  const v = raw?.trim().toLowerCase()
  if (v === "enforce" || v === "off" || v === "report-only") return v
  return "report-only"
}

/** Response (and request — Next reads it) header name for the mode. */
export function cspHeaderName(
  mode: CspMode,
): "Content-Security-Policy" | "Content-Security-Policy-Report-Only" | null {
  if (mode === "enforce") return "Content-Security-Policy"
  if (mode === "report-only") return "Content-Security-Policy-Report-Only"
  return null
}

/** 128 random bits, base64. Unpredictable per request, matches Next's
 *  nonce regex (`[A-Za-z0-9+/_-]+={0,2}`). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
}

/**
 * `https://x.supabase.co/rest/v1?q` → `https://x.supabase.co`. Only
 * http(s) URLs yield an origin; anything else (empty, malformed,
 * `javascript:`) → null so a bad env var drops out of the policy
 * instead of injecting arbitrary tokens into it.
 */
export function originOf(raw: string | undefined | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  return url.origin
}

/** The websocket origin paired with an http(s) origin — Supabase
 *  Realtime connects to `wss://<project>.supabase.co/realtime/v1`. */
export function websocketOriginOf(origin: string): string {
  return origin.replace(/^http/, "ws")
}

/**
 * Third-party video players the Plate media-embed node renders as
 * `<iframe src>` (`components/ui/media-embed-node.tsx` — YouTube goes
 * through react-lite-youtube-embed, the rest through
 * `@platejs/media`'s `parseVideoUrl` providers).
 */
export const EMBED_FRAME_ORIGINS = [
  "https://www.youtube-nocookie.com",
  "https://www.youtube.com",
  "https://player.vimeo.com",
  "https://www.dailymotion.com",
  "https://coub.com",
  "https://player.youku.com",
] as const

/** Fixed third-party fetch targets. react-tweet's `<Tweet>` (media
 *  embed node) fetches tweet JSON from its hosted API. */
export const FIXED_CONNECT_ORIGINS = ["https://react-tweet.vercel.app"] as const

export interface CspPolicyOptions {
  nonce: string
  /** `NODE_ENV === "development"` — React needs `eval` for dev-only
   *  error-stack reconstruction. Never set in production. */
  isDev: boolean
  /** `NEXT_PUBLIC_SUPABASE_URL` — REST/Storage over https, Realtime
   *  over wss. */
  supabaseUrl?: string
  /** Remote backends the browser talks to directly:
   *  `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_AGENT_PY_URL`,
   *  `NEXT_PUBLIC_AGENT_TS_URL`. Unset / invalid entries are skipped. */
  backendUrls?: ReadonlyArray<string | undefined>
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/** Directive name → source list, in emission order. */
export function buildCspDirectives(opts: CspPolicyOptions): Array<[string, string[]]> {
  const connect = ["'self'"]
  const supabase = originOf(opts.supabaseUrl)
  if (supabase) connect.push(supabase, websocketOriginOf(supabase))
  for (const raw of opts.backendUrls ?? []) {
    const o = originOf(raw)
    if (o) connect.push(o)
  }
  connect.push(...FIXED_CONNECT_ORIGINS)
  // data:/blob: — the editor's export flow does `fetch(canvas.toDataURL())`
  // and several viewers re-read object URLs they minted themselves.
  connect.push("data:", "blob:")

  const script = ["'self'", `'nonce-${opts.nonce}'`, "'strict-dynamic'"]
  if (opts.isDev) script.push("'unsafe-eval'")

  return [
    ["default-src", ["'self'"]],
    ["script-src", script],
    // 'unsafe-inline' (no nonce — a nonce would make browsers ignore
    // 'unsafe-inline'): React SSR emits `style="…"` attributes, and
    // KaTeX / Plate / Radix / sonner inject inline styles and <style>
    // tags that can't carry a nonce. See docs/SECURITY.md.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // https: — generated images, Supabase signed URLs, markdown images
    // in model output, favicons, YouTube/tweet thumbnails all render
    // through plain <img>, so the host set is open-ended.
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    // Same reasoning for <video>/<audio> in the editor's media nodes.
    ["media-src", ["'self'", "data:", "blob:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", unique(connect)],
    // pdfjs worker is a same-origin module script (`/_next/static/…`);
    // blob: covers libraries that wrap their worker in an object URL.
    ["worker-src", ["'self'", "blob:"]],
    // 'self': the sandbox frame shell (`/sandbox/frame`) that
    // live-artifact and MCP-app iframes load — it sends its own CSP
    // (`sandbox-frame.ts`). The rest are the media-embed players.
    ["frame-src", ["'self'", ...EMBED_FRAME_ORIGINS]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    // No page (share links included) is meant to be embedded. Ignored
    // in Report-Only policies, so X-Frame-Options: DENY (next.config.ts)
    // carries the enforcement meanwhile.
    ["frame-ancestors", ["'none'"]],
    ["report-uri", [CSP_REPORT_PATH]],
    ["report-to", [CSP_REPORT_GROUP]],
  ]
}

export function buildCsp(opts: CspPolicyOptions): string {
  return buildCspDirectives(opts)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ")
}

/** `Reporting-Endpoints` value pairing `report-to` with the route. */
export function reportingEndpointsHeader(): string {
  return `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`
}

/** Everything the proxy needs, from an env bag (defaults to
 *  `process.env`; tests pass a literal). */
export function cspOptionsFromEnv(
  nonce: string,
  env: Record<string, string | undefined> = process.env,
): CspPolicyOptions {
  return {
    nonce,
    isDev: env.NODE_ENV === "development",
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    backendUrls: [
      env.NEXT_PUBLIC_API_BASE_URL,
      env.NEXT_PUBLIC_AGENT_PY_URL,
      env.NEXT_PUBLIC_AGENT_TS_URL,
    ],
  }
}
