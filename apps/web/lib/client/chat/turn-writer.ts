"use client"
import "client-only"

/**
 * The per-frame handling of one assistant turn — what `callChatAPI`'s
 * stream loop did inline for each `/v1/chat` / `/api/chat` frame, moved
 * here unchanged so chat on runs (`lib/client/runs/chat-runner.ts`) can
 * apply the reducer's frames to a message exactly the same way (its
 * `RunSink`).
 *
 * A writer owns one stream's local state: the assistant placeholder
 * (created on the first output frame, or handed in up front — a run
 * creates it before starting), the tool-call buffer mirrored into the
 * live pills, the reasoning timers, and the `error` / `memory_tainted`
 * flags of the `/v1/chat` protocol.
 *
 * For runs it also implements `clear()` (a `reset`: the replay rebuilds
 * the message) — the ids of the generated images / files the message held
 * before the clear are remembered so their artifacts aren't created
 * twice — and a `base`: when a resume run continues a paused turn in the
 * same message, a reset restores what the earlier run wrote before the
 * resume's frames are re-applied.
 */

import type { Dispatch, SetStateAction } from "react"

import {
  finishToolCall,
  startToolCall,
} from "@/client/chat/tool-call-buffer"
import type { NormalisedFrame } from "@/client/chat/sse-frame-translator"
import { artifactStoragePathFor } from "@/client/messages/message-blobs"
import type { AppState } from "@/client/hooks/use-store"
import type { LiveToolCall } from "@/components/skills/tool-call-strip"
import { parsePersistedUiPart } from "@/shared/generative-ui/schemas"
import type { Message, ToolCallRecord } from "@/shared/types"

/** The store mutators a writer calls (stable Zustand actions). */
export type TurnWriterStore = Pick<
  AppState,
  | "addMessage"
  | "setConversationTyping"
  | "appendToMessage"
  | "appendToMessageReasoning"
  | "appendMessageGeneratedImages"
  | "appendMessageGeneratedFiles"
  | "appendMessageCodeResult"
  | "appendMessageUiPart"
  | "appendMessageMcpApp"
  | "setMessageSuggestions"
  | "setMessageVerification"
  | "setMessageRoutedModel"
  | "setMessageToolCalls"
  | "createArtifact"
>

export interface TurnWriterDeps extends TurnWriterStore {
  setLiveToolCalls: Dispatch<SetStateAction<Record<string, LiveToolCall[]>>>
  /** Runs only (`clear()`): the mutator a reset starts with, and a fresh
   *  read of the message (its generated items' ids). */
  clearMessageOutput?: (messageId: string) => void
  getMessage?: (messageId: string) => Message | undefined
}

/** What an earlier run of the same turn wrote onto the message — restored
 *  by a reset of the run continuing it (`messageBaseOf`). */
export type MessageBase = Pick<
  Message,
  | "content"
  | "reasoning"
  | "toolCalls"
  | "generatedImages"
  | "generatedFiles"
  | "codeResults"
  | "uiParts"
  | "mcpApps"
  | "routedModel"
>

export interface TurnWriterOptions {
  conversationId: string
  /** The assistant message to write into (runs). Absent → created on the
   *  first output frame (`/v1/chat`). */
  placeholder?: Message
  /** Runs resume: the message as the paused run left it. Its tool calls
   *  seed the buffer (as done) and a reset restores it. */
  base?: MessageBase
}

export interface TurnWriter {
  /** The placeholder, or `null` before the first output (`/v1/chat`). */
  readonly placeholder: Message | null
  /** No output frame arrived yet (`/v1/chat`'s "empty response"). */
  readonly firstChunk: boolean
  readonly toolCalls: LiveToolCall[]
  readonly reasoningStart: number | null
  readonly reasoningLast: number | null
  /** `/v1/chat`: the `error` frame, when one ended the stream. */
  readonly streamError: { code?: string; message?: string } | null
  /** `/v1/chat`: the server flagged this turn (`memory_tainted`). */
  readonly memoryTainted: boolean
  ensurePlaceholder(): Message
  /** Apply one frame; `"stop"` for the frames that end a `/v1/chat`
   *  stream (`error`, `done`). */
  handleFrame(parsed: NormalisedFrame): "continue" | "stop"
  /** Runs `reset`: clear the message's output (then restore `base`). */
  clear(): void
}

/** A persisted tool call as a finished live pill. */
export function liveFromRecord(t: ToolCallRecord): LiveToolCall {
  return {
    id: t.id,
    name: t.name,
    argsLabel: t.argsLabel,
    summary: t.summary,
    ...(t.results ? { results: t.results } : {}),
    status: "done",
  }
}

/** The output fields of `message` — the `base` of a run continuing it. */
export function messageBaseOf(message: Message): MessageBase {
  return {
    content: message.content,
    reasoning: message.reasoning,
    toolCalls: message.toolCalls,
    generatedImages: message.generatedImages,
    generatedFiles: message.generatedFiles,
    codeResults: message.codeResults,
    uiParts: message.uiParts,
    mcpApps: message.mcpApps,
    routedModel: message.routedModel,
  }
}

export function createTurnWriter(
  deps: TurnWriterDeps,
  opts: TurnWriterOptions,
): TurnWriter {
  const {
    addMessage,
    setConversationTyping,
    appendToMessage,
    appendToMessageReasoning,
    appendMessageGeneratedImages,
    appendMessageGeneratedFiles,
    appendMessageCodeResult,
    appendMessageUiPart,
    appendMessageMcpApp,
    setMessageSuggestions,
    setMessageVerification,
    setMessageRoutedModel,
    createArtifact,
    setLiveToolCalls,
  } = deps
  const targetConvId = opts.conversationId
  let placeholder: Message | null = opts.placeholder ?? null
  let firstChunk = true
  // Reasoning duration capture: first/last chunk timestamps so we
  // can persist the elapsed ms on the message at stream end.
  let reasoningStart: number | null = null
  let reasoningLast: number | null = null
  // Tool-call buffer for this stream. Accumulated locally (and
  // mirrored into `liveToolCalls` for the pills) so the end-of-stream
  // flush persists what actually happened — React state captured at
  // send start never sees the placeholder created mid-stream.
  const seed = (): LiveToolCall[] => (opts.base?.toolCalls ?? []).map(liveFromRecord)
  let toolCalls: LiveToolCall[] = seed()
  let streamError: { code?: string; message?: string } | null = null
  // Server-flagged: this turn read third-party content, so memory
  // auto-extraction must skip it (see `memory_tainted` below).
  let memoryTainted = false
  // Generated images / files whose artifacts exist already (a reset
  // re-applies their frames).
  const knownGeneratedIds = new Set<string>()

  // Placeholder created on the first event of any kind so
  // reasoning-first models still show typing UI disappearing as soon
  // as any output arrives.
  const ensurePlaceholder = (): Message => {
    if (placeholder) {
      if (firstChunk) {
        setConversationTyping(targetConvId, false)
        firstChunk = false
      }
      return placeholder
    }
    setConversationTyping(targetConvId, false)
    placeholder = addMessage({ role: "assistant", content: "" }, targetConvId)
    firstChunk = false
    return placeholder
  }

  const handleFrame = (parsed: NormalisedFrame): "continue" | "stop" => {
    if (parsed.type === "text" && typeof parsed.value === "string") {
      const p = ensurePlaceholder()
      appendToMessage(p.id, parsed.value)
    } else if (
      parsed.type === "reasoning" &&
      typeof parsed.value === "string"
    ) {
      const p = ensurePlaceholder()
      const now = Date.now()
      if (reasoningStart === null) reasoningStart = now
      reasoningLast = now
      appendToMessageReasoning(p.id, parsed.value)
    } else if (
      parsed.type === "tool_call" &&
      parsed.id &&
      parsed.name
    ) {
      const p = ensurePlaceholder()
      toolCalls = startToolCall(toolCalls, {
        id: parsed.id,
        name: parsed.name,
        args: parsed.args,
      })
      const snapshot = toolCalls
      setLiveToolCalls((prev) => ({ ...prev, [p.id]: snapshot }))
    } else if (parsed.type === "tool_result" && parsed.id) {
      const ph = placeholder as Message | null
      if (ph) {
        toolCalls = finishToolCall(toolCalls, {
          id: parsed.id,
          summary: parsed.summary,
          results: parsed.results,
        })
        const snapshot = toolCalls
        setLiveToolCalls((prev) => ({ ...prev, [ph.id]: snapshot }))
      }
    } else if (
      parsed.type === "tool_image" &&
      Array.isArray(parsed.images)
    ) {
      // generateImage produced images; the server pre-persisted
      // each URL to a durable form so the message survives reload.
      const ph = placeholder as Message | null
      if (ph) {
        const mode: "t2i" | "i2i" =
          parsed.mode === "i2i" ? "i2i" : "t2i"
        const images = (
          parsed.images as Array<Record<string, unknown>>
        )
          .filter(
            (img): img is {
              id: string
              url: string
              storagePath?: string
              width: number
              height: number
              format: string
              prompt: string
              mode: "t2i" | "i2i"
            } =>
              typeof img?.id === "string" &&
              typeof img?.url === "string" &&
              typeof img?.width === "number" &&
              typeof img?.height === "number" &&
              typeof img?.format === "string" &&
              typeof img?.prompt === "string" &&
              (img.storagePath === undefined ||
                typeof img.storagePath === "string")
          )
          .map((img) => ({ ...img, mode }))
        if (images.length > 0) {
          appendMessageGeneratedImages(ph.id, images)
          images.forEach((img) => {
            if (knownGeneratedIds.has(img.id)) return
            createArtifact({
              conversationId: targetConvId,
              messageId: ph.id,
              kind: "image",
              title: img.prompt
                ? img.prompt.slice(0, 80).trim()
                : `Generated image`,
              // Prompt as text content (small). The image lives
              // in storagePath: a signed URL as-is, or — for an
              // inline data: URL — an `hb-blob:` reference to the
              // message item's IndexedDB record, so the bytes are
              // stored once, not copied onto the artifact (v34).
              content: img.prompt ?? "",
              storagePath: artifactStoragePathFor(ph.id, img),
            })
          })
        }
      }
    } else if (
      parsed.type === "tool_file" &&
      Array.isArray(parsed.files)
    ) {
      const ph = placeholder as Message | null
      if (ph) {
        const files = (parsed.files as Array<Record<string, unknown>>)
          .filter(
            (f): f is {
              id: string
              name: string
              sizeBytes: number
              mimeType: string
              url: string
              storagePath?: string
            } =>
              typeof f?.id === "string" &&
              typeof f?.name === "string" &&
              typeof f?.sizeBytes === "number" &&
              typeof f?.mimeType === "string" &&
              typeof f?.url === "string" &&
              (f.storagePath === undefined ||
                typeof f.storagePath === "string")
          )
          .map((f) => ({
            id: f.id,
            name: f.name,
            sizeBytes: f.sizeBytes,
            mimeType: f.mimeType,
            url: f.url,
            storagePath: f.storagePath ?? null,
          }))
        if (files.length > 0) {
          appendMessageGeneratedFiles(ph.id, files)
          files.forEach((f) => {
            if (knownGeneratedIds.has(f.id)) return
            createArtifact({
              conversationId: targetConvId,
              messageId: ph.id,
              kind: "file",
              title: f.name,
              content: "",
              // Mirrors the image path: a signed URL as-is, or a
              // reference to the message item's bytes.
              storagePath: artifactStoragePathFor(ph.id, f),
            })
          })
        }
      }
    } else if (
      parsed.type === "suggestions" &&
      Array.isArray(parsed.values)
    ) {
      const ph = placeholder as Message | null
      if (ph) {
        setMessageSuggestions(ph.id, parsed.values)
      }
    } else if (
      parsed.type === "verification" &&
      parsed.verification
    ) {
      // Citation verification — stamp the per-claim verdicts +
      // confidence summary onto the message. See
      // PLAN-citation-verifiability.md.
      const ph = placeholder as Message | null
      if (ph) setMessageVerification(ph.id, parsed.verification)
    } else if (
      parsed.type === "routed_model" &&
      typeof parsed.value === "string"
    ) {
      // Smart-routing transparency — stamp the resolved model so
      // the bubble shows "Auto → <label>".
      const ph = placeholder as Message | null
      if (ph) setMessageRoutedModel(ph.id, parsed.value)
    } else if (
      parsed.type === "mcp_app" &&
      typeof parsed.id === "string" &&
      typeof parsed.serverId === "string" &&
      typeof parsed.html === "string"
    ) {
      // MCP App panel — append to the message for a sandboxed
      // iframe render. See PLAN-mcp-apps.md.
      const ph = placeholder as Message | null
      if (ph) {
        appendMessageMcpApp(ph.id, {
          id: parsed.id,
          serverId: parsed.serverId,
          html: parsed.html,
          // Phase 3 — optional on the wire; included so the
          // refresh button + truncation stub work.
          ...(parsed.resourceUri
            ? { resourceUri: parsed.resourceUri }
            : {}),
          ...(parsed.truncated ? { truncated: true } : {}),
        })
      }
    } else if (parsed.type === "code_result") {
      // Code-interpreter result — append stdout/stderr + inline
      // text/table cells to the message. Images produced by code
      // arrive separately via `tool_image` (the gallery). See
      // docs/superpowers/plans/2026-06-19-code-interpreter-microsandbox.md.
      const ph = placeholder as Message | null
      if (ph) {
        appendMessageCodeResult(ph.id, {
          id: parsed.id ?? "",
          stdout: parsed.stdout ?? "",
          stderr: parsed.stderr ?? "",
          results: parsed.codeCells ?? [],
        })
      }
    } else if (parsed.type === "ui_part") {
      // Generative-UI part — server validated via the `renderUI`
      // tool's execute; we re-validate defensively via
      // `parsePersistedUiPart` so a malformed in-flight payload
      // from a future server version can't crash the renderer.
      const ph = placeholder as Message | null
      if (ph && typeof parsed.id === "string" && parsed.kind) {
        const persisted = parsePersistedUiPart({
          id: parsed.id,
          kind: parsed.kind,
          props: parsed.props,
        })
        if (persisted) {
          appendMessageUiPart(ph.id, persisted)
        }
      }
    } else if (parsed.type === "error") {
      streamError = { code: parsed.code, message: parsed.message }
      return "stop"
    } else if (parsed.type === "memory_tainted") {
      memoryTainted = true
    } else if (parsed.type === "done") {
      return "stop"
    }
    return "continue"
  }

  const restoreBase = (id: string, base: MessageBase) => {
    if (base.content) appendToMessage(id, base.content)
    if (base.reasoning) appendToMessageReasoning(id, base.reasoning)
    if (base.toolCalls?.length) deps.setMessageToolCalls(id, base.toolCalls)
    if (base.generatedImages?.length) appendMessageGeneratedImages(id, base.generatedImages)
    if (base.generatedFiles?.length) appendMessageGeneratedFiles(id, base.generatedFiles)
    for (const part of base.codeResults ?? []) appendMessageCodeResult(id, part)
    for (const part of base.uiParts ?? []) appendMessageUiPart(id, part)
    for (const part of base.mcpApps ?? []) appendMessageMcpApp(id, part)
    if (base.routedModel) setMessageRoutedModel(id, base.routedModel)
  }

  const clear = () => {
    const ph = placeholder as Message | null
    if (!ph) return
    const current = deps.getMessage?.(ph.id)
    for (const img of current?.generatedImages ?? []) knownGeneratedIds.add(img.id)
    for (const f of current?.generatedFiles ?? []) knownGeneratedIds.add(f.id)
    deps.clearMessageOutput?.(ph.id)
    if (opts.base) restoreBase(ph.id, opts.base)
    toolCalls = seed()
    reasoningStart = null
    reasoningLast = null
    setLiveToolCalls((prev) => {
      if (!(ph.id in prev)) return prev
      const next = { ...prev }
      delete next[ph.id]
      return next
    })
  }

  return {
    get placeholder() {
      return placeholder
    },
    get firstChunk() {
      return firstChunk
    },
    get toolCalls() {
      return toolCalls
    },
    get reasoningStart() {
      return reasoningStart
    },
    get reasoningLast() {
      return reasoningLast
    },
    get streamError() {
      return streamError
    },
    get memoryTainted() {
      return memoryTainted
    },
    ensurePlaceholder,
    handleFrame,
    clear,
  }
}
