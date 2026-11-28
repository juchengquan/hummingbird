"use client"
import "client-only"

/**
 * Pure helpers used by `lib/client/hooks/use-store.ts`. Lifted out so
 * the store file can focus on state shape + mutators, and so these
 * pieces are unit-testable without instantiating Zustand.
 *
 * Everything in here is referentially transparent (input → output)
 * except `tombstoneMcpServer` which uses `new Date()` — that's
 * intentional and matches how the in-store tombstone helper behaves.
 */

import { uuid } from "@/shared/uuid"

import type { FileSearchConfig } from "@/shared/skills/file-search-config"
import type { ImageGenConfig } from "@/shared/skills/image-gen-config"
import type { WebFetchConfig } from "@/shared/skills/web-fetch-config"
import type { WebSearchConfig } from "@/shared/skills/web-search-config"
import type { Agent, Conversation, McpServer, Message, Prompt } from "@/shared/types"

// --- sidebar widths --------------------------------------------------------

export const SIDEBAR_WIDTH_MIN = 160
export const SIDEBAR_WIDTH_MAX = 480
export const SIDEBAR_WIDTH_DEFAULT = 256
export const RESOURCES_SIDEBAR_WIDTH_MIN = 200
export const RESOURCES_SIDEBAR_WIDTH_MAX = 400
export const RESOURCES_SIDEBAR_WIDTH_DEFAULT = 272

export function clampSidebarWidth(n: number): number {
  if (!Number.isFinite(n)) return SIDEBAR_WIDTH_DEFAULT
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(n)))
}

export function clampResourcesSidebarWidth(n: number): number {
  if (!Number.isFinite(n)) return RESOURCES_SIDEBAR_WIDTH_DEFAULT
  return Math.max(
    RESOURCES_SIDEBAR_WIDTH_MIN,
    Math.min(RESOURCES_SIDEBAR_WIDTH_MAX, Math.round(n))
  )
}

// --- prompt slugs ----------------------------------------------------------

/**
 * Slugify a prompt name for the `/<slug>` slash trigger. Lowercase,
 * non-alphanumerics collapsed to single dashes, leading/trailing dashes
 * trimmed. Empty input → "prompt" (createPrompt layers collision
 * handling on top via `ensureUniquePromptSlug`).
 */
export function defaultSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "prompt"
}

/**
 * Append `-2`, `-3`, … to `base` until the slug is unique within the
 * caller's prompt list. `excludePromptId` lets updatePrompt re-check
 * its own slug without colliding with itself. Tombstoned prompts
 * (`deletedAt` set) don't count.
 */
export function ensureUniquePromptSlug(
  base: string,
  prompts: Prompt[],
  excludePromptId?: string
): string {
  const taken = new Set(
    prompts
      .filter((p) => p.id !== excludePromptId && !p.deletedAt)
      .map((p) => p.slug)
  )
  if (!taken.has(base)) return base
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  // Pathological fallback — every numeric suffix taken. Append a random
  // tail to escape. Shouldn't happen in any sane library.
  return `${base}-${uuid().slice(0, 6)}`
}

/** Mirror of `ensureUniquePromptSlug` for personas
 *  (`PLAN-custom-agents.md`). The schema enforces uniqueness per
 *  (workspace, slug) where `deleted_at is null`, so this helper checks
 *  against the workspace's non-tombstoned personas only. */
export function ensureUniqueAgentSlug(
  base: string,
  agents: Agent[],
  excludeAgentId?: string
): string {
  const taken = new Set(
    agents
      .filter((a) => a.id !== excludeAgentId && !a.deletedAt)
      .map((a) => a.slug)
  )
  if (!taken.has(base)) return base
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${uuid().slice(0, 6)}`
}

// --- mcp server tombstone --------------------------------------------------

/**
 * Tombstone an `McpServer`: mark it deleted and drop the cached
 * `capabilities` blob (which can be large after a discovery). The
 * stub keeps id / workspaceId / name / transport / createdAt so any
 * historical message that referenced an MCP tool from this server
 * resolves to a "🗑 GitHub MCP (removed)" label.
 */
export function tombstoneMcpServer(server: McpServer): McpServer {
  return {
    id: server.id,
    workspaceId: server.workspaceId,
    name: server.name,
    url: server.url,
    transport: server.transport,
    credentialMode: server.credentialMode,
    enabled: false,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    deletedAt: new Date(),
  }
}

// --- skill config merges ---------------------------------------------------
// Shape: each `merge*` takes the previous config + a Partial patch and
// returns a new config with the patch applied. Leaves and sub-objects
// whose value is `undefined` get dropped, so a "reset" flow can remove
// the override; an empty result returns `undefined` so the next
// cascade level takes over cleanly.

export function mergeWebFetchConfig(
  base: WebFetchConfig | undefined,
  patch: Partial<WebFetchConfig>
): WebFetchConfig | undefined {
  const next: Record<string, unknown> = { ...(base ?? {}) }
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    const value = patch[key]
    if (value === undefined) delete next[key as string]
    else next[key as string] = value
  }
  if (Object.keys(next).length === 0) return undefined
  return next as WebFetchConfig
}

export function mergeImageGenConfig(
  base: ImageGenConfig | undefined,
  patch: Partial<ImageGenConfig>
): ImageGenConfig | undefined {
  const next: Record<string, unknown> = { ...(base ?? {}) }
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    const value = patch[key]
    if (value === undefined) delete next[key as string]
    else next[key as string] = value
  }
  if (Object.keys(next).length === 0) return undefined
  return next as ImageGenConfig
}

export function mergeFileSearchConfig(
  base: FileSearchConfig | undefined,
  patch: Partial<FileSearchConfig>
): FileSearchConfig | undefined {
  const next: Record<string, unknown> = { ...(base ?? {}) }
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    const value = patch[key]
    if (value === undefined) delete next[key as string]
    else next[key as string] = value
  }
  if (Object.keys(next).length === 0) return undefined
  return next as FileSearchConfig
}

export function mergeWebSearchConfig(
  base: WebSearchConfig | undefined,
  patch: Partial<WebSearchConfig>
): WebSearchConfig | undefined {
  const next: Record<string, unknown> = { ...(base ?? {}) }
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    const value = patch[key]
    if (value === undefined) {
      delete next[key as string]
      continue
    }
    if (key === "tavily" || key === "brave" || key === "exa") {
      // Sub-object merge: deep on the known provider sub-configs.
      const prior = (next[key as string] ?? {}) as Record<string, unknown>
      const merged: Record<string, unknown> = { ...prior }
      for (const [subKey, subValue] of Object.entries(
        value as Record<string, unknown>
      )) {
        if (subValue === undefined) delete merged[subKey]
        else merged[subKey] = subValue
      }
      if (Object.keys(merged).length === 0) delete next[key as string]
      else next[key as string] = merged
    } else {
      next[key as string] = value
    }
  }
  if (Object.keys(next).length === 0) return undefined
  return next as WebSearchConfig
}

// --- messages reducer ------------------------------------------------------

/**
 * Apply `patch` to the message identified by `messageId` across every
 * conversation in `state.conversations`. Returns a `Partial<S>` that
 * can be returned from a Zustand `set` updater.
 *
 * INVARIANT: searches ALL conversations, not just the active one.
 * Message ids are uuids and uniquely identify the owning conversation.
 * Filtering on `activeConversationId` here would misfire whenever the
 * user has switched tabs since the message was created — particularly
 * during parallel streams.
 *
 * No-op when no message matches: returns `{}` so Zustand skips the
 * re-render. Identity-preserving when the patch produces a value-equal
 * message (the conversation reference is unchanged).
 */
export function updateMessage<S extends { conversations: Conversation[] }>(
  state: S,
  messageId: string,
  patch: (m: Message) => Message
): Partial<S> {
  let touched = false
  const conversations = state.conversations.map((c) => {
    if (!c.messages.some((m) => m.id === messageId)) return c
    const nextMessages = c.messages.map((m) =>
      m.id === messageId ? patch(m) : m
    )
    if (nextMessages.every((m, i) => m === c.messages[i])) {
      return c
    }
    touched = true
    return { ...c, messages: nextMessages }
  })
  if (!touched) return {}
  return { conversations } as Partial<S>
}

/**
 * Remove the message identified by `messageId` from whichever
 * conversation owns it. Returns a `Partial<S>` with `conversations`
 * updated, or `{}` when no message matches.
 *
 * Mirrors `updateMessage`'s invariants: searches ALL conversations,
 * identity-preserving no-op when the message is not found.
 */
export function removeMessage<S extends { conversations: Conversation[] }>(
  state: S,
  messageId: string
): Partial<S> {
  let touched = false
  const conversations = state.conversations.map((c) => {
    if (!c.messages.some((m) => m.id === messageId)) return c
    touched = true
    return { ...c, messages: c.messages.filter((m) => m.id !== messageId) }
  })
  if (!touched) return {}
  return { conversations } as Partial<S>
}
