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

export async function POST(req: NextRequest) {
  const body = (await req.json()) as ChatRequestBody
  const apiKey = process.env.AI_GATEWAY_API_KEY

  if (!apiKey) {
    return NextResponse.json(
      { error: 'Missing AI_GATEWAY_API_KEY.' },
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
      return NextResponse.json(null, { status: 408 })
    }
    return NextResponse.json(
      { error: 'Failed to process chat request' },
      { status: 500 }
    )
  }
}
