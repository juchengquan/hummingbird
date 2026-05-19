import type { NextRequest } from 'next/server'

import { createGateway } from '@ai-sdk/gateway'
import { generateText, stepCountIs, streamText, type ModelMessage } from 'ai'
import { NextResponse } from 'next/server'

import { DEFAULT_CHAT_MODEL } from '@/lib/models'
import { categorizeError } from '@/lib/api-errors'
import { ChatRequestSchema } from '@/lib/api-schemas'
import {
  buildWebSearchTool,
  isWebSearchConfigured,
  type WebSearchLog,
} from '@/lib/skills/web-search'

interface FileSummary {
  name: string
  size: number
  type: string
  /** Plain-text content extracted by /api/extract. Undefined when extraction is pending or unsupported. */
  text?: string
  /** True when `text` was cut to fit the extraction budget. */
  truncated?: boolean
  /**
   * Coarse content kind reported by /api/extract — 'pdf', 'docx', 'code',
   * 'spreadsheet', etc. Used to label the per-file header so the model
   * knows what flavour of text it's looking at.
   */
  kind?: string
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
  workspaceSystemPrompt?: string,
  /** Skill ids the user has effectively enabled for this turn. */
  enabledSkills?: string[]
): string {
  const trimmedWorkspace = workspaceSystemPrompt?.trim()
  const skillsLine = buildSkillsNote(enabledSkills ?? [])
  // Workspace prompt goes first so user-set persona/style instructions take
  // precedence over our generic guidance. The base instructions then nudge the
  // model toward Markdown formatting (which the chat bubble now renders).
  const base = [
    trimmedWorkspace,
    'You are a helpful chat assistant inside the Hummingbird app. ' +
      'Answer concisely and use Markdown formatting when useful.',
    skillsLine,
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
      const kindNote = f.kind ? ` (${f.kind})` : ''
      const header = `\n\n--- ${f.name}${kindNote}${truncatedNote} ---\n`
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

function buildSkillsNote(enabledSkills: string[]): string | null {
  if (enabledSkills.length === 0) return null
  const notes: string[] = []
  if (enabledSkills.includes('webSearch')) {
    if (isWebSearchConfigured()) {
      notes.push(
        'You can call `webSearch({ query })` when the user asks about current information ' +
          'or facts you may not have. Cite URLs from the results in your answer.'
      )
    } else {
      notes.push(
        'The user enabled "Web search" but the server is not configured (no TAVILY_API_KEY). ' +
          'You cannot actually search — say so briefly and answer from training data instead.'
      )
    }
  }
  if (notes.length === 0) return null
  return `Available capabilities:\n${notes.map((n) => `- ${n}`).join('\n')}`
}

const SUGGESTION_MODEL = 'google/gemini-2.5-flash'

function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      const textPart = m.content.find(
        (p): p is { type: 'text'; text: string } =>
          typeof p === 'object' && p !== null && (p as { type?: string }).type === 'text'
      )
      if (textPart) return textPart.text
    }
    return ''
  }
  return ''
}

function parseSuggestionsJson(raw: string): string[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim()
  try {
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 120)
      .slice(0, 3)
  } catch {
    return []
  }
}

async function generateSuggestions(
  gateway: ReturnType<typeof createGateway>,
  history: ModelMessage[],
  assistantReply: string,
  signal: AbortSignal
): Promise<string[]> {
  const userText = lastUserText(history)
  const prompt = `Based on this exchange, propose 3 concise follow-up questions the user might want to ask next. Each must be under 14 words, in the user's voice (not "ask the user…"). Reply with strict JSON only — a flat array of 3 strings, no prose:
["...", "...", "..."]

User asked:
"""
${userText.slice(0, 4000)}
"""

Assistant answered:
"""
${assistantReply.slice(0, 4000)}
"""`

  try {
    const result = await generateText({
      abortSignal: signal,
      model: gateway(SUGGESTION_MODEL),
      prompt,
      maxOutputTokens: 200,
      temperature: 0.7,
    })
    return parseSuggestionsJson(result.text)
  } catch {
    return []
  }
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
  const parsed = ChatRequestSchema.safeParse(raw)
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
  const apiKey = process.env.AI_GATEWAY_API_KEY

  if (!apiKey) {
    return NextResponse.json(
      { code: 'auth', message: 'Missing AI_GATEWAY_API_KEY.' },
      { status: 401 }
    )
  }

  const gateway = createGateway({ apiKey })
  const modelId = body.model || DEFAULT_CHAT_MODEL
  const enabledSkillIds = (body.skills ?? []).map((s) => s.id)

  // Build the tool map from enabled skills. A skill that needs server config
  // (e.g. TAVILY_API_KEY) returns null when unconfigured — we skip it in the
  // tool map and the system prompt note tells the model to fall back.
  const webSearchLog: WebSearchLog = []
  const tools: Record<string, unknown> = {}
  if (enabledSkillIds.includes('webSearch')) {
    const t = buildWebSearchTool(webSearchLog)
    if (t) tools.webSearch = t
  }

  try {
    const result = streamText({
      abortSignal: req.signal,
      model: gateway(modelId),
      system: buildSystemPrompt(body.files, body.workspaceSystemPrompt, enabledSkillIds),
      // Cast back: Zod validates the outer shape (role + content union),
      // but the AI SDK's ModelMessage uses tighter inner-part discriminants
      // than the schema's structural fallback. Trust the schema validation.
      messages: body.messages as ModelMessage[],
      // Only pass `tools` when non-empty — some providers reject the field
      // when present-but-empty. Default stop condition is `stepCountIs(1)`
      // which would prevent the model from continuing after a tool call;
      // bump it so it can call a tool, read the result, and answer.
      ...(Object.keys(tools).length > 0
        ? {
            tools: tools as Parameters<typeof streamText>[0]['tools'],
            stopWhen: stepCountIs(5),
          }
        : {}),
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
        let assistantText = ''
        let sawError = false
        try {
          for await (const part of result.fullStream) {
            if (part.type === 'text-delta') {
              const delta = (part as { delta?: string; text?: string }).delta
                ?? (part as { text?: string }).text
                ?? ''
              if (delta) {
                assistantText += delta
                send({ type: 'text', value: delta })
              }
            } else if (part.type === 'reasoning-delta') {
              const delta = (part as { delta?: string; text?: string }).delta
                ?? (part as { text?: string }).text
                ?? ''
              if (delta) send({ type: 'reasoning', value: delta })
            } else if (part.type === 'tool-call') {
              // Surface the call so the UI can show "Searching the web for X…".
              // We trust the tool definitions to produce a small input object.
              const p = part as { toolCallId?: string; toolName?: string; input?: unknown }
              send({
                type: 'tool_call',
                id: p.toolCallId ?? '',
                name: p.toolName ?? '',
                args: p.input ?? {},
              })
            } else if (part.type === 'tool-result') {
              const p = part as { toolCallId?: string; toolName?: string; output?: unknown }
              // Compute a short summary string the UI can display instead of
              // raw JSON. Avoids leaking large result payloads onto the wire.
              let summary = 'done'
              const output = p.output as { results?: unknown[]; error?: string } | undefined
              if (output?.error) {
                summary = output.error
              } else if (Array.isArray(output?.results)) {
                const n = output.results.length
                summary = `${n} result${n === 1 ? '' : 's'}`
              }
              send({
                type: 'tool_result',
                id: p.toolCallId ?? '',
                name: p.toolName ?? '',
                summary,
              })
            } else if (part.type === 'error') {
              const { code, message } = categorizeError(
                (part as { error?: unknown }).error
              )
              sawError = true
              send({ type: 'error', code, message })
            }
          }

          // The previous markdown footer is now superseded by the
          // first-class tool_calls record on the message — the client
          // collects tool_call / tool_result frames and persists them
          // on the message via setMessageToolCalls. Keeps the message
          // text clean (Copy / Export don't include the footer) and
          // lets us render the pretty pill on reload.

          // Best-effort follow-up suggestions. Only when the stream produced
          // a real answer (skip on error / aborted / empty). Runs after the
          // main stream so it doesn't add to time-to-first-token. Failures
          // are silent — suggestions are decoration, not blocking.
          if (
            !sawError &&
            !req.signal.aborted &&
            assistantText.trim().length > 0
          ) {
            const suggestions = await generateSuggestions(
              gateway,
              // Same cast as the streamText call above — Zod validates the
              // structural shape, the SDK uses tighter inner discriminants.
              body.messages as ModelMessage[],
              assistantText,
              req.signal
            )
            if (suggestions.length > 0) {
              send({ type: 'suggestions', values: suggestions })
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
