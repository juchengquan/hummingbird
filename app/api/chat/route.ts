import type { NextRequest } from 'next/server'

import { createGateway } from '@ai-sdk/gateway'
import { streamText, type ModelMessage } from 'ai'
import { NextResponse } from 'next/server'

import { DEFAULT_CHAT_MODEL } from '@/lib/models'
import { categorizeError } from '@/lib/api-errors'

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
  /** Optional per-workspace prompt, prepended to the base system instruction. */
  workspaceSystemPrompt?: string
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

function buildSystemPrompt(
  files: FileSummary[] | undefined,
  workspaceSystemPrompt?: string
): string {
  const trimmedWorkspace = workspaceSystemPrompt?.trim()
  // Workspace prompt goes first so user-set persona/style instructions take
  // precedence over our generic guidance. The base instructions then nudge the
  // model toward Markdown formatting (which the chat bubble now renders).
  const base = [
    trimmedWorkspace,
    'You are a helpful chat assistant inside the Hummingbird app. ' +
      'Answer concisely and use Markdown formatting when useful.',
  ]
    .filter(Boolean)
    .join('\n\n')

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
      system: buildSystemPrompt(body.files, body.workspaceSystemPrompt),
      messages: body.messages,
    })

    // Re-emit `fullStream` as a small SSE protocol so the client can keep
    // text and reasoning separate. Keeping our own envelope (rather than the
    // AI SDK's UI message stream) means the chat client doesn't need to be
    // a `useChat` consumer and we stay in control of the wire format.
    //
    // Frame: `data: {"type":"text"|"reasoning"|"error"|"done", ...}\n\n`
    const encoder = new TextEncoder()
    const sse = new ReadableStream({
      async start(controller) {
        const send = (payload: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        }
        try {
          for await (const part of result.fullStream) {
            if (part.type === 'text-delta') {
              const delta = (part as { delta?: string; text?: string }).delta
                ?? (part as { text?: string }).text
                ?? ''
              if (delta) send({ type: 'text', value: delta })
            } else if (part.type === 'reasoning-delta') {
              const delta = (part as { delta?: string; text?: string }).delta
                ?? (part as { text?: string }).text
                ?? ''
              if (delta) send({ type: 'reasoning', value: delta })
            } else if (part.type === 'error') {
              const { code, message } = categorizeError(
                (part as { error?: unknown }).error
              )
              send({ type: 'error', code, message })
            }
          }
          send({ type: 'done' })
          controller.close()
        } catch (error) {
          const { code, message } = categorizeError(error)
          send({ type: 'error', code, message })
          controller.close()
        }
      },
      cancel() {
        // Client disconnected mid-stream; the abortSignal on streamText
        // is already wired to req.signal so the upstream call gets cancelled.
      },
    })

    return new Response(sse, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    })
  } catch (error) {
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }
}
