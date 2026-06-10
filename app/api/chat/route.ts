import type { NextRequest } from 'next/server'

import { stepCountIs, streamText, type ModelMessage } from 'ai'
import { NextResponse } from 'next/server'

import { DEFAULT_CHAT_MODEL, ROUTING_CONFIG, isAutoModel } from '@/shared/models'
import { reasoningCallOptions } from '@/shared/reasoning-effort'
import { routeModel } from '@/server/routing/router'
import {
  ProviderUnavailableError,
  selectModel,
} from '@/server/model-provider'
import { categorizeError } from '@/shared/api-errors'
import { ChatRequestSchema } from '@/shared/api-schemas'
import {
  SERVER_SKILLS,
  type SkillRequestEntry,
} from '@/server/skills/registry'
import type { SkillId } from '@/shared/skills/types'
import { isSearchFilesToolName, isWebSearchToolName } from '@/shared/skills/types'
import { buildMcpTool, mcpToolName } from '@/server/mcp/tools'
import {
  RENDER_UI_PROMPT_FRAGMENT,
  RENDER_UI_TOOL_NAME,
  buildRenderUITool,
  type RenderUIToolResult,
} from '@/server/generative-ui/tool'
import { loadEffectiveMcpServers, type EffectiveMcpServer } from '@/server/mcp/load-servers'
import { createSlidingWindow, rateLimitKey } from '@/server/rate-limit'
import {
  AI_SDK_STREAM_HEADER_NAME,
  AI_SDK_STREAM_HEADER_VALUE,
  ChatSseEmitter,
  type ToolResultPayload,
} from '@/server/chat/sse-emitter'
import { buildSystemPrompt, lastUserText } from '@/server/chat/prompt-builders'
import { generateSuggestions } from '@/server/chat/suggestions'
import { persistGeneratedImages, type ImageToPersist } from '@/server/image-storage'
import { resolveAttachedMcpResources } from '@/server/mcp/inject-resources'
import {
  type ResolvedAttachment,
} from '@/server/attachments/render'
import type { AttachmentPayload } from '@/shared/attachments'

// Per-IP rate limit shared across the chat route's web-tool calls
// (webSearch + webFetch combined). The per-turn caps inside each tool
// are budget hints to the model; this is the abuse gate that runs
// across turns. See the call site for the rationale.
const chatWebToolLimit = createSlidingWindow({ windowMs: 60_000, max: 20 })

// Per-IP rate limit for image generation. Separate bucket because
// image gen costs ~1–3¢ per call vs. fractions of a cent for the web
// tools — needs a tighter ceiling. The cap is env-configurable so
// trusted deployments can raise it; abusive ones can lower it.
const IMAGE_GEN_PER_MINUTE = (() => {
  const raw = Number(process.env.MINIMAX_IMAGE_RATE_LIMIT_PER_MINUTE)
  if (!Number.isFinite(raw) || raw <= 0) return 5
  return Math.min(Math.floor(raw), 60)
})()
const chatImageGenLimit = createSlidingWindow({
  windowMs: 60_000,
  max: IMAGE_GEN_PER_MINUTE,
})

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

// `buildSystemPrompt` + `buildSkillsNote` + `buildMcpNote` +
// `buildRemixNote` + `lastUserText` extracted to
// `lib/server/chat/prompt-builders.ts`. `generateSuggestions` +
// `parseSuggestionsJson` extracted to `lib/server/chat/suggestions.ts`
// — both are unit-tested independently of the streaming surface.

/**
 * After the `generateImage` tool returns, persist Minimax's hosted
 * URLs server-side (currently as data URLs; future PR upgrades to
 * Supabase Storage) and emit a `tool_image` SSE frame so the chat
 * client appends the rendered images to the message.
 *
 * Failure is non-fatal: if the download/encode fails we just skip
 * the frame. The model already saw the tool succeed; the user-facing
 * fallback is a missing image rather than a broken chat.
 */
async function maybeEmitImageFrame(
  part: { toolCallId?: string; toolName?: string; output?: unknown },
  emitter: ChatSseEmitter,
  signal: AbortSignal,
  /** Mirror of `body.localFilesOnly` — when true, force the
   *  persistence layer into its data-URL path instead of uploading to
   *  Supabase Storage. */
  localFilesOnly: boolean
): Promise<void> {
  const output = part.output as
    | {
        ok?: boolean
        mode?: 't2i' | 'i2i'
        prompt?: string
        images?: Array<{
          id?: string
          url?: string
          width?: number
          height?: number
          format?: string
        }>
      }
    | undefined
  if (!output?.ok || !Array.isArray(output.images) || output.images.length === 0) {
    return
  }
  const toolCallId = part.toolCallId ?? 'img'
  const inputs: ImageToPersist[] = output.images
    .filter((img): img is typeof img & { url: string } => typeof img?.url === 'string')
    .map((img, i) => ({
      // Stable per-image id — used as the React key AND the storage
      // object name, so the persistence layer can write
      // `user-files/{user_id}/generated/{id}.{ext}` deterministically.
      id: `${toolCallId}-${i}`,
      url: img.url,
      width: typeof img.width === 'number' ? img.width : 0,
      height: typeof img.height === 'number' ? img.height : 0,
      format: typeof img.format === 'string' ? img.format : 'png',
    }))
  if (inputs.length === 0) return

  const persisted = await persistGeneratedImages(inputs, {
    signal,
    localFilesOnly,
  })
  if (!persisted.ok) return

  const mode: 't2i' | 'i2i' = output.mode === 'i2i' ? 'i2i' : 't2i'
  const prompt = typeof output.prompt === 'string' ? output.prompt : ''
  emitter.toolImage({
    id: part.toolCallId ?? '',
    mode,
    images: persisted.images.map((img) => ({
      id: img.id,
      url: img.url,
      ...(img.storagePath ? { storagePath: img.storagePath } : {}),
      width: img.width,
      height: img.height,
      format: img.format,
      prompt,
      mode,
    })),
  })
}

/**
 * System note instructing the model to use the user's pinned reference
 * image for the next `generateImage` call (I2I mode). Returns null when
 * no reference is pending or when the imageGen skill isn't enabled —
 * a reference without the tool would just be confusing context.
 */
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
  // Smart routing: when the client picks "Auto", resolve it server-side to
  // a concrete model per prompt (cheap turns → weak, hard turns → strong).
  // Resolved before any model dispatch so reasoning / gateway options key
  // off the concrete id. `autoRoutedTo` is non-null only when routing fired,
  // so the stream can surface a "routed to X" caption. See
  // docs/PLAN-model-routing.md.
  const requestedModel = body.model || DEFAULT_CHAT_MODEL
  let modelId = requestedModel
  let autoRoutedTo: string | null = null
  if (isAutoModel(requestedModel) && ROUTING_CONFIG) {
    const decision = routeModel(
      {
        text: lastUserText(body.messages as ModelMessage[]),
        hasAttachments: (body.attachments ?? []).length > 0,
        messageCount: body.messages.length,
      },
      ROUTING_CONFIG
    )
    modelId = decision.modelId
    autoRoutedTo = decision.modelId
  }
  // Auto-enable `searchFiles` whenever any attachment is in RAG mode —
  // the file is no longer inlined, so the model needs the skill to
  // reach it. Force-on overrides a missing client toggle but stops
  // short of overriding an explicit mute (the existing mute path
  // already won) — RAG attachments would be orphaned without it.
  const anyRagAttachment = (body.attachments ?? []).some(
    (a) => a.kind === "file" && a.summary.retrievalMode === "rag",
  )
  const clientEnabledSkillIds: SkillId[] = (body.skills ?? [])
    .map((s) => s.id as SkillId)
  const enabledSkillIds: SkillId[] =
    anyRagAttachment && !clientEnabledSkillIds.includes("searchFiles" as SkillId)
      ? [...clientEnabledSkillIds, "searchFiles" as SkillId]
      : clientEnabledSkillIds
  // Resolve the user-facing webSearch cap from the request. The client
  // Per-IP cross-tool rate limit. The per-turn caps inside each
  // skill tool (e.g. webFetch 5, webSearch 3) are budget hints to
  // the model — a cooperative client can sidestep them by splitting
  // one logical question into many turns. This cap is the actual
  // abuse gate: at most 20 outbound web ops per IP per minute,
  // summed across all chat-route web tools. Counted on tool
  // invocation, not per HTTP request. The existing /api/url/fetch
  // route has its own bucket (30/min/IP) — the two are intentionally
  // separate so a user filling their bookmark library doesn't
  // starve their chat turn.
  const ipKey = rateLimitKey(req)
  const consumeWebToolBudget = () => chatWebToolLimit.consume(ipKey)
  const consumeImageGenBudget = () => chatImageGenLimit.consume(ipKey)

  // Build the tool map by iterating the server-side skill registry.
  // Each ServerSkill owns its own config resolution + log + tool
  // builder; the route just enables what the client asked for. Adding
  // a new skill is one entry in SERVER_SKILLS — no branch here.
  const enabledSet = new Set<SkillId>(enabledSkillIds)
  const skillRequestEntries: SkillRequestEntry[] = body.skills ?? []
  const entryById = new Map<string, SkillRequestEntry>(
    skillRequestEntries.map((s) => [s.id, s])
  )
  const tools: Record<string, unknown> = {}
  for (const skill of SERVER_SKILLS) {
    if (!enabledSet.has(skill.id)) continue
    // Image generation lives on a tighter per-IP bucket because each
    // call costs an order of magnitude more than the web tools.
    // Every other skill shares the unified web-tool bucket.
    const consumeBudget =
      skill.id === 'imageGen' ? consumeImageGenBudget : consumeWebToolBudget
    const tool = skill.buildTool(entryById.get(skill.id), {
      signal: req.signal,
      consumeBudget,
    })
    if (tool) tools[skill.toolName] = tool
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
  // Generative-UI `renderUI` — always-on system tool (no chip in the
  // skills panel, no env requirement). The model decides when to
  // emit a structured UI part; the `promptFragment` is appended to
  // the system prompt unconditionally. See
  // `docs/PLAN-generative-ui-parts.md`.
  tools[RENDER_UI_TOOL_NAME] = buildRenderUITool()
  // Wire→resolved: files + bookmarks pass through verbatim, MCP
  // resources go through `resolveAttachedMcpResources` (concurrent
  // reads + per-call timeout + graceful error fallback inline in the
  // prompt). Failures render as "[unavailable]" markers rather than
  // blocking the turn.
  const attachments = await resolveAttachments(body.attachments, mcpServers)

  // Idle watchdog: cancel the upstream call if the stream goes silent
  // mid-response. Declared here so the AbortSignal can be combined with
  // `req.signal` and threaded into `streamText`. The timer is armed inside
  // the ReadableStream's `start()` so it only runs once we're actually
  // consuming the stream.
  const IDLE_TIMEOUT_MS = 90_000
  const idleAbort = new AbortController()
  const combinedSignal =
    typeof AbortSignal.any === 'function'
      ? AbortSignal.any([req.signal, idleAbort.signal])
      : req.signal
  // Fallback wiring for runtimes without `AbortSignal.any`: forward both
  // sources into a third controller manually. (Node 20.3+ has `.any`.)
  let manualCombined: AbortController | null = null
  if (typeof AbortSignal.any !== 'function') {
    manualCombined = new AbortController()
    const relay = () => manualCombined?.abort()
    req.signal.addEventListener('abort', relay, { once: true })
    idleAbort.signal.addEventListener('abort', relay, { once: true })
  }
  const upstreamSignal = manualCombined?.signal ?? combinedSignal

  // Per-workspace dashboard facet on the Vercel AI Gateway. `tags` is a
  // free-form `string[]` the gateway server reads from the request body and
  // uses to bucket the call on its analytics view. Non-gateway routes
  // (`minimax-cn` via @ai-sdk/anthropic, self-host via @ai-sdk/openai-compatible)
  // ignore the entire `gateway` provider-options namespace, so this is a
  // hard no-op for them — no branching needed. Skip when no `workspaceId`
  // so signed-out turns don't pollute the dashboard with a phantom
  // `workspace:undefined` bucket. See
  // `docs/PLAN-gateway-caching-and-workspace-tagging.md`.
  // Reasoning-effort tier → provider-specific thinking-budget /
  // reasoning_effort options (+ a matching maxOutputTokens for Anthropic,
  // whose max_tokens must exceed the thinking budget). Empty for models
  // whose provider has no mapping, so it spreads cleanly. See
  // `docs/PLAN-reasoning-effort-control.md`.
  const reasoning = reasoningCallOptions(modelId, body.reasoningEffort)

  // Merge the per-workspace gateway tags (a no-op on non-gateway routes —
  // see PLAN-gateway-caching-and-workspace-tagging) with the reasoning
  // provider options into one `providerOptions` object. Skip the
  // `workspace:` tag when signed out so the dashboard isn't polluted with
  // a phantom `workspace:undefined` bucket.
  const providerOptions: Record<string, Record<string, unknown>> = {
    ...(body.workspaceId
      ? { gateway: { tags: [`workspace:${body.workspaceId}`, `model:${modelId}`] } }
      : {}),
    ...reasoning.providerOptions,
  }
  const callExtras = {
    ...(Object.keys(providerOptions).length > 0
      ? { providerOptions: providerOptions as Parameters<typeof streamText>[0]['providerOptions'] }
      : {}),
    ...(reasoning.maxOutputTokens
      ? { maxOutputTokens: reasoning.maxOutputTokens }
      : {}),
  }

  try {
    const result = streamText({
      abortSignal: upstreamSignal,
      model: selectModel(modelId),
      system: [
        buildSystemPrompt({
          workspaceSystemPrompt: body.workspaceSystemPrompt,
          enabledSkillIds,
          skillRequestEntries,
          mcpServers: mcpServers.map((s) => ({
            name: s.name,
            toolCount: s.capabilities?.tools?.length ?? 0,
          })),
          attachments,
          referenceImage: body.referenceImage,
        }),
        // Always-on system tool; the fragment teaches the model when
        // to call `renderUI`. Trailing the existing prompt keeps the
        // cache-stable prefix (workspace voice + skills) on top.
        RENDER_UI_PROMPT_FRAGMENT,
      ].join("\n\n"),
      // Cast back: Zod validates the outer shape (role + content union),
      // but the AI SDK's ModelMessage uses tighter inner-part discriminants
      // than the schema's structural fallback. Trust the schema validation.
      messages: body.messages as ModelMessage[],
      ...callExtras,
      // Only pass `tools` when non-empty — some providers reject the field
      // when present-but-empty. Default stop condition is `stepCountIs(1)`
      // which would prevent the model from continuing after a tool call;
      // bump it so it can call a tool, read the result, and answer.
      ...(Object.keys(tools).length > 0
        ? (() => {
            // Step budget. webSearch alone: 6 steps (model can chain a few
            // searches and still have one forced text-only step at the end).
            // With MCP tools registered: 10, because list → get → filter →
            // answer naturally takes more steps. Computed once so the
            // `stopWhen` cap and the `lastStepIndex` guard inside
            // `prepareStep` can't drift apart.
            const stepBudget = mcpToolNames.length > 0 ? 10 : 6
            const lastStepIndex = stepBudget - 1
            return {
              tools: tools as Parameters<typeof streamText>[0]['tools'],
              stopWhen: stepCountIs(stepBudget),
              // Force the last step to be text-only. Without this, reasoning
              // models can chain tool calls until they hit the cap and emit
              // `finishReason: tool-calls` — i.e. cut off mid-loop with no
              // answer. By disabling tools on the final step we guarantee at
              // least one text-producing step before stopWhen fires.
              prepareStep: ({ stepNumber }: { stepNumber: number }) => {
                // Force the last step to be text-only as a hard backstop.
                //
                // We intentionally do NOT drop webSearch from `activeTools`
                // mid-turn once its budget is exhausted: some models (notably
                // DeepSeek-family) react to a missing tool by leaking their
                // internal tool-call markup as plain text (e.g.
                // `<｜｜DSML｜｜tool_calls>…`) instead of writing an answer.
                // Instead, the cap is enforced inside `webSearch`'s `execute`
                // — over-budget calls return a normal tool-result with an
                // error message, which the model handles gracefully.
                if (stepNumber >= lastStepIndex) {
                  return { toolChoice: 'none' as const }
                }
                return undefined
              },
            }
          })()
        : {}),
    })

    // Re-emit `fullStream` as SSE in one of two wire formats:
    //   - `custom` — `{type:"text"|"reasoning"|"tool_call"|...,...}`
    //     frames the existing chat panel consumer reads.
    //   - `ai-sdk` — the AI SDK v5 UI message stream protocol, with
    //     our custom extras (`tool_image`, `suggestions`) riding on
    //     `data-tool-image` / `data-suggestions` parts.
    //
    // The `ChatSseEmitter` hides the wire shape behind logical
    // methods (`text` / `reasoning` / `toolCall` / `toolResult` /
    // `toolImage` / `suggestions` / `error` / `done`). The
    // fullStream loop below speaks logically; the emitter does the
    // per-format lifecycle bookkeeping.
    const encoder = new TextEncoder()
    const sse = new ReadableStream({
      async start(controller) {
        const writeLine = (line: string) => {
          controller.enqueue(encoder.encode(line))
        }
        const emitter = new ChatSseEmitter(writeLine)
        emitter.start()
        // Surface the resolved model when the turn was smart-routed, so the
        // assistant bubble can show a "routed to X" caption.
        if (autoRoutedTo) emitter.routedModel(autoRoutedTo)
        let assistantText = ''
        let sawError = false
        let sawReasoning = false
        let sawToolResult = false
        let toolErrorCount = 0
        let finalFinishReason: string | null = null
        let lastStepFinishReason: string | null = null
        let stepCount = 0
        // Behind DEBUG_CHAT_STREAM=1, dump every fullStream part type so we
        // can diagnose models that emit content via a part type the router
        // doesn't handle today (raw / source / tool-error / etc.).
        const debugStream = process.env.DEBUG_CHAT_STREAM === '1'
        // Idle watchdog: declared outside start() so the signal could be
        // threaded into streamText. Arm it now that we're consuming the
        // stream; reset on every part; clear in the finally below.
        let idleTimer: ReturnType<typeof setTimeout> | null = null
        let idleTimedOut = false
        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            idleTimedOut = true
            console.warn(
              `[chat] idle-timeout firing (model=${modelId}, sawReasoning=${sawReasoning}, sawToolResult=${sawToolResult}, lastStepFinishReason=${lastStepFinishReason})`
            )
            idleAbort.abort()
          }, IDLE_TIMEOUT_MS)
        }
        armIdle()
        try {
          for await (const part of result.fullStream) {
            armIdle()
            if (debugStream) {
              console.warn('[chat-stream]', part.type, Object.keys(part).filter((k) => k !== 'type'))
            }
            if (part.type === 'text-delta') {
              const delta = (part as { delta?: string; text?: string }).delta
                ?? (part as { text?: string }).text
                ?? ''
              if (delta) {
                assistantText += delta
                emitter.text(delta)
              }
            } else if (part.type === 'reasoning-delta') {
              const delta = (part as { delta?: string; text?: string }).delta
                ?? (part as { text?: string }).text
                ?? ''
              if (delta) {
                sawReasoning = true
                emitter.reasoning(delta)
              }
            } else if (part.type === 'tool-call') {
              // Surface the call so the UI can show "Searching the web for X…".
              // We trust the tool definitions to produce a small input object.
              const p = part as { toolCallId?: string; toolName?: string; input?: unknown }
              emitter.toolCall(p.toolCallId ?? '', p.toolName ?? '', p.input)
            } else if (part.type === 'tool-result') {
              const p = part as { toolCallId?: string; toolName?: string; output?: unknown }
              // Compute a short summary string the UI can display instead of
              // raw JSON. Avoids leaking large result payloads onto the wire.
              let summary = 'done'
              let results: Array<{ title: string; url: string; snippet: string }> | undefined
              const output = p.output as
                | {
                    results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown }>
                    fragments?: unknown[]
                    error?: string
                  }
                | undefined
              if (output?.error) {
                summary = output.error
              } else if (Array.isArray(output?.results)) {
                const n = output.results.length
                summary = `${n} result${n === 1 ? '' : 's'}`
                // Pass results through to the client for the Sources strip
                // and `[N]` citation markers. Only web-search tools (Tavily
                // + Brave) produce this shape; other tools without a
                // `results` array fall through to the bare summary.
                if (p.toolName && isWebSearchToolName(p.toolName)) {
                  results = output.results
                    .map((r) => ({
                      title: typeof r?.title === 'string' ? r.title : '',
                      url: typeof r?.url === 'string' ? r.url : '',
                      snippet: typeof r?.snippet === 'string' ? r.snippet : '',
                    }))
                    .filter((r) => r.url) // drop malformed entries
                }
              } else if (
                p.toolName &&
                isSearchFilesToolName(p.toolName) &&
                Array.isArray(output?.fragments)
              ) {
                // searchFiles returns `{ fragments: string[], rank }` on
                // success — surface the count so the tool-call pill
                // reads "Searched attached files · 3 excerpts" rather
                // than "done". Fragments themselves stay server-side;
                // the model quotes the relevant bits into its own
                // response text.
                const n = output.fragments.length
                summary = `${n} excerpt${n === 1 ? '' : 's'}`
              }
              sawToolResult = true
              const trPayload: ToolResultPayload = {
                id: p.toolCallId ?? '',
                name: p.toolName ?? '',
                summary,
                ...(results ? { results } : {}),
              }
              emitter.toolResult(trPayload)
              // generateImage: persist Minimax's short-lived URLs
              // server-side and emit a separate `tool_image` SSE
              // frame the client renders inline. The model's view
              // (the `tool_result` text above) still says "rendered
              // N images" — UI is decoupled from the tool's contract.
              if (p.toolName === 'generateImage') {
                await maybeEmitImageFrame(
                  p,
                  emitter,
                  req.signal,
                  body.localFilesOnly === true
                )
              }
              // renderUI: the tool's `execute` already validated the
              // `{ kind, props }` pair against the shared schema. Emit a
              // `data-ui` frame the client appends to `Message.uiParts`.
              // When validation failed the tool returns `{ error }` —
              // the tool-result text above carries that to the model;
              // we skip the UI emit so nothing renders client-side.
              if (p.toolName === RENDER_UI_TOOL_NAME) {
                const out = p.output as RenderUIToolResult | undefined
                if (out && !out.error && typeof out.kind === 'string') {
                  emitter.uiPart({
                    id: p.toolCallId ?? '',
                    kind: out.kind,
                    props: out.props,
                  })
                }
              }
            } else if (part.type === 'tool-error') {
              // Tool execute() threw or args were malformed. The model never
              // sees a result so the next step often produces no answer.
              // Record it; surface as a tool_result with an error summary
              // so the UI pill flips out of "running" instead of spinning.
              const p = part as { toolCallId?: string; toolName?: string; error?: unknown }
              toolErrorCount += 1
              const errMsg = p.error instanceof Error
                ? p.error.message
                : typeof p.error === 'string'
                  ? p.error
                  : 'Tool error'
              console.warn(
                `[chat] tool-error (model=${modelId}, tool=${p.toolName}, msg=${errMsg})`
              )
              emitter.toolResult(
                {
                  id: p.toolCallId ?? '',
                  name: p.toolName ?? '',
                  summary: `error: ${errMsg}`,
                },
                true,
              )
            } else if (part.type === 'finish-step') {
              const p = part as { finishReason?: string }
              stepCount += 1
              lastStepFinishReason = p.finishReason ?? null
              if (debugStream) {
                console.warn(
                  `[chat-stream] finish-step #${stepCount} reason=${lastStepFinishReason} textLen=${assistantText.length}`
                )
              }
            } else if (part.type === 'finish') {
              const p = part as { finishReason?: string }
              finalFinishReason = p.finishReason ?? null
              if (debugStream) {
                console.warn(`[chat-stream] finish reason=${finalFinishReason}`)
              }
            } else if (part.type === 'abort') {
              // Provider-side abort. Treat as error so the UI surfaces it
              // rather than silently truncating.
              console.warn(`[chat] provider abort (model=${modelId})`)
              sawError = true
              emitter.error('provider', 'The model provider aborted the response.')
            } else if (part.type === 'error') {
              const { code, message } = categorizeError(
                (part as { error?: unknown }).error
              )
              sawError = true
              emitter.error(code, message)
            }
          }

          // Generic "model leaked its internal tool-call markup as text"
          // detector. Different families use different tokens
          // (DeepSeek's full-width `<｜｜DSML｜｜tool_calls>…`,
          //  Anthropic-style `<function_calls><invoke>…`,
          //  Mistral/Llama `<tool_call>…</tool_call>`, ChatML
          //  `<|tool_call|>…`, etc.), so instead of stripping known
          // patterns, we check whether the assistant's text looks
          // structurally like a tool-call dump: lots of angle-bracket
          // markup whose tag names contain "tool_call", "function_call",
          // "tool_use", or "invoke". This is provider-agnostic — it
          // matches the SHAPE of leaked markup, not specific tokens —
          // and only fires when the markup dominates the text.
          //
          // The shared root cause has been removed (we no longer drop
          // tools from `activeTools` mid-turn), so this should be very
          // rare in practice. It's here so a future model regression
          // surfaces as a clear error instead of opaque gibberish.
          const TOOLCALL_TAG_RE =
            /[<＜《〈｜{[][^<>]*(?:tool_call|tool_use|function_call|invoke|tool_calls)\b/i
          const looksLikeLeakedToolCall =
            TOOLCALL_TAG_RE.test(assistantText) &&
            // Stripping the markup-shaped substrings should remove most of
            // the text. If what's left after a generic tag/JSON-ish strip
            // is shorter than 40 chars (a sentence or two), treat the
            // whole output as a leak.
            assistantText
              .replace(/<[^>]+>/g, '')
              .replace(/[＜《〈｜][^＞》〉｜]*[＞》〉｜]/g, '')
              .replace(/\{[^{}]*"(?:name|tool|function)"[^{}]*\}/g, '')
              .trim().length < 40
          if (looksLikeLeakedToolCall) {
            console.warn(
              `[chat] tool-call-markup leak detected (model=${modelId}, textLen=${assistantText.length})`
            )
          }

          // Idle watchdog tripped — the stream went silent. The for-await
          // above exits cleanly when idleAbort fires (the AI SDK plumbs
          // abortSignal through), so we detect it here.
          if (idleTimedOut && !sawError) {
            sawError = true
            emitter.error(
              'provider',
              `Model stopped responding after ${Math.round(IDLE_TIMEOUT_MS / 1000)}s of silence (last step finish: ${lastStepFinishReason ?? 'unknown'}).`,
            )
          }

          // Stream ended without a complete answer. Two cases:
          //   1. Zero text at all but we saw reasoning / tool activity.
          //   2. Some preamble text, but the overall finish reason is
          //      `tool-calls` / `length` / `content-filter` — the model
          //      was cut off mid-stream. This is the case where the user
          //      sees a few words and then nothing.
          // Either way, surface as an error frame so the toast + Retry
          // path handles it instead of leaving a half-finished bubble.
          const truncated =
            (finalFinishReason === 'tool-calls' ||
              finalFinishReason === 'length' ||
              finalFinishReason === 'content-filter') &&
            !sawError &&
            !req.signal.aborted
          const empty =
            !sawError &&
            !req.signal.aborted &&
            (assistantText.trim().length === 0 || looksLikeLeakedToolCall) &&
            (sawReasoning || sawToolResult || toolErrorCount > 0 || looksLikeLeakedToolCall)
          if (truncated || empty) {
            sawError = true
            const reason = finalFinishReason ?? lastStepFinishReason ?? 'unknown'
            const hint =
              reason === 'length'
                ? 'output token budget exhausted — try a shorter conversation or different model'
                : reason === 'content-filter'
                  ? 'response blocked by content filter'
                  : reason === 'tool-calls'
                    ? 'model kept calling tools instead of answering — try rephrasing or disable web search'
                    : looksLikeLeakedToolCall
                      ? 'model emitted internal tool-call markup instead of an answer — try rephrasing or switch model'
                      : sawToolResult
                        ? 'model didn\'t write an answer after the tool call'
                        : 'model produced reasoning but no answer'
            console.warn(
              `[chat] truncated-response (model=${modelId}, reason=${reason}, textLen=${assistantText.length}, hadReasoning=${sawReasoning}, hadToolResult=${sawToolResult}, toolErrors=${toolErrorCount}, steps=${stepCount})`
            )
            emitter.error(
              'provider',
              assistantText.trim().length === 0
                ? `The model returned no answer (${hint}; finish reason: ${reason}).`
                : `The model was cut off before finishing its answer (${hint}; finish reason: ${reason}).`,
            )
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
              // Same cast as the streamText call above — Zod validates the
              // structural shape, the SDK uses tighter inner discriminants.
              body.messages as ModelMessage[],
              assistantText,
              req.signal
            )
            if (suggestions.length > 0) {
              emitter.suggestions(suggestions)
            }
          }

          if (sawError) {
            // Already wrote an error frame — emit `[DONE]` without
            // `finish` so the consumer's finally-block fires but it
            // can still distinguish completion from failure.
            emitter.endAfterError()
          } else {
            emitter.done()
          }
          controller.close()
        } catch (error) {
          // If the idle watchdog tripped, `streamText`'s upstream call was
          // aborted via the combined signal — that surfaces as an exception
          // out of the for-await rather than a clean end. Translate it into
          // our explicit "stopped responding" error so the user sees the
          // diagnostic, not a generic network error.
          if (idleTimedOut) {
            emitter.error(
              'provider',
              `Model stopped responding after ${Math.round(IDLE_TIMEOUT_MS / 1000)}s of silence (last step finish: ${lastStepFinishReason ?? 'unknown'}).`,
            )
          } else {
            const { code, message } = categorizeError(error)
            emitter.error(code, message)
          }
          emitter.endAfterError()
          controller.close()
        } finally {
          if (idleTimer) clearTimeout(idleTimer)
        }
      },
      cancel() {
        // Client disconnected mid-stream; the abortSignal on streamText
        // is already wired to req.signal so the upstream call gets cancelled.
      },
    })

    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // `useChat()` checks this header to confirm the response speaks
      // the AI SDK v5 UI message stream protocol.
      [AI_SDK_STREAM_HEADER_NAME]: AI_SDK_STREAM_HEADER_VALUE,
    }
    return new Response(sse, { headers })
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
