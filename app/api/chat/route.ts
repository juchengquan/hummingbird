import type { NextRequest } from 'next/server'

import { createGateway } from '@ai-sdk/gateway'
import { streamText, type ModelMessage } from 'ai'
import { NextResponse } from 'next/server'

import { DEFAULT_CHAT_MODEL } from '@/lib/models'

interface FileSummary {
  name: string
  size: number
  type: string
}

interface ChatRequestBody {
  messages: ModelMessage[]
  model?: string
  files?: FileSummary[]
}

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

  const list = files
    .map((f) => `- ${f.name} (${f.type || 'unknown'}, ${formatBytes(f.size)})`)
    .join('\n')

  return `${base}\n\nThe user has attached the following files as context. You do NOT have their contents — only metadata. If a question requires the content of an attached file, say so explicitly and ask the user to paste the relevant portion.\n\n${list}`
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
