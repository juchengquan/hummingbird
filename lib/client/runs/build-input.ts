import "client-only"

/**
 * Build the AG-UI `RunAgentInput` of a chat turn on runs from today's chat
 * inputs (what `use-chat-send` already assembles for `/v1/chat`).
 *
 * - `messages` — the conversation history up to and including the new
 *   user message (Q15: the browser owns it), as text; no tool calls or
 *   activities. Compressed messages are dropped as
 *   `buildTransmittedMessages` does; empty assistant placeholders (an
 *   errored or stopped turn) carry nothing and are dropped too.
 * - **Attachments** (`images`, `documents`) ride on the newest message
 *   when it is the user's — like `buildTransmittedMessages`, which puts
 *   image URLs on the last user turn only — as AG-UI `document` / `image`
 *   parts before its text (`packages/contract/openapi.yaml`,
 *   `StartRunRequest`: limits, and `400 invalid_attachment` past them).
 *   A `data:…;base64,` image URL becomes a `data` source, anything else a
 *   `url` source (the backend accepts `https:` only); a document is the
 *   file's extracted text as a `text/plain` `data` source, its name in
 *   `metadata.name`.
 * - `forwardedProps` — Hummingbird's options (`RunForwardedProps`): model,
 *   the composed system prompt, skills, workspace, reasoning effort, plus
 *   anything the caller adds (e.g. `requireApprovalFor`). `mode` is left
 *   out: absent means interactive.
 * - `threadId` — the conversation (`threadIdFor`), `runId` — freshly
 *   minted unless given (reuse it to retry idempotently).
 *
 * Pure.
 */

import type { ReasoningEffort } from "@/shared/reasoning-effort"
import { mintRunId, threadIdFor } from "@/shared/runs/ids"
import type { Message, UploadedFile } from "@/shared/types"

import type { AgUiMessage, RunForwardedProps, SkillConfig, StartRunRequest } from "./types"

export interface ChatRunInput {
  /** The store conversation (its id becomes the thread). */
  conversationId: string
  /** History up to and including the new user message. */
  history: readonly Message[]
  /** Reuse to retry the same run idempotently; minted when absent. */
  runId?: string
  model?: string
  /** `workspaceSystemPrompt` as composed for `/v1/chat` today. */
  systemPrompt?: string
  skills?: readonly SkillConfig[]
  workspaceId?: string
  /** Any other `RunForwardedProps` (`requireApprovalFor`, `maxSteps`, …). */
  forwardedProps?: RunForwardedProps
  /** Images attached to this turn: the attached image files' data URLs
   *  (`getFileImageDataUrls(attachedImageFiles)`, as `/v1/chat` sends
   *  them) or `https:` URLs. */
  images?: readonly string[]
  /** Text documents attached to this turn — the inline-mode attached
   *  files' extracted text (RAG-mode files and files without text are not
   *  sent; the model reaches those through `searchFiles`). */
  documents?: readonly RunDocument[]
  /** The chat's reasoning tier (`chatReasoningEffort`); the backend
   *  ignores it for a model that takes none. */
  reasoningEffort?: ReasoningEffort
}

/** One attached file's extracted text (`UploadedFile.extractedText`). */
export interface RunDocument {
  /** The file name — the document's title for the model. */
  name: string
  text: string
  /** `UploadedFile.extractionTruncated`: the model is told the text was cut. */
  truncated?: boolean
}

/**
 * The turn's attached files as `RunDocument`s, the way `/v1/chat` builds
 * its file attachments (`use-chat-send`): an inline-mode file sends its
 * extracted text (and `truncated`); a RAG-mode file (`retrievalModes[id]
 * === "rag"`) and a file without extracted text send nothing — the model
 * reaches those through `searchFiles`.
 */
export function runDocumentsFor(
  files: readonly Pick<UploadedFile, "id" | "name" | "extractedText" | "extractionTruncated">[],
  retrievalModes: Readonly<Record<string, "rag">> = {},
): RunDocument[] {
  const out: RunDocument[] = []
  for (const f of files) {
    if (retrievalModes[f.id] === "rag" || !f.extractedText) continue
    out.push({ name: f.name, text: f.extractedText, ...(f.extractionTruncated ? { truncated: true } : {}) })
  }
  return out
}

/** What the newest user message carries besides its text. */
export interface RunAttachments {
  images?: readonly string[]
  documents?: readonly RunDocument[]
}

type ContentPart = Exclude<Extract<AgUiMessage, { role: "user" }>["content"], string>[number]

/** The history as AG-UI messages (text, ids kept), with `attachments` on
 *  the newest message when it is the user's. */
export function toRunMessages(
  history: readonly Message[],
  attachments: RunAttachments = {},
): AgUiMessage[] {
  const out: AgUiMessage[] = []
  for (const m of history) {
    if (m.compressed) continue
    if (m.role === "assistant" && !m.content) continue
    out.push(
      m.role === "user"
        ? { id: m.id, role: "user", content: m.content }
        : { id: m.id, role: "assistant", content: m.content },
    )
  }
  const last = out[out.length - 1]
  const parts = [
    ...(attachments.documents ?? []).map(documentPart),
    ...(attachments.images ?? []).map(imagePart),
  ]
  if (last?.role === "user" && parts.length > 0) {
    const text = typeof last.content === "string" ? last.content : ""
    out[out.length - 1] = {
      ...last,
      content: text ? [...parts, { type: "text", text }] : parts,
    }
  }
  return out
}

const DATA_URL = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/

function imagePart(url: string): ContentPart {
  const data = DATA_URL.exec(url)
  return data
    ? { type: "image", source: { type: "data", mimeType: data[1], value: data[2] } }
    : { type: "image", source: { type: "url", value: url } }
}

function documentPart(doc: RunDocument): ContentPart {
  return {
    type: "document",
    source: { type: "data", mimeType: "text/plain", value: utf8ToBase64(doc.text) },
    metadata: doc.truncated ? { name: doc.name, truncated: true } : { name: doc.name },
  }
}

/** Base64 of `text`'s UTF-8 bytes, chunked so a large document does not
 *  overflow the argument list of `String.fromCharCode`. */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function buildRunInput(input: ChatRunInput): StartRunRequest {
  const forwardedProps: RunForwardedProps = { ...(input.forwardedProps ?? {}) }
  if (input.model) forwardedProps.model = input.model
  if (input.systemPrompt) forwardedProps.systemPrompt = input.systemPrompt
  if (input.skills && input.skills.length > 0) forwardedProps.skills = [...input.skills]
  if (input.workspaceId) forwardedProps.workspaceId = input.workspaceId
  if (input.reasoningEffort) forwardedProps.reasoningEffort = input.reasoningEffort
  return {
    threadId: threadIdFor(input.conversationId),
    runId: input.runId ?? mintRunId(),
    messages: toRunMessages(input.history, {
      images: input.images,
      documents: input.documents,
    }) as StartRunRequest["messages"],
    ...(Object.keys(forwardedProps).length > 0 ? { forwardedProps } : {}),
  }
}
