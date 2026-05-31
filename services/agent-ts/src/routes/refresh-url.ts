/**
 * `POST /v1/images/refresh-url` — port of agent-py's Phase 4-4a
 * route.
 *
 * Re-signs an expired generated-image Storage URL. Storage paths are
 * `<user_id>/<rest>`; we reject any path whose first segment doesn't
 * match the JWT `sub` claim before touching Storage. RLS would also
 * refuse but a clean 403 is friendlier than fighting an opaque
 * Storage error.
 */

import { Hono } from "hono"
import { z } from "zod"

import type { AuthVars } from "../middleware/auth"
import { requireAuth } from "../middleware/auth"
import { signStoragePath } from "../storage"

const BodySchema = z.object({
  storage_path: z.string().min(1).max(1000),
})

export const refreshUrlRoutes = new Hono<{ Variables: AuthVars }>()

refreshUrlRoutes.post("/v1/images/refresh-url", requireAuth, async (c) => {
  const claims = c.get("claims")
  const userId = typeof claims.sub === "string" ? claims.sub : ""
  if (!userId) {
    return c.json({ code: "auth", message: "Token has no subject." }, 401)
  }

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

  const firstSegment = parsed.data.storage_path.split("/", 1)[0]
  if (firstSegment !== userId) {
    return c.json(
      { code: "forbidden", message: "Storage path does not belong to you." },
      403,
    )
  }

  const url = await signStoragePath(parsed.data.storage_path)
  if (!url) {
    return c.json(
      {
        code: "not_found",
        message: "Could not re-sign the URL — object may be missing.",
      },
      404,
    )
  }
  return c.json({ url })
})
