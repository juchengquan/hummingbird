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

// Compress mode: same input shape as conversation mode but the output
// is a single markdown string intended to REPLACE the input messages
// in the chat history. Information density matters more than narrative
// flow — the next turn's model reads this as a substitute for raw
// context.
const CompressSummaryBody = z.object({
  mode: z.literal('compress'),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })
    )
    .min(2)
    .max(200),
  model: z.string().max(100).optional(),
})

// Project-breakdown mode: turn a project goal into a short list of
// actionable task titles for the Kanban board. Output is a JSON array
// of strings. `existingTitles` lets the model avoid proposing dupes of
// cards already on the board.
const ProjectBreakdownBody = z.object({
  mode: z.literal('project-breakdown'),
  goal: z.string().min(1).max(4000),
  existingTitles: z.array(z.string().max(300)).max(100).optional(),
  model: z.string().max(100).optional(),
})

const BodySchema = z.discriminatedUnion('mode', [
  FileSummaryBody,
  ConversationSummaryBody,
  CompressSummaryBody,
  ProjectBreakdownBody,
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

function buildCompressPrompt(
  messages: { role: 'user' | 'assistant'; content: string }[]
) {
  // Information-dense markdown bullets. The output replaces the input
  // verbatim in the next chat turn's history, so the model needs to be
  // able to *continue* the conversation from this recap alone — names,
  // facts, file references, decisions, and any open threads all matter.
  // No narrative voice; bullets stay terse.
  const transcript = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n')
  return `Compress the following conversation between USER and ASSISTANT into a tight markdown recap (4-10 bullets, ~300 tokens) that PRESERVES enough information for the assistant to continue the conversation seamlessly from this point.

Required:
- Keep specific names, facts, numbers, file references, URLs.
- Keep any explicit decisions the user made.
- Keep any open questions or pending follow-ups.
- Drop pleasantries and rhetorical filler.

Output plain markdown bullets only. No headings, no preamble, no JSON. Start the response with "- ".

Conversation:
"""
${transcript}
"""`
}

function buildProjectBreakdownPrompt(
  goal: string,
  existingTitles: string[] | undefined
) {
  const existing =
    existingTitles && existingTitles.length > 0
      ? `\n\nThe board already has these tasks — do NOT repeat them:\n${existingTitles
          .map((t) => `- ${t}`)
          .join('\n')}`
      : ''
  return `Break the following project goal into 5-8 concrete, actionable task titles. Each title is a short imperative phrase (e.g. "Draft the API schema", "Set up CI"), not a sentence. Order them roughly by sequence.${existing}

Reply with strict JSON only, no prose:
{"titles": ["task one", "task two", "..."]}

Goal:
"""
${goal}
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
      : body.mode === 'conversation'
        ? buildConversationPrompt(body.messages)
        : body.mode === 'compress'
          ? buildCompressPrompt(body.messages)
          : buildProjectBreakdownPrompt(body.goal, body.existingTitles)

  try {
    const result = await generateText({
      abortSignal: req.signal,
      model: selectModel(modelId),
      prompt,
      // Compress mode wants ~300 tokens worth of bullets but we leave
      // headroom for verbose models. Other modes were sized at 600;
      // keep that ceiling for them and bump compress to 800 for safety.
      maxOutputTokens: body.mode === 'compress' ? 800 : 600,
      temperature: 0.3,
    })

    // Compress mode returns plain markdown, not JSON.
    if (body.mode === 'compress') {
      const recap = result.text.trim()
      if (!recap) {
        return NextResponse.json(
          { code: 'provider', message: 'Summariser returned empty output.' },
          { status: 502 }
        )
      }
      return NextResponse.json({ recap })
    }

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
