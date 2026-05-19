"use client"

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
 * - Deletes for child entities (messages of a deleted conversation, etc.)
 *   are NOT emitted — Postgres ON DELETE CASCADE handles them via the
 *   foreign keys defined in migration 0001/0002.
 */

import type {
  Artifact,
  Conversation,
  Message,
  Note,
  Resource,
  UploadedFile,
  Workspace,
} from "@/lib/types"
import type { SyncOp } from "@/lib/sync/sync-queue"

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
   * upserts (huge volume, no value). Pass the active conversation id
   * when `isTyping === true` so we hold off on its message diff until
   * the stream ends.
   */
  options: { streamingConversationId?: string | null } = {}
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
          document_content: c.documentContent,
          document_updated_at: toISO(c.updatedAt),
          skill_prefs: c.skillPrefs ?? {},
          parent_id: c.parentId ?? null,
          forked_from_message_id: c.forkedFromMessageId ?? null,
          created_at: toISO(c.createdAt),
          updated_at: toISO(c.updatedAt),
        },
      })
    }

    // Diff messages on this conversation, skipping the one that's
    // currently streaming.
    const skipMessages = options.streamingConversationId === c.id
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
    a.documentContent === b.documentContent &&
    sameStringArray(a.selectedFileIds, b.selectedFileIds) &&
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
    sameInstant(a.uploadedAt, b.uploadedAt)
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

// ------------ notes ---------------------------------------------------------

export function diffNotes(prev: Note[], next: Note[]): SyncOp[] {
  const ops: SyncOp[] = []
  const prevById = byId(prev)
  const nextById = byId(next)

  for (const n of next) {
    // Skip orphaned workspace-level notes — the cloud schema still
    // requires `conversation_id`. Locally they remain visible.
    if (n.conversationId === null) continue
    const before = prevById.get(n.id)
    if (!before || !noteEquals(before, n)) {
      ops.push({
        kind: "upsert",
        target: "notes",
        clientOpId: "",
        row: {
          id: n.id,
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
    // Skip orphaned workspace-level artifacts — the cloud schema still
    // requires `conversation_id`.
    if (a.conversationId === null) continue
    const before = prevById.get(a.id)
    if (!before || !artifactEquals(before, a)) {
      ops.push({
        kind: "upsert",
        target: "artifacts",
        clientOpId: "",
        row: {
          id: a.id,
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

// ------------ helpers -------------------------------------------------------

function byId<T extends { id: string }>(arr: T[]): Map<string, T> {
  const m = new Map<string, T>()
  for (const x of arr) m.set(x.id, x)
  return m
}

function toISO(d: Date | string): string {
  if (typeof d === "string") return d
  return d.toISOString()
}

function sameInstant(a: Date | string, b: Date | string): boolean {
  return new Date(a).getTime() === new Date(b).getTime()
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
