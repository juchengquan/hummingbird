import { createHash } from "node:crypto"

import {
  buildSandboxFrameDocument,
  sandboxFrameHeaders,
} from "@/server/security/sandbox-frame"

/**
 * Sandbox frame shell for live-artifact and MCP-app iframes. A static
 * document whose response CSP (`@/server/security/sandbox-frame`) is
 * written for untrusted artifact code; the parent posts the HTML in
 * (`@/shared/sandbox-frame`). Excluded from the `proxy.ts` matcher so
 * the app's own CSP never lands on it. See docs/SECURITY.md.
 */

const BODY = buildSandboxFrameDocument()
const HEADERS = sandboxFrameHeaders()
// The policy is part of the identity: a deploy that changes either the
// document or its CSP must not be answered with a 304.
const ETAG = `"${createHash("sha256")
  .update(BODY)
  .update(HEADERS["Content-Security-Policy"])
  .digest("base64url")
  .slice(0, 27)}"`

export function GET(req: Request): Response {
  const headers = { ...HEADERS, ETag: ETAG }
  if (req.headers.get("if-none-match") === ETAG) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(BODY, { status: 200, headers })
}
