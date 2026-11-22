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
 *   the composed system prompt, skills, workspace, reasoning effort, the
 *   0.4.0 options (research mode, the MCP allow-list, `attachments` by
 *   reference, the memory opt-out, citation checks, the I2I reference,
 *   `localFilesOnly`, the local MCP servers), plus anything the caller adds
 *   (e.g. `requireApprovalFor`). Booleans go only when true (absent means
 *   false). `mode` is left out: absent means interactive.
 * - `state` — only `hummingbird.localMcp`: the local MCP servers'
 *   credentials (Q45), never in `forwardedProps`. agent-py never stores
 *   them, so a resume must send them again (`localMcpCredentialsOf`).
 * - `threadId` — the conversation (`threadIdFor`), `runId` — freshly
 *   minted unless given (reuse it to retry idempotently).
 *
 * Pure.
 */

import type { ReasoningEffort } from "@/shared/reasoning-effort"
import { mintRunId, threadIdFor } from "@/shared/runs/ids"
import type { Message } from "@/shared/types"

import type {
  AgUiMessage,
  LocalMcpCredentials,
  LocalMcpServer,
  RunAttachment,
  RunForwardedProps,
  RunReferenceImage,
  SkillConfig,
  StartRunRequest,
} from "./types"

/** The `RunAgentInput.state` key holding local MCP credentials (Q45). */
export const LOCAL_MCP_STATE_KEY = "hummingbird.localMcp"

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
  /** Text documents for the newest user message. Chat sends its attached
   *  files as `attachments` instead (`runAttachmentsFor`, rendered into
   *  the system prompt under one budget, as the Next route does). */
  documents?: readonly RunDocument[]
  /** The chat's reasoning tier (`chatReasoningEffort`); the backend
   *  ignores it for a model that takes none. */
  reasoningEffort?: ReasoningEffort
  // --- contract 0.4.0 (the Phase 3 catch-up; agent-py acts on them in wave 5b)
  /** Research mode (Q46). */
  research?: boolean
  /** The MCP servers the run may use (Q48); `[]` = none, absent = all. */
  allowedMcpServerIds?: readonly string[]
  /** Files (cloud ones by id), bookmarks and MCP resources (Q44) —
   *  `runAttachmentsFor` (`attachments.ts`). */
  attachments?: readonly RunAttachment[]
  /** The conversation's memory opt-out (`Conversation.memoryOff`). */
  memoryBypass?: boolean
  /** The account's citation-check toggle. */
  verifyCitations?: boolean
  /** The I2I reference of this turn (an image's Remix action). */
  referenceImage?: RunReferenceImage
  /** The account's "store files locally" preference. */
  localFilesOnly?: boolean
  /** Local-mode MCP servers with their cached tools, no credentials. 5b-D. */
  localMcpServers?: readonly LocalMcpServer[]
  /** Their credentials, by server id — sent in `state` only, never kept
   *  anywhere but the in-flight request. 5b-D. */
  localMcpCredentials?: LocalMcpCredentials
}

/** One attached file's extracted text (`UploadedFile.extractedText`). */
export interface RunDocument {
  /** The file name — the document's title for the model. */
  name: string
  text: string
  /** `UploadedFile.extractionTruncated`: the model is told the text was cut. */
  truncated?: boolean
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

/** The local MCP credentials a request carries in `state` — what a resume
 *  re-sends (agent-py keeps none, Q45). */
export function localMcpCredentialsOf(body: Pick<StartRunRequest, "state">): LocalMcpCredentials | undefined {
  const state: unknown = body.state
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined
  const creds = (state as Record<string, unknown>)[LOCAL_MCP_STATE_KEY]
  return creds && typeof creds === "object" && !Array.isArray(creds) ? (creds as LocalMcpCredentials) : undefined
}

export function buildRunInput(input: ChatRunInput): StartRunRequest {
  const forwardedProps: RunForwardedProps = { ...(input.forwardedProps ?? {}) }
  if (input.model) forwardedProps.model = input.model
  if (input.systemPrompt) forwardedProps.systemPrompt = input.systemPrompt
  if (input.skills && input.skills.length > 0) forwardedProps.skills = [...input.skills]
  if (input.workspaceId) forwardedProps.workspaceId = input.workspaceId
  if (input.reasoningEffort) forwardedProps.reasoningEffort = input.reasoningEffort
  if (input.research) forwardedProps.research = true
  if (input.allowedMcpServerIds) forwardedProps.allowedMcpServerIds = [...input.allowedMcpServerIds]
  if (input.attachments && input.attachments.length > 0) forwardedProps.attachments = [...input.attachments]
  if (input.memoryBypass) forwardedProps.memoryBypass = true
  if (input.verifyCitations) forwardedProps.verifyCitations = true
  if (input.referenceImage) forwardedProps.referenceImage = { url: input.referenceImage.url }
  if (input.localFilesOnly) forwardedProps.localFilesOnly = true
  if (input.localMcpServers && input.localMcpServers.length > 0) {
    forwardedProps.localMcpServers = [...input.localMcpServers]
  }
  const creds = input.localMcpCredentials
  const state = creds && Object.keys(creds).length > 0 ? { [LOCAL_MCP_STATE_KEY]: { ...creds } } : undefined
  return {
    threadId: threadIdFor(input.conversationId),
    runId: input.runId ?? mintRunId(),
    messages: toRunMessages(input.history, {
      images: input.images,
      documents: input.documents,
    }) as StartRunRequest["messages"],
    ...(state ? { state } : {}),
    ...(Object.keys(forwardedProps).length > 0 ? { forwardedProps } : {}),
  }
}
