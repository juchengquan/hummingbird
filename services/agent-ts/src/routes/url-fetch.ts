/**
 * `POST /v1/url/fetch` — port of agent-py's Phase 4-4a endpoint.
 *
 * Re-uses the existing `lib/server/url/fetch.ts` library directly
 * (SSRF guard + manual redirect handling + lxml-equivalent extraction
 * via `node-html-parser`). The route is mostly request validation +
 * error-code-to-HTTP-status mapping.
 */

import { Hono } from "hono"
import { z } from "zod"

import { fetchUrlBookmark, type FetchError } from "@/server/url/fetch"
import { normalizeUrl } from "@/server/url/validate"

import type { AuthVars } from "../middleware/auth"
import { requireAuth } from "../middleware/auth"

const BodySchema = z.object({
  url: z.string().min(1).max(2000),
})

export const urlFetchRoutes = new Hono<{ Variables: AuthVars }>()

urlFetchRoutes.post("/v1/url/fetch", requireAuth, async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: "invalid_request", message: "Body must be JSON." }, 400)
  }
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        code: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request body.",
      },
      422,
    )
  }
  const normalized = normalizeUrl(parsed.data.url)
  if (!normalized) {
    return c.json({ code: "invalid_url", message: "URL is not parseable" }, 400)
  }
  const result = await fetchUrlBookmark(normalized)
  if (!result.ok) {
    return c.json({ code: result.error.code, message: result.error.message }, httpStatusFor(result.error))
  }
  return c.json({ ok: true, bookmark: result.snapshot })
})

function httpStatusFor(error: FetchError): 400 | 408 | 413 | 502 | 500 {
  switch (error.code) {
    case "validation":
    case "unsupported_content_type":
      return 400
    case "timeout":
      return 408
    case "body_too_large":
      return 413
    case "too_many_redirects":
    case "http_error":
    case "network":
      return 502
    default:
      return 500
  }
}
