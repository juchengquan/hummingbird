/**
 * `POST /v1/extract` — multipart/form-data with a `file` field.
 * Direct port of agent-py's Phase 4 endpoint, matching the
 * `ExtractionResponseSchema` contract in `lib/shared/api-schemas.ts`.
 *
 * The same file-size cap as the Next.js route (`FILE_SIZE_LIMIT` in
 * `lib/shared/upload-config.ts`) gates the request. The route is
 * thin glue — the extraction itself lives in `extraction.ts`.
 */

import { Hono } from "hono"

import { FILE_SIZE_LIMIT } from "@/shared/upload-config"

import { extractFile } from "../extraction"
import type { AuthVars } from "../middleware/auth"
import { requireAuth } from "../middleware/auth"

export const extractRoutes = new Hono<{ Variables: AuthVars }>()

extractRoutes.post("/v1/extract", requireAuth, async (c) => {
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json(
      { error: "Expected multipart/form-data with a `file` field." },
      400,
    )
  }

  const file = form.get("file")
  if (!(file instanceof Blob)) {
    return c.json({ error: "No `file` field." }, 400)
  }
  if (file.size > FILE_SIZE_LIMIT) {
    return c.json({ error: "File too large." }, 413)
  }

  const name = file instanceof File ? file.name : "unnamed"
  const mimeType = file.type || ""
  const data = Buffer.from(await file.arrayBuffer())

  try {
    const result = await extractFile({ name, mimeType, data })
    // `fullText` is omitted when undefined to match the wire shape
    // the Next.js route emits today.
    return c.json(
      result.fullText !== undefined
        ? result
        : {
            kind: result.kind,
            text: result.text,
            truncated: result.truncated,
            ...(result.language !== undefined ? { language: result.language } : {}),
          },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extraction failed."
    return c.json({ error: message }, 500)
  }
})
