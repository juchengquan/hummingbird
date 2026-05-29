"use client"
import "client-only"

/**
 * Snapshot diff → SyncOp[] producers. One function per entity.
 *
 * Each function takes (prev, next) snapshots of the relevant Zustand
 * slice and emits the SyncOps needed to bring the cloud row(s) in line
 * with `next`. Pure: no IO, no `user_id` injection (the queue does that).
 *
 * Important constraints encoded here:
 * - Messages live as `Message[]` on `Conversation`. We diff per conversation
 *   so each emitted op is scoped correctly.
 * - We do NOT push runtime-only fields that have no DB column (see the
 *   notes in `lib/supabase/types.ts`): error / reasoning / attachedFileIds /
 *   suggestions on messages; extraction state / image data URLs / summary /
 *   keyTopics on files; systemPrompt on workspaces. These stay local.
 *   (`generatedImages` IS synced now via the `messages.generated_images`
 *   JSONB column added in migration 0010 — see the upsert payload below.)
 * - Deletes for child entities (messages of a deleted conversation, etc.)
 *   are NOT emitted — Postgres ON DELETE CASCADE handles them via the
 *   foreign keys defined in migration 0001/0002.
 */

import type {
  Artifact,
  Conversation,
  ConversationFile,
  ConversationMcpResource,
  ConversationUrlBookmark,
  Document,
  McpResource,
  McpResourceBinding,
  McpServer,
  Message,
  Note,
  Prompt,
  Resource,
  UploadedFile,
  UrlBookmark,
  Workspace,
} from "@/shared/types"
import type { SyncOp } from "@/client/sync/sync-queue"
import type { Json } from "@/shared/supabase/types"
import { toISO } from "@/shared/utils"

// ------------ workspaces ----------------------------------------------------

export function diffWorkspaces(prev: Workspace[], next: Workspace[]): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const w of next) {
    const before = prevById.get(w.id)
    if (!before || !workspaceEquals(before, w)) {
      ops.push({
        kind: "upsert",
        target: "workspaces",
        clientOpId: "", // filled by queue
        row: {
          id: w.id,
          name: w.name,
          system_prompt: w.systemPrompt ?? null,
          skill_prefs: w.skillPrefs ?? {},
          default_model: w.defaultModel ?? null,
          position: w.position ?? null,
          is_project: w.isProject ?? false,
          goal: w.goal ?? null,
          milestones: w.milestones ?? null,
          created_at: toISO(w.createdAt),
          updated_at: toISO(w.updatedAt),
        },
      })
    }
  }
  for (const w of prev) {
    if (!nextById.has(w.id)) {
      ops.push({
        kind: "delete",
        target: "workspaces",
        clientOpId: "",
        where: { column: "id", value: w.id },
      })
    }
  }
  return ops
}

function workspaceEquals(a: Workspace, b: Workspace): boolean {
  return (
    a.name === b.name &&
    (a.systemPrompt ?? null) === (b.systemPrompt ?? null) &&
    sameSkillPrefs(a.skillPrefs, b.skillPrefs) &&
    (a.defaultModel ?? null) === (b.defaultModel ?? null) &&
    (a.position ?? null) === (b.position ?? null) &&
    (a.isProject ?? false) === (b.isProject ?? false) &&
    (a.goal ?? null) === (b.goal ?? null) &&
    JSON.stringify(a.milestones ?? null) === JSON.stringify(b.milestones ?? null) &&
    sameInstant(a.createdAt, b.createdAt) &&
    sameInstant(a.updatedAt, b.updatedAt)
  )
}

// ------------ documents -----------------------------------------------------

export function diffDocuments(prev: Document[], next: Document[]): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const d of next) {
    const before = prevById.get(d.id)
    if (!before || !documentEquals(before, d)) {
      ops.push({
        kind: "upsert",
        target: "documents",
        clientOpId: "",
        row: {
          id: d.id,
          workspace_id: d.workspaceId,
          title: d.title,
          content: d.content,
          position: d.position ?? null,
          created_at: toISO(d.createdAt),
          updated_at: toISO(d.updatedAt),
        },
      })
    }
  }
  for (const d of prev) {
    if (!nextById.has(d.id)) {
      ops.push({
        kind: "delete",
        target: "documents",
        clientOpId: "",
        where: { column: "id", value: d.id },
      })
    }
  }
  return ops
}

function documentEquals(a: Document, b: Document): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.title === b.title &&
    a.content === b.content &&
    (a.position ?? null) === (b.position ?? null) &&
    sameInstant(a.createdAt, b.createdAt) &&
    sameInstant(a.updatedAt, b.updatedAt)
  )
}

function sameSkillPrefs(
  a: Record<string, boolean> | undefined,
  b: Record<string, boolean> | undefined
): boolean {
  const ak = Object.keys(a ?? {})
  const bk = Object.keys(b ?? {})
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if ((a as Record<string, boolean>)[k] !== (b as Record<string, boolean> | undefined)?.[k]) {
      return false
    }
  }
  return true
}

// ------------ conversations + their messages --------------------------------

export function diffConversations(
  prev: Conversation[],
  next: Conversation[],
  /**
   * When a message is currently streaming we skip per-chunk message
   * upserts (huge volume, no value). Pass the set of conversation ids
   * currently mid-stream so their message diffs are held off until
   * each stream ends.
   */
  options: { streamingConversationIds?: ReadonlySet<string> } = {}
): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const c of next) {
    const before = prevById.get(c.id)
    if (!before || !conversationHeaderEquals(before, c)) {
      ops.push({
        kind: "upsert",
        target: "conversations",
        clientOpId: "",
        row: {
          id: c.id,
          workspace_id: c.workspaceId,
          title: c.title,
          pinned: c.pinned,
          selected_file_ids: c.selectedFileIds,
          selected_mcp_resource_ids: c.selectedMcpResourceIds ?? [],
          selected_url_bookmark_ids: c.selectedUrlBookmarkIds ?? [],
          // document_content / document_updated_at were promoted to the
          // workspaces row. Column still exists for one release for
          // safety; client no longer writes to it.
          skill_prefs: c.skillPrefs ?? {},
          parent_id: c.parentId ?? null,
          forked_from_message_id: c.forkedFromMessageId ?? null,
          created_at: toISO(c.createdAt),
          updated_at: toISO(c.updatedAt),
        },
      })
    }

    // Diff messages on this conversation, skipping ones that are
    // currently streaming.
    const skipMessages = options.streamingConversationIds?.has(c.id) ?? false
    if (!skipMessages) {
      ops.push(...diffMessages(c.id, before?.messages ?? [], c.messages))
    }
  }

  for (const c of prev) {
    if (!nextById.has(c.id)) {
      ops.push({
        kind: "delete",
        target: "conversations",
        clientOpId: "",
        where: { column: "id", value: c.id },
      })
      // Postgres cascades messages/artifacts/notes.
    }
  }
  return ops
}

function conversationHeaderEquals(a: Conversation, b: Conversation): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.title === b.title &&
    a.pinned === b.pinned &&
    sameStringArray(a.selectedFileIds, b.selectedFileIds) &&
    sameStringArray(
      a.selectedMcpResourceIds ?? [],
      b.selectedMcpResourceIds ?? []
    ) &&
    sameStringArray(
      a.selectedUrlBookmarkIds ?? [],
      b.selectedUrlBookmarkIds ?? []
    ) &&
    sameSkillPrefs(a.skillPrefs, b.skillPrefs) &&
    (a.parentId ?? null) === (b.parentId ?? null) &&
    (a.forkedFromMessageId ?? null) === (b.forkedFromMessageId ?? null) &&
    sameInstant(a.createdAt, b.createdAt) &&
    sameInstant(a.updatedAt, b.updatedAt)
  )
}

// ------------ messages (called from diffConversations) ----------------------

function diffMessages(
  conversationId: string,
  prev: Message[],
  next: Message[]
): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  next.forEach((m, idx) => {
    const before = prevById.get(m.id)
    if (!before || !messageEquals(before, m) || idx !== prev.findIndex((p) => p.id === m.id)) {
      ops.push({
        kind: "upsert",
        target: "messages",
        clientOpId: "",
        row: {
          id: m.id,
          conversation_id: conversationId,
          role: m.role,
          content: m.content,
          position: idx,
          reasoning: m.reasoning ?? null,
          reasoning_duration_ms: m.reasoningDurationMs ?? null,
          // MessageError is a structured object; store as JSONB (null when absent).
          error: m.error ?? null,
          // Same JSONB shape for tool_calls — array of small records.
          tool_calls: m.toolCalls ?? null,
          attached_file_ids: m.attachedFileIds ?? [],
          suggestions: m.suggestions ?? [],
          compressed: m.compressed ?? false,
          kind: m.kind ?? null,
          recap_message_ids: m.recapMessageIds ?? [],
          // JSONB: array of {id, url, storagePath?, width, height, format,
          // prompt, mode}. Null when no images on this message — keeps the
          // common case at zero JSON bytes on the wire.
          generated_images:
            m.generatedImages && m.generatedImages.length > 0
              ? (m.generatedImages as unknown as Json)
              : null,
          created_at: toISO(m.timestamp),
        },
      })
    }
  })

  for (const m of prev) {
    if (!nextById.has(m.id)) {
      ops.push({
        kind: "delete",
        target: "messages",
        clientOpId: "",
        where: { column: "id", value: m.id },
      })
    }
  }
  return ops
}

function messageEquals(a: Message, b: Message): boolean {
  return (
    a.role === b.role &&
    a.content === b.content &&
    (a.reasoning ?? null) === (b.reasoning ?? null) &&
    (a.reasoningDurationMs ?? null) === (b.reasoningDurationMs ?? null) &&
    JSON.stringify(a.error ?? null) === JSON.stringify(b.error ?? null) &&
    JSON.stringify(a.toolCalls ?? null) === JSON.stringify(b.toolCalls ?? null) &&
    sameStringArray(a.attachedFileIds ?? [], b.attachedFileIds ?? []) &&
    sameStringArray(a.suggestions ?? [], b.suggestions ?? []) &&
    (a.compressed ?? false) === (b.compressed ?? false) &&
    (a.kind ?? null) === (b.kind ?? null) &&
    sameStringArray(a.recapMessageIds ?? [], b.recapMessageIds ?? []) &&
    // Same JSON.stringify trick as `error` / `toolCalls`. Generated
    // images are small (tens of bytes per entry on the wire — the URL
    // is the heaviest field) and only present on a fraction of
    // messages, so this is cheaper than a deep recursive walk.
    JSON.stringify(a.generatedImages ?? null) ===
      JSON.stringify(b.generatedImages ?? null) &&
    sameInstant(a.timestamp, b.timestamp)
  )
}

// ------------ files ---------------------------------------------------------

export function diffFiles(prev: UploadedFile[], next: UploadedFile[]): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const f of next) {
    const before = prevById.get(f.id)
    if (!before || !fileEquals(before, f)) {
      // Only include `storage_path` when we actually have one on the
      // store — omitting the key keeps the upsert from null-overwriting
      // a value the row already has in the DB (e.g. set by another
      // device or by an earlier upload). `external_url` follows the
      // same rule and is currently only touched by UploadThing paths
      // outside this diff.
      const row: Record<string, unknown> = {
        id: f.id,
        name: f.name,
        size: f.size,
        type: f.type,
        extraction_status: f.extractionStatus ?? null,
        extracted_text: f.extractedText ?? null,
        extraction_truncated: f.extractionTruncated ?? false,
        extracted_kind: f.extractedKind ?? null,
        image_data_url: f.imageDataUrl ?? null,
        summary: f.summary ?? null,
        key_topics: f.keyTopics ?? [],
        uploaded_at: toISO(f.uploadedAt),
        // `null` = live; ISO string = tombstoned. Always explicit so a
        // file that was tombstoned and then later untombstoned (e.g.
        // by another device) round-trips cleanly.
        deleted_at: f.deletedAt ? toISO(f.deletedAt) : null,
      }
      if (f.storagePath) row.storage_path = f.storagePath
      ops.push({
        kind: "upsert",
        target: "files",
        clientOpId: "",
        row,
      })
    }
  }
  for (const f of prev) {
    if (!nextById.has(f.id)) {
      ops.push({
        kind: "delete",
        target: "files",
        clientOpId: "",
        where: { column: "id", value: f.id },
      })
    }
  }
  return ops
}

function fileEquals(a: UploadedFile, b: UploadedFile): boolean {
  return (
    a.name === b.name &&
    a.size === b.size &&
    a.type === b.type &&
    (a.extractionStatus ?? null) === (b.extractionStatus ?? null) &&
    (a.extractedText ?? null) === (b.extractedText ?? null) &&
    (a.extractionTruncated ?? false) === (b.extractionTruncated ?? false) &&
    (a.extractedKind ?? null) === (b.extractedKind ?? null) &&
    (a.imageDataUrl ?? null) === (b.imageDataUrl ?? null) &&
    (a.summary ?? null) === (b.summary ?? null) &&
    sameStringArray(a.keyTopics ?? [], b.keyTopics ?? []) &&
    (a.storagePath ?? null) === (b.storagePath ?? null) &&
    sameInstant(a.uploadedAt, b.uploadedAt) &&
    sameInstantOrNull(a.deletedAt, b.deletedAt)
  )
}

// ------------ resources -----------------------------------------------------

export function diffResources(prev: Resource[], next: Resource[]): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const r of next) {
    const before = prevById.get(r.id)
    if (!before || !resourceEquals(before, r)) {
      ops.push({
        kind: "upsert",
        target: "resources",
        clientOpId: "",
        row: {
          id: r.id,
          workspace_id: r.workspaceId,
          file_id: r.fileId,
          added_at: toISO(r.addedAt),
        },
      })
    }
  }
  for (const r of prev) {
    if (!nextById.has(r.id)) {
      ops.push({
        kind: "delete",
        target: "resources",
        clientOpId: "",
        where: { column: "id", value: r.id },
      })
    }
  }
  return ops
}

function resourceEquals(a: Resource, b: Resource): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.fileId === b.fileId &&
    sameInstant(a.addedAt, b.addedAt)
  )
}

// ------------ conversation_files --------------------------------------------

export function diffConversationFiles(
  prev: ConversationFile[],
  next: ConversationFile[]
): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const cf of next) {
    const before = prevById.get(cf.id)
    if (!before || !conversationFileEquals(before, cf)) {
      ops.push({
        kind: "upsert",
        target: "conversation_files",
        clientOpId: "",
        row: {
          id: cf.id,
          conversation_id: cf.conversationId,
          file_id: cf.fileId,
          added_at: toISO(cf.addedAt),
        },
      })
    }
  }
  for (const cf of prev) {
    if (!nextById.has(cf.id)) {
      ops.push({
        kind: "delete",
        target: "conversation_files",
        clientOpId: "",
        where: { column: "id", value: cf.id },
      })
    }
  }
  return ops
}

function conversationFileEquals(a: ConversationFile, b: ConversationFile): boolean {
  return (
    a.conversationId === b.conversationId &&
    a.fileId === b.fileId &&
    sameInstant(a.addedAt, b.addedAt)
  )
}

// ------------ mcp_servers ---------------------------------------------------

/**
 * Diff MCP server configs. Important: `credentials_encrypted` is owned
 * by the dedicated `/api/mcp/server` route, NOT by this diff path.
 * Cloud-mode servers reach Supabase initially via that route; from
 * then on the sync layer pushes only metadata updates (name, URL,
 * enabled, capabilities, deletedAt).
 *
 * For local-mode servers, sync pushes the row with `credentials_encrypted=NULL`
 * and the `credential_fingerprint` so other devices can detect when
 * they have the same cred (without sharing it).
 */
export function diffMcpServers(prev: McpServer[], next: McpServer[]): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const s of next) {
    const before = prevById.get(s.id)
    if (!before || !mcpServerEquals(before, s)) {
      // Upsert metadata only — credential ciphertext is managed via
      // the dedicated route. Omitting the column from the upsert
      // means existing ciphertext is preserved.
      ops.push({
        kind: "upsert",
        target: "mcp_servers",
        clientOpId: "",
        row: {
          id: s.id,
          workspace_id: s.workspaceId,
          name: s.name,
          url: s.url,
          transport: s.transport,
          credential_mode: s.credentialMode,
          credential_fingerprint:
            s.credentialMode === "local" ? s.credentialFingerprint ?? null : null,
          capabilities: s.capabilities ?? null,
          capabilities_fetched_at: s.capabilitiesFetchedAt
            ? toISO(s.capabilitiesFetchedAt)
            : null,
          enabled: s.enabled,
          created_at: toISO(s.createdAt),
          updated_at: toISO(s.updatedAt),
          deleted_at: s.deletedAt ? toISO(s.deletedAt) : null,
        },
      })
    }
  }
  for (const s of prev) {
    if (!nextById.has(s.id)) {
      ops.push({
        kind: "delete",
        target: "mcp_servers",
        clientOpId: "",
        where: { column: "id", value: s.id },
      })
    }
  }
  return ops
}

function mcpServerEquals(a: McpServer, b: McpServer): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.name === b.name &&
    a.url === b.url &&
    a.transport === b.transport &&
    a.credentialMode === b.credentialMode &&
    (a.credentialFingerprint ?? null) === (b.credentialFingerprint ?? null) &&
    JSON.stringify(a.capabilities ?? null) === JSON.stringify(b.capabilities ?? null) &&
    sameInstantOrNull(a.capabilitiesFetchedAt, b.capabilitiesFetchedAt) &&
    a.enabled === b.enabled &&
    sameInstant(a.createdAt, b.createdAt) &&
    sameInstant(a.updatedAt, b.updatedAt) &&
    sameInstantOrNull(a.deletedAt, b.deletedAt)
  )
}

// ------------ mcp_resources -------------------------------------------------

export function diffMcpResources(prev: McpResource[], next: McpResource[]): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const r of next) {
    const before = prevById.get(r.id)
    if (!before || !mcpResourceEquals(before, r)) {
      ops.push({
        kind: "upsert",
        target: "mcp_resources",
        clientOpId: "",
        row: {
          id: r.id,
          workspace_id: r.workspaceId,
          server_id: r.serverId,
          uri: r.uri,
          name: r.name,
          description: r.description ?? null,
          mime_type: r.mimeType ?? null,
          added_at: toISO(r.addedAt),
          deleted_at: r.deletedAt ? toISO(r.deletedAt) : null,
        },
      })
    }
  }
  for (const r of prev) {
    if (!nextById.has(r.id)) {
      ops.push({
        kind: "delete",
        target: "mcp_resources",
        clientOpId: "",
        where: { column: "id", value: r.id },
      })
    }
  }
  return ops
}

function mcpResourceEquals(a: McpResource, b: McpResource): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.serverId === b.serverId &&
    a.uri === b.uri &&
    a.name === b.name &&
    (a.description ?? null) === (b.description ?? null) &&
    (a.mimeType ?? null) === (b.mimeType ?? null) &&
    sameInstant(a.addedAt, b.addedAt) &&
    sameInstantOrNull(a.deletedAt, b.deletedAt)
  )
}

// ------------ mcp_resource_bindings -----------------------------------------

export function diffMcpResourceBindings(
  prev: McpResourceBinding[],
  next: McpResourceBinding[]
): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const b of next) {
    const before = prevById.get(b.id)
    if (!before || !mcpResourceBindingEquals(before, b)) {
      ops.push({
        kind: "upsert",
        target: "mcp_resource_bindings",
        clientOpId: "",
        row: {
          id: b.id,
          workspace_id: b.workspaceId,
          resource_id: b.resourceId,
          added_at: toISO(b.addedAt),
        },
      })
    }
  }
  for (const b of prev) {
    if (!nextById.has(b.id)) {
      ops.push({
        kind: "delete",
        target: "mcp_resource_bindings",
        clientOpId: "",
        where: { column: "id", value: b.id },
      })
    }
  }
  return ops
}

function mcpResourceBindingEquals(a: McpResourceBinding, b: McpResourceBinding): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.resourceId === b.resourceId &&
    sameInstant(a.addedAt, b.addedAt)
  )
}

// ------------ conversation_mcp_resources ------------------------------------

export function diffConversationMcpResources(
  prev: ConversationMcpResource[],
  next: ConversationMcpResource[]
): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const cmr of next) {
    const before = prevById.get(cmr.id)
    if (!before || !conversationMcpResourceEquals(before, cmr)) {
      ops.push({
        kind: "upsert",
        target: "conversation_mcp_resources",
        clientOpId: "",
        row: {
          id: cmr.id,
          conversation_id: cmr.conversationId,
          resource_id: cmr.resourceId,
          added_at: toISO(cmr.addedAt),
        },
      })
    }
  }
  for (const cmr of prev) {
    if (!nextById.has(cmr.id)) {
      ops.push({
        kind: "delete",
        target: "conversation_mcp_resources",
        clientOpId: "",
        where: { column: "id", value: cmr.id },
      })
    }
  }
  return ops
}

function conversationMcpResourceEquals(
  a: ConversationMcpResource,
  b: ConversationMcpResource
): boolean {
  return (
    a.conversationId === b.conversationId &&
    a.resourceId === b.resourceId &&
    sameInstant(a.addedAt, b.addedAt)
  )
}

// ------------ url_bookmarks -------------------------------------------------

export function diffUrlBookmarks(
  prev: UrlBookmark[],
  next: UrlBookmark[]
): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const b of next) {
    const before = prevById.get(b.id)
    if (!before || !urlBookmarkEquals(before, b)) {
      ops.push({
        kind: "upsert",
        target: "url_bookmarks",
        clientOpId: "",
        row: {
          id: b.id,
          workspace_id: b.workspaceId,
          url: b.url,
          title: b.title,
          content: b.content,
          content_truncated: b.contentTruncated,
          content_hash: b.contentHash,
          description: b.description ?? null,
          favicon_url: b.faviconUrl ?? null,
          fetched_at: toISO(b.fetchedAt),
          deleted_at: b.deletedAt ? toISO(b.deletedAt) : null,
          created_at: toISO(b.createdAt),
          updated_at: toISO(b.updatedAt),
        },
      })
    }
  }
  for (const b of prev) {
    if (!nextById.has(b.id)) {
      ops.push({
        kind: "delete",
        target: "url_bookmarks",
        clientOpId: "",
        where: { column: "id", value: b.id },
      })
    }
  }
  return ops
}

function urlBookmarkEquals(a: UrlBookmark, b: UrlBookmark): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.url === b.url &&
    a.title === b.title &&
    a.content === b.content &&
    a.contentTruncated === b.contentTruncated &&
    a.contentHash === b.contentHash &&
    (a.description ?? null) === (b.description ?? null) &&
    (a.faviconUrl ?? null) === (b.faviconUrl ?? null) &&
    sameInstant(a.fetchedAt, b.fetchedAt) &&
    sameInstantOrNull(a.deletedAt, b.deletedAt) &&
    sameInstant(a.createdAt, b.createdAt) &&
    sameInstant(a.updatedAt, b.updatedAt)
  )
}

// ------------ conversation_url_bookmarks ------------------------------------

export function diffConversationUrlBookmarks(
  prev: ConversationUrlBookmark[],
  next: ConversationUrlBookmark[]
): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const cub of next) {
    const before = prevById.get(cub.id)
    if (!before || !conversationUrlBookmarkEquals(before, cub)) {
      ops.push({
        kind: "upsert",
        target: "conversation_url_bookmarks",
        clientOpId: "",
        row: {
          id: cub.id,
          conversation_id: cub.conversationId,
          bookmark_id: cub.bookmarkId,
          added_at: toISO(cub.addedAt),
        },
      })
    }
  }
  for (const cub of prev) {
    if (!nextById.has(cub.id)) {
      ops.push({
        kind: "delete",
        target: "conversation_url_bookmarks",
        clientOpId: "",
        where: { column: "id", value: cub.id },
      })
    }
  }
  return ops
}

function conversationUrlBookmarkEquals(
  a: ConversationUrlBookmark,
  b: ConversationUrlBookmark
): boolean {
  return (
    a.conversationId === b.conversationId &&
    a.bookmarkId === b.bookmarkId &&
    sameInstant(a.addedAt, b.addedAt)
  )
}

// ------------ notes ---------------------------------------------------------

export function diffNotes(prev: Note[], next: Note[]): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const n of next) {
    const before = prevById.get(n.id)
    if (!before || !noteEquals(before, n)) {
      ops.push({
        kind: "upsert",
        target: "notes",
        clientOpId: "",
        row: {
          id: n.id,
          workspace_id: n.workspaceId,
          conversation_id: n.conversationId,
          message_id: n.messageId,
          body: n.body,
          created_at: toISO(n.createdAt),
          updated_at: toISO(n.updatedAt),
        },
      })
    }
  }
  for (const n of prev) {
    if (!nextById.has(n.id)) {
      ops.push({
        kind: "delete",
        target: "notes",
        clientOpId: "",
        where: { column: "id", value: n.id },
      })
    }
  }
  return ops
}

function noteEquals(a: Note, b: Note): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.conversationId === b.conversationId &&
    a.messageId === b.messageId &&
    a.body === b.body &&
    sameInstant(a.createdAt, b.createdAt) &&
    sameInstant(a.updatedAt, b.updatedAt)
  )
}

// ------------ artifacts -----------------------------------------------------

export function diffArtifacts(prev: Artifact[], next: Artifact[]): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const a of next) {
    const before = prevById.get(a.id)
    if (!before || !artifactEquals(before, a)) {
      ops.push({
        kind: "upsert",
        target: "artifacts",
        clientOpId: "",
        row: {
          id: a.id,
          workspace_id: a.workspaceId,
          conversation_id: a.conversationId,
          message_id: a.messageId,
          kind: a.kind,
          language: a.language,
          title: a.title,
          content: a.content,
          storage_path: a.storagePath,
          pinned: a.pinned,
          created_at: toISO(a.createdAt),
        },
      })
    }
  }
  for (const a of prev) {
    if (!nextById.has(a.id)) {
      ops.push({
        kind: "delete",
        target: "artifacts",
        clientOpId: "",
        where: { column: "id", value: a.id },
      })
    }
  }
  return ops
}

function artifactEquals(a: Artifact, b: Artifact): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.conversationId === b.conversationId &&
    a.messageId === b.messageId &&
    a.kind === b.kind &&
    a.language === b.language &&
    a.title === b.title &&
    a.content === b.content &&
    a.storagePath === b.storagePath &&
    a.pinned === b.pinned &&
    sameInstant(a.createdAt, b.createdAt)
  )
}

// ------------ prompts -------------------------------------------------------
//
// User-scoped prompt templates. Soft-delete via `deletedAt`: a
// "deleted" prompt becomes a tombstone on the row (deleted_at set);
// we never emit hard `delete` ops here. Restore is just flipping
// `deletedAt` back to null + bumping `updatedAt`, which round-trips
// through the upsert branch like any other field change.

export function diffPrompts(prev: Prompt[], next: Prompt[]): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const p of next) {
    const before = prevById.get(p.id)
    if (!before || !promptEquals(before, p)) {
      ops.push({
        kind: "upsert",
        target: "prompts",
        clientOpId: "",
        row: {
          id: p.id,
          workspace_id: p.workspaceId,
          name: p.name,
          slug: p.slug,
          template: p.template,
          variables: p.variables ?? [],
          created_at: toISO(p.createdAt),
          updated_at: toISO(p.updatedAt),
          deleted_at: p.deletedAt ? toISO(p.deletedAt) : null,
        },
      })
    }
  }
  // Hard delete only when the prompt disappears entirely from the
  // local array — should not happen during normal usage (soft-delete
  // is the user path), but accept it as a clean-up path so a
  // dev-time wipe doesn't leave orphaned cloud rows.
  for (const p of prev) {
    if (!nextById.has(p.id)) {
      ops.push({
        kind: "delete",
        target: "prompts",
        clientOpId: "",
        where: { column: "id", value: p.id },
      })
    }
  }
  return ops
}

function promptEquals(a: Prompt, b: Prompt): boolean {
  return (
    a.name === b.name &&
    a.slug === b.slug &&
    a.template === b.template &&
    sameStringArray(a.variables ?? [], b.variables ?? []) &&
    sameInstant(a.createdAt, b.createdAt) &&
    sameInstant(a.updatedAt, b.updatedAt) &&
    sameInstantOrNull(a.deletedAt, b.deletedAt)
  )
}

// ------------ helpers -------------------------------------------------------

function byId<T extends { id: string }>(arr: T[]): Map<string, T> {
  const m = new Map<string, T>()
  for (const x of arr) m.set(x.id, x)
  return m
}


function sameInstant(a: Date | string, b: Date | string): boolean {
  return new Date(a).getTime() === new Date(b).getTime()
}

function sameInstantOrNull(
  a: Date | string | null | undefined,
  b: Date | string | null | undefined
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return sameInstant(a, b)
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
