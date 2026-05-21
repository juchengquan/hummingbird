import type { NextRequest } from 'next/server'

import { createGateway } from '@ai-sdk/gateway'
import { generateText, stepCountIs, streamText, type ModelMessage } from 'ai'
import { NextResponse } from 'next/server'

import { DEFAULT_CHAT_MODEL } from '@/shared/models'
import { categorizeError } from '@/shared/api-errors'
import { ChatRequestSchema } from '@/shared/api-schemas'
import {
  buildWebSearchTool,
  isWebSearchConfigured,
  type WebSearchLog,
} from '@/server/skills/web-search'
import { buildMcpTool, mcpToolName } from '@/server/mcp/tools'
import { loadEffectiveMcpServers, type EffectiveMcpServer } from '@/server/mcp/load-servers'
import { resolveAttachedMcpResources } from '@/server/mcp/inject-resources'
import {
  renderAttachmentsPrompt,
  renderMetaOnlyFilesPrompt,
  type ResolvedAttachment,
} from '@/server/attachments/render'
import type { AttachmentPayload } from '@/shared/attachments'

// Soft cap on combined inline text across all attachments, to keep prompts
// inside reasonable token budgets. Per-file truncation already happens at
// extraction time; this is a second pass across the whole attachment set.
const TOTAL_ATTACHMENT_BUDGET = 96 * 1024

/**
 * Convert the wire-shape `AttachmentPayload[]` into the server-side
 * `ResolvedAttachment[]`. Files and URL bookmarks pass through with
 * minor field renaming; MCP resources require a `readResource` round
 * trip which we delegate to `resolveAttachedMcpResources` (concurrent
 * + per-call timeout + graceful error fallback).
 */
async function resolveAttachments(
  payloads: AttachmentPayload[] | undefined,
  mcpServers: EffectiveMcpServer[]
): Promise<ResolvedAttachment[]> {
  if (!payloads || payloads.length === 0) return []

  const resolved: ResolvedAttachment[] = []
  const mcpRequests: Parameters<typeof resolveAttachedMcpResources>[0] = []

  for (const att of payloads) {
    if (att.kind === 'file') {
      resolved.push({ kind: 'file', summary: att.summary })
    } else if (att.kind === 'url_bookmark') {
      resolved.push({
        kind: 'url_bookmark',
        title: att.bookmark.title,
        url: att.bookmark.url,
        content: att.bookmark.content,
        truncated: att.bookmark.contentTruncated,
        fetchedAt: att.bookmark.fetchedAt,
      })
    } else if (att.kind === 'mcp_resource') {
      mcpRequests.push({
        id: att.ref.id,
        serverId: att.ref.serverId,
        uri: att.ref.uri,
        name: att.ref.name,
        mimeType: att.ref.mimeType,
      })
    }
  }

  const mcpResolved = await resolveAttachedMcpResources(mcpRequests, mcpServers)
  resolved.push(...mcpResolved)
  return resolved
}

function buildSystemPrompt(opts: {
  workspaceSystemPrompt?: string
  /** Skill ids the user has effectively enabled for this turn. */
  enabledSkills?: string[]
  /** MCP server summaries — only used to mention available tooling.
   *  Tool definitions themselves are surfaced via the AI SDK's
   *  `tools` parameter, so we don't have to enumerate them in prose. */
  mcpServers?: { name: string; toolCount: number }[]
  /** Resolved attachments — files + bookmarks pass through verbatim,
   *  MCP resources arrive post-`readResource`. Single ordered list;
   *  `renderAttachmentsPrompt` groups by kind for readable section
   *  headers and shares the character budget across all of them. */
  attachments: ResolvedAttachment[]
}): string {
  const trimmedWorkspace = opts.workspaceSystemPrompt?.trim()
  const skillsLine = buildSkillsNote(opts.enabledSkills ?? [])
  const mcpLine = buildMcpNote(opts.mcpServers ?? [])
  // Workspace prompt goes first so user-set persona/style instructions take
  // precedence over our generic guidance. The base instructions then nudge the
  // model toward Markdown formatting (which the chat bubble now renders).
  const base = [
    trimmedWorkspace,
    'You are a helpful chat assistant inside the Hummingbird app. ' +
      'Answer concisely and use Markdown formatting when useful.',
    skillsLine,
    mcpLine,
  ]
    .filter(Boolean)
    .join('\n\n')

  if (opts.attachments.length === 0) return base

  const attachmentBlock = renderAttachmentsPrompt(
    opts.attachments,
    TOTAL_ATTACHMENT_BUDGET
  )

  // Meta-only files (filename + metadata, no extracted text) get a
  // separate "we couldn't extract this" footer. Files with text are
  // already in the main attachments block.
  const metaOnlyFiles = opts.attachments
    .filter((a): a is Extract<ResolvedAttachment, { kind: 'file' }> => a.kind === 'file')
    .map((a) => a.summary)
  const metaBlock = renderMetaOnlyFilesPrompt(metaOnlyFiles)

  return [base, attachmentBlock, metaBlock].filter(Boolean).join('\n\n')
}

function buildSkillsNote(enabledSkills: string[]): string | null {
  if (enabledSkills.length === 0) return null
  const notes: string[] = []
  if (enabledSkills.includes('webSearch')) {
    if (isWebSearchConfigured()) {
      notes.push(
        'You can call `webSearch({ query })` when the user asks about current information ' +
          'or facts you may not have. Cite sources using bracket markers `[1]`, `[2]`, etc. ' +
          'placed inline at the end of the sentence they support, matching the order results ' +
          'were returned in the most recent webSearch result. Do not repeat the URL in the ' +
          'text — the UI renders `[N]` as a clickable link to source N.'
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

function buildMcpNote(servers: { name: string; toolCount: number }[]): string | null {
  const active = servers.filter((s) => s.toolCount > 0)
  if (active.length === 0) return null
  const list = active
    .map((s) => `- "${s.name}" (${s.toolCount} ${s.toolCount === 1 ? 'tool' : 'tools'})`)
    .join('\n')
  return (
    `You have access to tools from MCP (Model Context Protocol) servers ` +
    `the user has connected. Tool names are prefixed with ` +
    `\`mcp__<serverId>__<toolName>\`; their descriptions and input schemas ` +
    `are attached. Call them when relevant to the user's request. ` +
    `MCP servers connected:\n${list}`
  )
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
  // Register MCP-exposed tools for every enabled server. Local-mode
  // servers come in via `body.mcpServers` with their cred attached;
  // cloud-mode servers are looked up server-side from Supabase and
  // their cred decrypted via the SECURITY DEFINER RPC. Tool name is
  // prefixed `mcp__<serverId>__<toolName>` so model logs carry
  // provenance and tools from different servers don't collide.
  const mcpServers = await loadEffectiveMcpServers(
    body.workspaceId,
    body.mcpServers
  )
  const mcpToolNames: string[] = []
  for (const server of mcpServers) {
    for (const descriptor of server.capabilities?.tools ?? []) {
      const name = mcpToolName(server.id, descriptor.name)
      tools[name] = buildMcpTool(server, descriptor, server.credentials)
      mcpToolNames.push(name)
    }
  }
  // Wire→resolved: files + bookmarks pass through verbatim, MCP
  // resources go through `resolveAttachedMcpResources` (concurrent
  // reads + per-call timeout + graceful error fallback inline in the
  // prompt). Failures render as "[unavailable]" markers rather than
  // blocking the turn.
  const attachments = await resolveAttachments(body.attachments, mcpServers)

  try {
    const result = streamText({
      abortSignal: req.signal,
      model: gateway(modelId),
      system: buildSystemPrompt({
        workspaceSystemPrompt: body.workspaceSystemPrompt,
        enabledSkills: enabledSkillIds,
        mcpServers: mcpServers.map((s) => ({
          name: s.name,
          toolCount: s.capabilities?.tools?.length ?? 0,
        })),
        attachments,
      }),
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
            // 5 steps is enough for the single built-in skill (webSearch).
            // Bump to 8 when MCP tools are registered — those chain
            // naturally (list → get → filter → answer).
            stopWhen: stepCountIs(mcpToolNames.length > 0 ? 8 : 5),
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
              let results: Array<{ title: string; url: string; snippet: string }> | undefined
              const output = p.output as
                | { results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown }>; error?: string }
                | undefined
              if (output?.error) {
                summary = output.error
              } else if (Array.isArray(output?.results)) {
                const n = output.results.length
                summary = `${n} result${n === 1 ? '' : 's'}`
                // Pass results through to the client for the Sources strip
                // and `[N]` citation markers. Only webSearch produces this
                // shape; other tools without a `results` array fall through
                // to the bare summary.
                if (p.toolName === 'webSearch') {
                  results = output.results
                    .map((r) => ({
                      title: typeof r?.title === 'string' ? r.title : '',
                      url: typeof r?.url === 'string' ? r.url : '',
                      snippet: typeof r?.snippet === 'string' ? r.snippet : '',
                    }))
                    .filter((r) => r.url) // drop malformed entries
                }
              }
              send({
                type: 'tool_result',
                id: p.toolCallId ?? '',
                name: p.toolName ?? '',
                summary,
                ...(results ? { results } : {}),
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
