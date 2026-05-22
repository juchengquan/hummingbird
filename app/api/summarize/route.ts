import type { NextRequest } from 'next/server'

import { generateText } from 'ai'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { categorizeError } from '@/shared/api-errors'
import {
  ProviderUnavailableError,
  selectModel,
} from '@/server/model-provider'

export const runtime = 'nodejs'

// Cheap, fast model — summaries don't need a reasoning-class model. Override
// per-request via the optional `model` field.
const DEFAULT_SUMMARY_MODEL = 'google/gemini-2.5-flash'

const FileSummaryBody = z.object({
  mode: z.literal('file'),
  name: z.string().max(500).optional(),
  text: z.string().min(1).max(50_000),
  model: z.string().max(100).optional(),
})

const ConversationSummaryBody = z.object({
  mode: z.literal('conversation'),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })
    )
    .min(1)
    .max(200),
  model: z.string().max(100).optional(),
})

const BodySchema = z.discriminatedUnion('mode', [
  FileSummaryBody,
  ConversationSummaryBody,
])

function buildFilePrompt(name: string | undefined, text: string) {
  return `Summarize the following document${name ? ` titled "${name}"` : ''} in 2-3 plain-text sentences. Then list 3-5 short topic phrases (noun phrases, lowercase, no punctuation).

Reply with strict JSON only, no prose:
{"summary": "...", "keyTopics": ["topic one", "topic two"]}

Document:
"""
${text}
"""`
}

function buildConversationPrompt(
  messages: { role: 'user' | 'assistant'; content: string }[]
) {
  const transcript = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n')
  return `Summarize this conversation. Include:
- A one-paragraph overview
- 3-6 key points
- Decisions or action items (or [] if none)

Reply with strict JSON only, no prose:
{"summary": "...", "keyPoints": ["..."], "decisions": ["..."]}

Conversation:
"""
${transcript}
"""`
}

function stripJsonFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim()
}

export async function POST(req: NextRequest) {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json(
      { code: 'invalid_request', message: 'Body must be JSON.' },
      { status: 400 }
    )
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body.',
      },
      { status: 400 }
    )
  }

  const body = parsed.data
  const modelId = body.model ?? DEFAULT_SUMMARY_MODEL
  const prompt =
    body.mode === 'file'
      ? buildFilePrompt(body.name, body.text)
      : buildConversationPrompt(body.messages)

  try {
    const result = await generateText({
      abortSignal: req.signal,
      model: selectModel(modelId),
      prompt,
      // Summaries should be tight — bail out if the model rambles.
      maxOutputTokens: 600,
      temperature: 0.3,
    })

    const cleaned = stripJsonFences(result.text)
    try {
      const parsedResponse = JSON.parse(cleaned)
      return NextResponse.json(parsedResponse)
    } catch {
      return NextResponse.json(
        {
          code: 'provider',
          message: 'Summarisation model did not return valid JSON.',
        },
        { status: 502 }
      )
    }
  } catch (error) {
    if (error instanceof ProviderUnavailableError) {
      return NextResponse.json(
        { code: 'auth', message: error.message },
        { status: 401 }
      )
    }
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }
}
