"use client"

/**
 * First-sign-in reconciliation. Two halves:
 *  - `fetchCloudSnapshot` reads the user's full graph from Supabase and
 *    rehydrates it into the same shape the Zustand store uses.
 *  - `bulkUploadLocalState` does the inverse: ships the current local
 *    state up to Supabase under the new user_id, used when the cloud
 *    is empty.
 *
 * Decision flow lives in `lib/hooks/use-reconcile.ts`; this module is
 * pure data layer (no React, no UI).
 */

import type {
  Artifact,
  Conversation,
  FileExtractionStatus,
  Message,
  MessageError,
  Note,
  Resource,
  UploadedFile,
  Workspace,
} from "@/lib/types"
import type { AppSupabaseClient } from "@/lib/supabase/client"
import type { Json } from "@/lib/supabase/types"
import { useStore } from "@/lib/hooks/use-store"
import { setSyncSnapshot } from "@/lib/hooks/use-sync"

function jsonToSkillPrefs(value: Json | null | undefined): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "boolean") out[k] = v
  }
  return out
}

export interface CloudSnapshot {
  workspaces: Workspace[]
  conversations: Conversation[]
  files: UploadedFile[]
  resources: Resource[]
  notes: Note[]
  artifacts: Artifact[]
}

/** Returns null when there's a fetch error (caller decides whether to retry). */
export async function fetchCloudSnapshot(
  client: AppSupabaseClient,
  userId: string
): Promise<CloudSnapshot | null> {
  let workspacesRes, conversationsRes, messagesRes, filesRes, resourcesRes, notesRes, artifactsRes
  try {
    ;[
      workspacesRes,
      conversationsRes,
      messagesRes,
      filesRes,
      resourcesRes,
      notesRes,
      artifactsRes,
    ] = await Promise.all([
      client.from("workspaces").select("*").eq("user_id", userId),
      client.from("conversations").select("*").eq("user_id", userId),
      client
        .from("messages")
        .select("*")
        .eq("user_id", userId)
        .order("position", { ascending: true }),
      client.from("files").select("*").eq("user_id", userId),
      client.from("resources").select("*").eq("user_id", userId),
      client.from("notes").select("*").eq("user_id", userId),
      client.from("artifacts").select("*").eq("user_id", userId),
    ])
  } catch {
    return null
  }

  if (
    workspacesRes.error ||
    conversationsRes.error ||
    messagesRes.error ||
    filesRes.error ||
    resourcesRes.error ||
    notesRes.error ||
    artifactsRes.error
  ) {
    return null
  }

  try {
    const messagesByConv = new Map<string, Message[]>()
    for (const m of messagesRes.data ?? []) {
      const list = messagesByConv.get(m.conversation_id) ?? []
      const msg: Message = {
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: new Date(m.created_at),
      }
      if (m.reasoning) msg.reasoning = m.reasoning
      // DB column is JSONB; we store MessageError shape and cast back here.
      if (m.error) msg.error = m.error as unknown as MessageError
      if (m.attached_file_ids && m.attached_file_ids.length > 0) {
        msg.attachedFileIds = m.attached_file_ids
      }
      if (m.suggestions && m.suggestions.length > 0) {
        msg.suggestions = m.suggestions
      }
      list.push(msg)
      messagesByConv.set(m.conversation_id, list)
    }

    const workspaces: Workspace[] = (workspacesRes.data ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      systemPrompt: w.system_prompt ?? undefined,
      skillPrefs: jsonToSkillPrefs(w.skill_prefs),
      createdAt: new Date(w.created_at),
      updatedAt: new Date(w.updated_at),
    }))

    const conversations: Conversation[] = (conversationsRes.data ?? []).map((c) => ({
      id: c.id,
      workspaceId: c.workspace_id,
      title: c.title,
      messages: messagesByConv.get(c.id) ?? [],
      createdAt: new Date(c.created_at),
      updatedAt: new Date(c.updated_at),
      pinned: c.pinned,
      selectedFileIds: c.selected_file_ids ?? [],
      documentContent: c.document_content ?? "",
      skillPrefs: jsonToSkillPrefs(c.skill_prefs),
    }))

    const files: UploadedFile[] = (filesRes.data ?? []).map((f) => {
      const file: UploadedFile = {
        id: f.id,
        name: f.name,
        size: f.size,
        type: f.type,
        uploadedAt: new Date(f.uploaded_at),
      }
      if (f.extraction_status) {
        file.extractionStatus = f.extraction_status as FileExtractionStatus
      }
      if (f.extracted_text) file.extractedText = f.extracted_text
      if (f.extraction_truncated) file.extractionTruncated = f.extraction_truncated
      if (f.extracted_kind) file.extractedKind = f.extracted_kind
      if (f.image_data_url) file.imageDataUrl = f.image_data_url
      if (f.summary) file.summary = f.summary
      if (f.key_topics && f.key_topics.length > 0) {
        file.keyTopics = f.key_topics
      }
      return file
    })

    const resources: Resource[] = (resourcesRes.data ?? []).map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      fileId: r.file_id,
      addedAt: new Date(r.added_at),
    }))

    const notes: Note[] = (notesRes.data ?? []).map((n) => ({
      id: n.id,
      conversationId: n.conversation_id,
      messageId: n.message_id,
      body: n.body,
      createdAt: new Date(n.created_at),
      updatedAt: new Date(n.updated_at),
    }))

    const artifacts: Artifact[] = (artifactsRes.data ?? []).map((a) => ({
      id: a.id,
      conversationId: a.conversation_id,
      messageId: a.message_id,
      kind: a.kind,
      language: a.language,
      title: a.title ?? "",
      content: a.content ?? "",
      storagePath: a.storage_path,
      pinned: a.pinned,
      createdAt: new Date(a.created_at),
    }))

    return { workspaces, conversations, files, resources, notes, artifacts }
  } catch {
    return null
  }
}

/**
 * Ships the supplied local snapshot to Supabase under `userId`. Used
 * when the cloud is empty (first sign-in from a previously local-only
 * user).
 *
 * Order matters: workspaces → conversations → messages → files →
 * resources → notes → artifacts, so FK constraints hold. We use upsert
 * so retrying after a partial failure is safe.
 */
export async function bulkUploadLocalState(
  client: AppSupabaseClient,
  userId: string,
  snapshot: CloudSnapshot
): Promise<{ ok: boolean; error?: string }> {
  // workspaces
  if (snapshot.workspaces.length > 0) {
    const { error } = await client.from("workspaces").upsert(
      snapshot.workspaces.map((w) => ({
        id: w.id,
        user_id: userId,
        name: w.name,
        system_prompt: w.systemPrompt ?? null,
        skill_prefs: w.skillPrefs ?? {},
        created_at: w.createdAt.toISOString(),
        updated_at: w.updatedAt.toISOString(),
      }))
    )
    if (error) return { ok: false, error: `workspaces: ${error.message}` }
  }

  // conversations (no messages yet)
  if (snapshot.conversations.length > 0) {
    const { error } = await client.from("conversations").upsert(
      snapshot.conversations.map((c) => ({
        id: c.id,
        user_id: userId,
        workspace_id: c.workspaceId,
        title: c.title,
        pinned: c.pinned,
        selected_file_ids: c.selectedFileIds,
        document_content: c.documentContent,
        document_updated_at: c.updatedAt.toISOString(),
        skill_prefs: c.skillPrefs ?? {},
        created_at: c.createdAt.toISOString(),
        updated_at: c.updatedAt.toISOString(),
      }))
    )
    if (error) return { ok: false, error: `conversations: ${error.message}` }
  }

  // messages, flattened with their conversation_id + position. The
  // `error` JSONB column accepts the structured MessageError payload as-is.
  const messageRows: Array<{
    id: string
    user_id: string
    conversation_id: string
    role: "user" | "assistant"
    content: string
    position: number
    reasoning: string | null
    error: Json
    attached_file_ids: string[]
    suggestions: string[]
    created_at: string
  }> = []
  for (const c of snapshot.conversations) {
    c.messages.forEach((m, idx) => {
      messageRows.push({
        id: m.id,
        user_id: userId,
        conversation_id: c.id,
        role: m.role,
        content: m.content,
        position: idx,
        reasoning: m.reasoning ?? null,
        error: m.error ? (m.error as unknown as Json) : null,
        attached_file_ids: m.attachedFileIds ?? [],
        suggestions: m.suggestions ?? [],
        created_at: new Date(m.timestamp).toISOString(),
      })
    })
  }
  if (messageRows.length > 0) {
    const { error } = await client.from("messages").upsert(messageRows)
    if (error) return { ok: false, error: `messages: ${error.message}` }
  }

  // files (storage_path / external_url stay null at this stage; the
  // upload code path is responsible for filling them)
  if (snapshot.files.length > 0) {
    const { error } = await client.from("files").upsert(
      snapshot.files.map((f) => ({
        id: f.id,
        user_id: userId,
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
        uploaded_at: f.uploadedAt.toISOString(),
      }))
    )
    if (error) return { ok: false, error: `files: ${error.message}` }
  }

  // resources (depends on files + workspaces)
  if (snapshot.resources.length > 0) {
    const { error } = await client.from("resources").upsert(
      snapshot.resources.map((r) => ({
        id: r.id,
        user_id: userId,
        workspace_id: r.workspaceId,
        file_id: r.fileId,
        added_at: r.addedAt.toISOString(),
      }))
    )
    if (error) return { ok: false, error: `resources: ${error.message}` }
  }

  // notes
  if (snapshot.notes.length > 0) {
    const { error } = await client.from("notes").upsert(
      snapshot.notes.map((n) => ({
        id: n.id,
        user_id: userId,
        conversation_id: n.conversationId,
        message_id: n.messageId,
        body: n.body,
        created_at: n.createdAt.toISOString(),
        updated_at: n.updatedAt.toISOString(),
      }))
    )
    if (error) return { ok: false, error: `notes: ${error.message}` }
  }

  // artifacts
  if (snapshot.artifacts.length > 0) {
    const { error } = await client.from("artifacts").upsert(
      snapshot.artifacts.map((a) => ({
        id: a.id,
        user_id: userId,
        conversation_id: a.conversationId,
        message_id: a.messageId,
        kind: a.kind,
        language: a.language,
        title: a.title,
        content: a.content,
        storage_path: a.storagePath,
        pinned: a.pinned,
        created_at: a.createdAt.toISOString(),
      }))
    )
    if (error) return { ok: false, error: `artifacts: ${error.message}` }
  }

  return { ok: true }
}

/**
 * Replaces the Zustand store contents with `snapshot`. Picks a sensible
 * activeWorkspaceId / activeConversationId by recency so the UI lands
 * somewhere useful after a refresh-pull.
 *
 * Crucially, this seeds the sync layer's diff baseline BEFORE calling
 * setState, so `useSync`'s subscriber sees prev === next on the
 * synchronous notification and emits zero ops. No "re-upload everything
 * we just downloaded" storm.
 */
export function applyCloudSnapshot(snapshot: CloudSnapshot): void {
  const s = useStore.getState()
  const sortedWorkspaces = [...snapshot.workspaces].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
  )
  const activeWorkspaceId =
    sortedWorkspaces.find((w) => w.id === s.activeWorkspaceId)?.id ??
    sortedWorkspaces[0]?.id ??
    s.activeWorkspaceId

  const candidateConvs = snapshot.conversations.filter(
    (c) => c.workspaceId === activeWorkspaceId
  )
  const sortedConvs = candidateConvs.sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
  )
  const activeConversationId =
    sortedConvs.find((c) => c.id === s.activeConversationId)?.id ??
    sortedConvs[0]?.id ??
    null

  // Seed sync FIRST so the diff sees no change when setState fires.
  setSyncSnapshot({
    workspaces: snapshot.workspaces,
    conversations: snapshot.conversations,
    files: snapshot.files,
    resources: snapshot.resources,
    notes: snapshot.notes,
    artifacts: snapshot.artifacts,
  })

  useStore.setState({
    workspaces: snapshot.workspaces,
    conversations: snapshot.conversations,
    files: snapshot.files,
    resources: snapshot.resources,
    notes: snapshot.notes,
    artifacts: snapshot.artifacts,
    activeWorkspaceId,
    activeConversationId,
  })
}
