import { NextResponse, type NextRequest } from "next/server"

import {
  buildCsp,
  cspHeaderName,
  cspOptionsFromEnv,
  generateNonce,
  parseCspMode,
  reportingEndpointsHeader,
} from "@/server/security/csp"
import { SANDBOX_FRAME_PATH } from "@/shared/sandbox-frame"

/**
 * Per-request CSP nonce (Next.js 16 `proxy` convention, formerly
 * `middleware`). Follows the strict-CSP recipe in
 * `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`:
 *
 *   1. mint a fresh nonce,
 *   2. put the policy on the REQUEST headers — Next parses the nonce
 *      out of `Content-Security-Policy` / `…-Report-Only` during SSR
 *      and stamps it on its own scripts — plus `x-nonce` for
 *      `app/layout.tsx`'s inline theme script,
 *   3. put the same policy on the RESPONSE.
 *
 * `CSP_MODE` (report-only | enforce | off, default report-only) picks
 * the header; see docs/SECURITY.md. Static, cheap headers (nosniff,
 * Referrer-Policy, …) live in `next.config.ts` instead.
 */
export function proxy(request: NextRequest) {
  // The sandbox frame shell carries its own (always-enforced) CSP for
  // untrusted artifact code. The matcher already excludes it; this
  // guard keeps a matcher edit from silently stamping the app policy
  // over it.
  if (request.nextUrl.pathname === SANDBOX_FRAME_PATH) return NextResponse.next()

  const headerName = cspHeaderName(parseCspMode(process.env.CSP_MODE))
  if (!headerName) return NextResponse.next()

  const nonce = generateNonce()
  const options = cspOptionsFromEnv(nonce, {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
    NEXT_PUBLIC_AGENT_PY_URL: process.env.NEXT_PUBLIC_AGENT_PY_URL,
  })
  const policy = buildCsp(options)

  const requestHeaders = new Headers(request.headers)
  // Drop any client-supplied copies so only ours reach the renderer.
  requestHeaders.delete("content-security-policy")
  requestHeaders.delete("content-security-policy-report-only")
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set(headerName, policy)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set(headerName, policy)
  // Reports go only to agent-py; without it there is nowhere to send them.
  if (options.reportUri) {
    response.headers.set("Reporting-Endpoints", reportingEndpointsHeader(options.reportUri))
  }
  return response
}

export const config = {
  matcher: [
    /*
     * Every page request except:
     * - api (JSON routes — no HTML, no scripts)
     * - sandbox/frame (the artifact frame shell — sets its own CSP,
     *   `app/sandbox/frame/route.ts`)
     * - _next/static, _next/image (build assets)
     * - favicon.ico and other root metadata / public files with an
     *   image/text extension (icon.svg, apple-icon.png, …)
     * and skip router prefetches (their payload has no <script> tags
     * and the guide recommends excluding them).
     */
    {
      source:
        "/((?!api|sandbox/frame$|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|webmanifest)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
}
