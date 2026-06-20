import "server-only"

import { z } from "zod"

import { generateStructured } from "@/server/ai/structured"

import { renderPdfPages } from "./render-pdf"

export interface ExtractWithVisionInput {
  data: Uint8Array
  model: string
  signal?: AbortSignal
}

export interface ExtractWithVisionResult {
  text: string
  pageCount: number
}

/** Injection seams so orchestration is unit-tested without the native
 *  renderer or a live model (mirrors `runVerifier` in verify-answer.ts). */
export interface ExtractWithVisionDeps {
  renderPages?: (data: Uint8Array) => Promise<Buffer[]>
  transcribePage?: (
    png: Buffer,
    model: string,
    signal: AbortSignal | undefined,
    pageNum: number
  ) => Promise<string>
}

const PageSchema = z.object({ markdown: z.string() })

const PAGE_PROMPT =
  "Transcribe this document page to GitHub-flavoured Markdown. Render " +
  "tables as Markdown tables. Describe figures, charts, and images as " +
  "`*Figure: <caption>*`. Preserve reading order. Omit page furniture " +
  "(running headers/footers, page numbers). Output only the page content."

/** Default per-page model call: send the page PNG + the transcription
 *  prompt to the vision model and return its markdown. */
async function defaultTranscribePage(
  png: Buffer,
  model: string,
  signal: AbortSignal | undefined
): Promise<string> {
  const out = await generateStructured({
    modelId: model,
    schema: PageSchema,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PAGE_PROMPT },
          { type: "image", image: png },
        ],
      },
    ],
    abortSignal: signal,
  })
  return out.markdown
}

/**
 * Vision extraction orchestration: render PDF pages, transcribe each to
 * markdown via a vision model, and concatenate in reading order. Throws
 * on render/model failure — `extractFile` treats any throw as "fall back
 * to text-only".
 */
export async function extractWithVision(
  input: ExtractWithVisionInput,
  deps: ExtractWithVisionDeps = {}
): Promise<ExtractWithVisionResult> {
  const renderPages = deps.renderPages ?? ((data) => renderPdfPages(data))
  const transcribePage = deps.transcribePage ?? defaultTranscribePage

  const pages = await renderPages(input.data)
  if (pages.length === 0) return { text: "", pageCount: 0 }

  const parts: string[] = []
  for (let i = 0; i < pages.length; i++) {
    const md = await transcribePage(pages[i], input.model, input.signal, i + 1)
    parts.push(`<!-- page ${i + 1} -->\n\n${md}`)
  }

  return { text: parts.join("\n\n"), pageCount: pages.length }
}
