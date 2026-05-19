/**
 * Client-side helper that POSTs a file to /api/extract and returns the
 * resulting text + kind. Network/HTTP failures resolve to `null`; the
 * caller decides how to mark the file ('failed').
 */

import { toast } from 'sonner'

export const EXTRACTION_BUDGET = 32 * 1024 // 32 KB of extracted text per file

export interface ExtractionResult {
  kind: string
  text: string
  truncated: boolean
  language?: string
}

export async function extractFile(
  file: File,
  signal?: AbortSignal
): Promise<ExtractionResult | null> {
  const form = new FormData()
  form.append('file', file)
  try {
    const res = await fetch('/api/extract', {
      method: 'POST',
      body: form,
      signal,
    })
    if (!res.ok) return null
    return (await res.json()) as ExtractionResult
  } catch {
    return null
  }
}

import type { FileExtractionStatus, UploadedFile } from '@/lib/types'

type ExtractionPatch = Partial<
  Pick<
    UploadedFile,
    | 'extractionStatus'
    | 'extractedText'
    | 'extractionTruncated'
    | 'extractedKind'
    | 'imageDataUrl'
    | 'summary'
    | 'keyTopics'
  >
>

/**
 * Skip summarisation for files below this size — there's nothing useful to
 * summarise. The summary call costs money so we'd rather under-trigger.
 */
const SUMMARY_MIN_TEXT_LENGTH = 500
/** Cap the request body — the route validates against this too. */
const SUMMARY_MAX_TEXT_LENGTH = 50_000

async function summariseFileInBackground(
  fileId: string,
  name: string,
  text: string,
  setFileExtraction: (id: string, patch: ExtractionPatch) => void
): Promise<void> {
  try {
    const res = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'file',
        name,
        text: text.slice(0, SUMMARY_MAX_TEXT_LENGTH),
      }),
    })
    if (!res.ok) return
    const data = (await res.json()) as {
      summary?: string
      keyTopics?: string[]
    }
    if (!data.summary) return
    setFileExtraction(fileId, {
      summary: data.summary,
      keyTopics: Array.isArray(data.keyTopics) ? data.keyTopics : undefined,
    })
  } catch {
    /* silent — summary is best-effort */
  }
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('FileReader returned non-string result'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Fire-and-forget helper: kicks off extraction for a freshly uploaded file
 * and pushes the result back into the store via `setFileExtraction`. Used by
 * both the chat input's `+` button and the resources panel.
 *
 * Images take a different path — no server round-trip, just a client-side
 * `FileReader` to a base64 data URL stored on the `UploadedFile`. The URL
 * is later attached as a multimodal content part on the next chat request.
 */
export async function runExtraction(
  fileId: string,
  blob: File,
  setFileExtraction: (id: string, patch: ExtractionPatch) => void
): Promise<void> {
  if (blob.type.startsWith('image/')) {
    try {
      const dataUrl = await readAsDataUrl(blob)
      setFileExtraction(fileId, {
        extractionStatus: 'done' as FileExtractionStatus,
        extractedKind: 'image',
        imageDataUrl: dataUrl,
      })
    } catch {
      setFileExtraction(fileId, { extractionStatus: 'failed' as FileExtractionStatus })
      toast.error(`Couldn't read "${blob.name}" as an image.`)
    }
    return
  }

  const result = await extractFile(blob)
  if (!result) {
    setFileExtraction(fileId, { extractionStatus: 'failed' as FileExtractionStatus })
    toast.error(`Text extraction failed for "${blob.name}".`)
    return
  }
  setFileExtraction(fileId, {
    extractionStatus:
      result.kind === 'unsupported'
        ? ('unsupported' as FileExtractionStatus)
        : ('done' as FileExtractionStatus),
    extractedText: result.text,
    extractionTruncated: result.truncated,
    extractedKind: result.kind,
  })

  // Best-effort background summarisation. Skipped for unsupported kinds and
  // very small files (where the summary would be longer than the source).
  if (
    result.kind !== 'unsupported' &&
    result.text.length >= SUMMARY_MIN_TEXT_LENGTH
  ) {
    void summariseFileInBackground(fileId, blob.name, result.text, setFileExtraction)
  }
}
