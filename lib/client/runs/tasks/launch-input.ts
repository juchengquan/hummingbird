import "client-only"

/**
 * A task launch (`TaskRequestInput`, what every launch point builds) as
 * the body of a background `startRun` (Q71, RUN_EVENTS.md § 4.5). Pure.
 *
 * - `messages`: the transmitted history (`buildTransmittedMessages`), as
 *   AG-UI messages; the images attached to the newest user message go in
 *   it as `image` parts (Q49 corrected, Q71) — never as `attachments`,
 *   which a background run refuses.
 * - `forwardedProps`: `mode: "background"`, the model (already switched to
 *   one the worker runs, Q55), the composed system prompt, skills,
 *   workspace, step budget, `requireApprovalFor`, `research` (the
 *   `/research` mode), the persona's MCP allow-list (absent = no
 *   restriction, `[]` = none), `localFilesOnly`, and the task's title as
 *   its `goal`.
 * - Never: `attachments`, local MCP servers or their credentials (a
 *   background run refuses both, Q42/Q49), a reasoning tier.
 */

import type { TaskRequestInput } from "@/shared/api-schemas"
import { threadIdFor } from "@/shared/runs/ids"

import type { AgUiMessage, RunForwardedProps, StartRunRequest } from "../types"

type ContentPart = Exclude<Extract<AgUiMessage, { role: "user" }>["content"], string>[number]

const DATA_URL = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/

function imagePart(url: string): ContentPart {
  const data = DATA_URL.exec(url)
  return data
    ? { type: "image", source: { type: "data", mimeType: data[1], value: data[2] } }
    : { type: "image", source: { type: "url", value: url } }
}

/** `TaskRequestInput.messages` (AI SDK model messages) as AG-UI messages.
 *  Text parts are joined; image parts become `image` parts on a user
 *  message; tool messages and empty assistant turns are dropped. */
export function toTaskRunMessages(messages: TaskRequestInput["messages"], runId: string): AgUiMessage[] {
  const out: AgUiMessage[] = []
  messages.forEach((m, i) => {
    const id = `${runId}:m${i}`
    let text = ""
    const images: string[] = []
    if (typeof m.content === "string") text = m.content
    else {
      for (const part of m.content) {
        if (part.type === "text") text += (text ? "\n" : "") + part.text
        else if (part.type === "image") images.push(String(part.image))
      }
    }
    switch (m.role) {
      case "user":
        out.push(
          images.length > 0
            ? { id, role: "user", content: [...images.map(imagePart), ...(text ? [{ type: "text" as const, text }] : [])] }
            : { id, role: "user", content: text },
        )
        break
      case "assistant":
        if (text) out.push({ id, role: "assistant", content: text })
        break
      case "system":
        if (text) out.push({ id, role: "system", content: text })
        break
    }
  })
  return out
}

export interface BackgroundStartOptions {
  runId: string
  /** The model to run (`taskModelFor(input.model).model`). */
  model: string
  /** The task's title in the list (`goal`). */
  title?: string
  /** The account's "store files locally" preference, when the input
   *  doesn't carry one. */
  localFilesOnly?: boolean
}

/** The `POST /v1/runs` body of a new background task. */
export function backgroundStartBody(input: TaskRequestInput, opts: BackgroundStartOptions): StartRunRequest {
  const fp: RunForwardedProps = { mode: "background", model: opts.model }
  const title = opts.title?.trim()
  if (title) fp.goal = title.slice(0, 2000)
  if (input.workspaceSystemPrompt) fp.systemPrompt = input.workspaceSystemPrompt
  if (input.skills && input.skills.length > 0) fp.skills = [...input.skills] as RunForwardedProps["skills"]
  if (input.workspaceId) fp.workspaceId = input.workspaceId
  if (input.maxSteps) fp.maxSteps = input.maxSteps
  if (input.requireApprovalFor && input.requireApprovalFor.length > 0) {
    fp.requireApprovalFor = [...input.requireApprovalFor]
  }
  if (input.mode === "research") fp.research = true
  if (input.allowedMcpServerIds) fp.allowedMcpServerIds = [...input.allowedMcpServerIds]
  const localFilesOnly =
    (input as TaskRequestInput & { localFilesOnly?: boolean }).localFilesOnly ?? opts.localFilesOnly
  if (localFilesOnly) fp.localFilesOnly = true
  return {
    threadId: threadIdFor(input.conversationId),
    runId: opts.runId,
    messages: toTaskRunMessages(input.messages, opts.runId) as StartRunRequest["messages"],
    forwardedProps: fp,
  }
}
