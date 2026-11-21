import "client-only"

/**
 * Build the AG-UI `RunAgentInput` of a chat turn on runs from today's chat
 * inputs (what `use-chat-send` already assembles for `/v1/chat`).
 *
 * - `messages` — the conversation history up to and including the new
 *   user message (Q15: the browser owns it). Text-only, exactly as the
 *   agent-py `/v1/chat` path sends it today (`narrowToRemoteBody`): no
 *   images, files, tool calls or activities (Q32 parity). Compressed
 *   messages are dropped as `buildTransmittedMessages` does; empty
 *   assistant placeholders (an errored or stopped turn) carry nothing and
 *   are dropped too.
 * - `forwardedProps` — Hummingbird's options (`RunForwardedProps`): model,
 *   the composed system prompt, skills, workspace, plus anything the
 *   caller adds (e.g. `requireApprovalFor`). `mode` is left out: absent
 *   means interactive.
 * - `threadId` — the conversation (`threadIdFor`), `runId` — freshly
 *   minted unless given (reuse it to retry idempotently).
 *
 * Pure.
 */

import { mintRunId, threadIdFor } from "@/shared/runs/ids"
import type { Message } from "@/shared/types"

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
}

/** The history as AG-UI messages (text-only, ids kept). */
export function toRunMessages(history: readonly Message[]): AgUiMessage[] {
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
  return out
}

export function buildRunInput(input: ChatRunInput): StartRunRequest {
  const forwardedProps: RunForwardedProps = { ...(input.forwardedProps ?? {}) }
  if (input.model) forwardedProps.model = input.model
  if (input.systemPrompt) forwardedProps.systemPrompt = input.systemPrompt
  if (input.skills && input.skills.length > 0) forwardedProps.skills = [...input.skills]
  if (input.workspaceId) forwardedProps.workspaceId = input.workspaceId
  return {
    threadId: threadIdFor(input.conversationId),
    runId: input.runId ?? mintRunId(),
    messages: toRunMessages(input.history) as StartRunRequest["messages"],
    ...(Object.keys(forwardedProps).length > 0 ? { forwardedProps } : {}),
  }
}
