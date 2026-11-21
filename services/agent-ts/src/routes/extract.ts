/**
 * `POST /v1/extract` — multipart/form-data with a `file` field.
 * Mirror of `app/api/extract/route.ts`; both routes are thin glue
 * over the shared library at `lib/server/extraction.ts`.
 *
 * The same file-size cap as the Next.js route (`FILE_SIZE_LIMIT` in
 * `lib/shared/upload-config.ts`) gates the request. On top of the
 * per-file check, a whole-body limit rejects oversized uploads (by
 * `Content-Length`, or while streaming a chunked body) BEFORE the
 * multipart parser buffers them into memory.
 */

import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"

import { extractFile } from "../vendor/server/extraction"
import { ZipLimitError } from "../vendor/server/extraction/zip-guard"
import { FILE_SIZE_LIMIT } from "../vendor/shared/upload-config"

import type { AuthVars } from "../middleware/auth"
import { requireAuth } from "../middleware/auth"
import { createSlidingWindow, rateLimitKey } from "../rate-limit"

/** Multipart framing (boundaries, part headers, small form fields) on
 *  top of the file itself. Generous — the per-file `FILE_SIZE_LIMIT`
 *  check below is the precise gate. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024
export const EXTRACT_MAX_BODY_BYTES = FILE_SIZE_LIMIT + MULTIPART_OVERHEAD_BYTES

/** Vision extraction runs N model calls per doc — per-IP budget so a
 *  burst of layout-rich PDFs can't run the provider bill up. Text-only
 *  extraction is unaffected (consulted only inside the vision branch).
 *  Mirrors `extractVisionLimit` in `app/api/extract/route.ts`. */
const extractVisionLimit = createSlidingWindow({ windowMs: 60_000, max: 10 })

export const extractRoutes = new Hono<{ Variables: AuthVars }>()

extractRoutes.post(
  "/v1/extract",
  requireAuth,
  bodyLimit({
    maxSize: EXTRACT_MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "File too large." }, 413),
  }),
  async (c) => {
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
      const result = await extractFile(
        { name, mimeType, data },
        {
          consumeVisionBudget: () => extractVisionLimit.consume(rateLimitKey(c)),
          signal: c.req.raw.signal,
        },
      )
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
      // Zip bomb guard (lib/server/extraction/zip-guard.ts) — same 413 as
      // the Next.js /api/extract route.
      if (error instanceof ZipLimitError) {
        return c.json({ error: error.message }, 413)
      }
      const message = error instanceof Error ? error.message : "Extraction failed."
      return c.json({ error: message }, 500)
    }
  },
)
