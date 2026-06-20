import "server-only"

import { Worker } from "node:worker_threads"

export interface RenderPdfOptions {
  /** Hard cap on pages rendered (cost bound). Default 30. */
  maxPages?: number
  /** Render scale (≈ DPI/72). Default 2.0 (~144 DPI). */
  scale?: number
}

/**
 * The render runs inside a Node worker thread, NOT the main thread, on
 * purpose. `pdf-to-img` bundles its own copy of `pdfjs-dist`, and so does
 * `pdf-parse` (the text-extraction pass `extractFile` runs first). pdfjs
 * stores its "fake worker" on `globalThis.pdfjsWorker`; the two pdfjs
 * versions then collide ("The API version X does not match the Worker
 * version Y") and rendering fails for whichever loads second. Because
 * `extractFile` always runs pdf-parse before the vision render in the
 * same process, the render would *always* fail in production without
 * isolation. A worker thread gives pdf-to-img a fresh `globalThis` where
 * only its own pdfjs ever loads.
 *
 * The worker body is an inline string (`eval: true`) rather than a
 * separate file so there's nothing for Next/Turbopack to bundle or fail
 * to trace — it just `import()`s `pdf-to-img`, which is marked
 * `serverExternalPackages` and so resolves from node_modules at runtime.
 */
const WORKER_CODE = `
const { parentPort, workerData } = require("node:worker_threads")
;(async () => {
  try {
    const { pdf } = await import("pdf-to-img")
    const doc = await pdf(Buffer.from(workerData.bytes), { scale: workerData.scale })
    const pages = []
    for await (const page of doc) {
      pages.push(new Uint8Array(page))
      if (pages.length >= workerData.maxPages) break
    }
    parentPort.postMessage({ ok: true, pages })
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.message) || err) })
  }
})()
`

/**
 * Render PDF pages to PNG buffers via `pdf-to-img` (pdfjs-dist +
 * @napi-rs/canvas, a known-good pairing), isolated in a worker thread
 * (see the note above). Caps at `maxPages` to bound cost. Throws if the
 * document can't be parsed/rendered or the worker fails — callers in the
 * vision path treat any throw as "fall back to text-only".
 */
export async function renderPdfPages(
  data: Uint8Array,
  opts: RenderPdfOptions = {}
): Promise<Buffer[]> {
  const { maxPages = 30, scale = 2.0 } = opts
  if (maxPages <= 0) return []

  // Copy into a fresh Uint8Array so the structured clone to the worker is
  // a plain byte array (not a Buffer view over a larger pool).
  const bytes = new Uint8Array(data)

  return await new Promise<Buffer[]>((resolve, reject) => {
    const worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: { bytes, scale, maxPages },
    })
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      void worker.terminate()
      fn()
    }
    worker.once(
      "message",
      (msg: { ok: true; pages: Uint8Array[] } | { ok: false; error: string }) => {
        if (msg.ok) {
          finish(() => resolve(msg.pages.map((u) => Buffer.from(u))))
        } else {
          finish(() => reject(new Error(msg.error)))
        }
      }
    )
    worker.once("error", (err) => finish(() => reject(err)))
  })
}
