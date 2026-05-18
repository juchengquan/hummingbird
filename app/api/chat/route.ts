import type { NextRequest } from 'next/server'

import { createGateway } from '@ai-sdk/gateway'
import { streamText, type ModelMessage } from 'ai'
import { NextResponse } from 'next/server'

import { DEFAULT_CHAT_MODEL } from '@/lib/models'

interface FileSummary {
  name: string
  size: number
  type: string
  /** Plain-text content extracted by /api/extract. Undefined when extraction is pending or unsupported. */
  text?: string
  /** True when `text` was cut to fit the extraction budget. */
  truncated?: boolean
}

interface ChatRequestBody {
  messages: ModelMessage[]
  model?: string
  files?: FileSummary[]
}

// Soft cap on combined inline text across all attachments, to keep prompts
// inside reasonable token budgets. Per-file truncation already happens at
// extraction time; this is a second pass across the whole attachment set.
const TOTAL_ATTACHMENT_BUDGET = 96 * 1024

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function buildSystemPrompt(files: FileSummary[] | undefined): string {
  const base =
    'You are a helpful chat assistant inside the Hummingbird app. ' +
    'Answer concisely and use Markdown formatting when useful.'

  if (!files || files.length === 0) return base

  const withText = files.filter((f) => f.text && f.text.trim().length > 0)
  const metaOnly = files.filter((f) => !f.text || f.text.trim().length === 0)

  let prompt = base
  let used = 0

  if (withText.length > 0) {
    prompt +=
      '\n\nThe user has attached these files. Their extracted text follows. Treat them as authoritative context for any question that references them.'
    for (const f of withText) {
      const truncatedNote = f.truncated ? ' (per-file truncated at extraction)' : ''
      const header = `\n\n--- ${f.name}${truncatedNote} ---\n`
      const remaining = TOTAL_ATTACHMENT_BUDGET - used
      if (remaining <= 0) {
        prompt += `\n\n[Additional file omitted to fit budget: ${f.name}]`
        continue
      }
      const body = (f.text ?? '').slice(0, remaining)
      const overflow = (f.text ?? '').length > body.length
      prompt += header + body + (overflow ? '\n\n[truncated to fit overall budget]' : '')
      used += header.length + body.length
    }
  }

  if (metaOnly.length > 0) {
    const list = metaOnly
      .map((f) => `- ${f.name} (${f.type || 'unknown'}, ${formatBytes(f.size)})`)
      .join('\n')
    prompt += `\n\nThe user has also attached these files which we could not extract text from (filename + metadata only). Ask the user to paste any relevant portion if a question requires their content:\n\n${list}`
  }

  return prompt
}

function categorizeError(error: unknown): {
  status: number
  code: 'auth' | 'rate_limit' | 'invalid_model' | 'provider' | 'unknown'
  message: string
} {
  const message = error instanceof Error ? error.message : 'Unknown error'
  const lower = message.toLowerCase()
  if (/rate.?limit|quota|too many requests|429/.test(lower)) {
    return { status: 429, code: 'rate_limit', message }
  }
  if (/invalid.*model|model.*not.found|unknown model|400/.test(lower)) {
    return { status: 400, code: 'invalid_model', message }
  }
  if (/unauthor|forbidden|401|403/.test(lower)) {
    return { status: 401, code: 'auth', message }
  }
  if (/bad gateway|provider|upstream|502|503|504/.test(lower)) {
    return { status: 502, code: 'provider', message }
  }
  return { status: 500, code: 'unknown', message }
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as ChatRequestBody
  const apiKey = process.env.AI_GATEWAY_API_KEY

  if (!apiKey) {
    return NextResponse.json(
      { code: 'auth', message: 'Missing AI_GATEWAY_API_KEY.' },
      { status: 401 }
    )
  }

  const gateway = createGateway({ apiKey })
  const modelId = body.model || DEFAULT_CHAT_MODEL

  try {
    const result = streamText({
      abortSignal: req.signal,
      model: gateway(modelId),
      system: buildSystemPrompt(body.files),
      messages: body.messages,
    })

    return result.toTextStreamResponse()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json({ code: 'aborted' }, { status: 408 })
    }
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }
}
