"use client"
import "client-only"

/**
 * Wire-shape conversion for `POST /v1/chat` on agent-py + agent-ts.
 *
 * The TS frontend's `ChatRequestInput` is fatter than what the agent
 * services accept (it carries attachments, MCP server defs,
 * referenceImage, etc.). This module narrows that body to the subset
 * both services share byte-for-byte: messages + model + optional
 * system + workspace_id + skills[] + enable_tools.
 *
 * Lives in `lib/client/api/` so it can be unit-tested without pulling
 * in the rest of `api-client.ts` (which imports the Zustand store
 * indirectly via the dispatch resolver).
 */

import type { ChatRequestInput } from "@/shared/api-schemas"

/** Narrow the TS-shaped chat request body to what the agent services'
 *  `/v1/chat` endpoint accepts. Attachments / MCP / referenceImage are
 *  dropped silently — both services use permissive parsing, but
 *  trimming client-side keeps the payload small and the intent
 *  explicit. */
export function narrowToRemoteBody(
  body: ChatRequestInput,
): Record<string, unknown> {
  // Coerce each message's content to a plain string. The TS schema
  // allows structured content parts; the remote services accept only
  // `string`. We pull the joined text for compatibility — keeps the
  // first slice viable until both services grow multimodal support.
  const messages = body.messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string" ? m.content : flattenTextParts(m.content),
  }))
  const out: Record<string, unknown> = {
    model: body.model ?? "",
    messages,
  }
  if (body.workspaceSystemPrompt) {
    out.system = body.workspaceSystemPrompt
  }
  if (body.workspaceId) {
    // Unlocks `searchFiles` + cloud-mode MCP tools on the remote
    // services. Without it those tools register but are no-op.
    out.workspace_id = body.workspaceId
  }
  if (body.skills && body.skills.length > 0) {
    // Per-skill config (caps + provider toggles). The remote services
    // honour the same `{id, webSearchConfig?, imageGenConfig?,
    // webFetchConfig?}` entries the Next.js inline route consumes.
    out.skills = body.skills
    // `enable_tools` mirrors agent-py's opt-in flag for the tool loop.
    // When skills are sent + the user has them enabled, default to on
    // so the experience matches the inline Next.js route.
    out.enable_tools = true
  }
  return out
}

/** Pull plain text out of an AI SDK structured-content array, joining
 *  every `text` part. Non-text parts (image / file / tool) are skipped.
 *  String input passes through unchanged. */
export function flattenTextParts(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      "type" in part &&
      (part as { type: string }).type === "text"
    ) {
      const text = (part as { text?: unknown }).text
      if (typeof text === "string") parts.push(text)
    }
  }
  return parts.join("")
}
