"use client"
import "client-only"

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
  ConversationFile,
  ConversationMcpResource,
  ConversationUrlBookmark,
  Document,
  FileExtractionStatus,
  McpCapabilities,
  McpResource,
  McpResourceBinding,
  McpServer,
  Message,
  MessageError,
  Note,
  Resource,
  UploadedFile,
  UrlBookmark,
  Workspace,
} from "@/shared/types"
import type { AppSupabaseClient } from "@/client/supabase/client"
import type { Json } from "@/shared/supabase/types"
import { useStore } from "@/client/hooks/use-store"
import { setSyncSnapshot } from "@/client/hooks/use-sync"

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
  documents: Document[]
  conversations: Conversation[]
  files: UploadedFile[]
  resources: Resource[]
  conversationFiles: ConversationFile[]
  notes: Note[]
  artifacts: Artifact[]
  mcpServers: McpServer[]
  mcpResources: McpResource[]
  mcpResourceBindings: McpResourceBinding[]
  conversationMcpResources: ConversationMcpResource[]
  urlBookmarks: UrlBookmark[]
  conversationUrlBookmarks: ConversationUrlBookmark[]
}

/** Returns null when there's a fetch error (caller decides whether to retry). */
export async function fetchCloudSnapshot(
  client: AppSupabaseClient,
  userId: string
): Promise<CloudSnapshot | null> {
  let workspacesRes,
    documentsRes,
    conversationsRes,
    messagesRes,
    filesRes,
    resourcesRes,
    conversationFilesRes,
    notesRes,
    artifactsRes,
    mcpServersRes,
    mcpResourcesRes,
    mcpResourceBindingsRes,
    conversationMcpResourcesRes,
    urlBookmarksRes,
    conversationUrlBookmarksRes
  try {
    ;[
      workspacesRes,
      documentsRes,
      conversationsRes,
      messagesRes,
      filesRes,
      resourcesRes,
      conversationFilesRes,
      notesRes,
      artifactsRes,
      mcpServersRes,
      mcpResourcesRes,
      mcpResourceBindingsRes,
      conversationMcpResourcesRes,
      urlBookmarksRes,
      conversationUrlBookmarksRes,
    ] = await Promise.all([
      client.from("workspaces").select("*").eq("user_id", userId),
      client.from("documents").select("*").eq("user_id", userId),
      client.from("conversations").select("*").eq("user_id", userId),
      client
        .from("messages")
        .select("*")
        .eq("user_id", userId)
        .order("position", { ascending: true }),
      client.from("files").select("*").eq("user_id", userId),
      client.from("resources").select("*").eq("user_id", userId),
      client.from("conversation_files").select("*").eq("user_id", userId),
      client.from("notes").select("*").eq("user_id", userId),
      client.from("artifacts").select("*").eq("user_id", userId),
      // MCP: pull metadata only — `credentials_encrypted` stays on the
      // server. Cloud-mode servers come back without a `credentials`
      // field on the store; the chat / proxy routes decrypt on
      // demand.
      client
        .from("mcp_servers")
        .select(
          "id, user_id, workspace_id, name, url, transport, credential_mode, credential_fingerprint, capabilities, capabilities_fetched_at, enabled, created_at, updated_at, deleted_at"
        )
        .eq("user_id", userId),
      client.from("mcp_resources").select("*").eq("user_id", userId),
      client.from("mcp_resource_bindings").select("*").eq("user_id", userId),
      client
        .from("conversation_mcp_resources")
        .select("*")
        .eq("user_id", userId),
      client.from("url_bookmarks").select("*").eq("user_id", userId),
      client
        .from("conversation_url_bookmarks")
        .select("*")
        .eq("user_id", userId),
    ])
  } catch {
    return null
  }

  if (
    workspacesRes.error ||
    documentsRes.error ||
    conversationsRes.error ||
    messagesRes.error ||
    filesRes.error ||
    resourcesRes.error ||
    conversationFilesRes.error ||
    notesRes.error ||
    artifactsRes.error ||
    mcpServersRes.error ||
    mcpResourcesRes.error ||
    mcpResourceBindingsRes.error ||
    conversationMcpResourcesRes.error ||
    urlBookmarksRes.error ||
    conversationUrlBookmarksRes.error
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
      if (m.reasoning_duration_ms != null) msg.reasoningDurationMs = m.reasoning_duration_ms
      if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        msg.toolCalls = m.tool_calls as unknown as Message['toolCalls']
      }
      // DB column is JSONB; we store MessageError shape and cast back here.
      if (m.error) msg.error = m.error as unknown as MessageError
      if (m.attached_file_ids && m.attached_file_ids.length > 0) {
        msg.attachedFileIds = m.attached_file_ids
      }
      if (m.suggestions && m.suggestions.length > 0) {
        msg.suggestions = m.suggestions
      }
      if (m.compressed) msg.compressed = true
      if (m.kind === 'recap') msg.kind = 'recap'
      if (m.recap_message_ids && m.recap_message_ids.length > 0) {
        msg.recapMessageIds = m.recap_message_ids
      }
      list.push(msg)
      messagesByConv.set(m.conversation_id, list)
    }

    const workspaces: Workspace[] = (workspacesRes.data ?? [])
      .map((w) => ({
        id: w.id,
        name: w.name,
        systemPrompt: w.system_prompt ?? undefined,
        skillPrefs: jsonToSkillPrefs(w.skill_prefs),
        defaultModel: w.default_model ?? undefined,
        position: w.position ?? undefined,
        createdAt: new Date(w.created_at),
        updatedAt: new Date(w.updated_at),
      }))
      // Apply user-defined order. Workspaces without a position (legacy
      // rows before 0011) sort to the end by createdAt — a stable
      // fallback that doesn't get them lost in the list.
      .sort((a, b) => {
        const ap = a.position ?? Number.POSITIVE_INFINITY
        const bp = b.position ?? Number.POSITIVE_INFINITY
        if (ap !== bp) return ap - bp
        return a.createdAt.getTime() - b.createdAt.getTime()
      })

    const documents: Document[] = (documentsRes.data ?? []).map((d) => ({
      id: d.id,
      workspaceId: d.workspace_id,
      title: d.title,
      content: d.content ?? '',
      position: d.position ?? undefined,
      createdAt: new Date(d.created_at),
      updatedAt: new Date(d.updated_at),
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
      selectedMcpResourceIds:
        c.selected_mcp_resource_ids && c.selected_mcp_resource_ids.length > 0
          ? c.selected_mcp_resource_ids
          : undefined,
      selectedUrlBookmarkIds:
        c.selected_url_bookmark_ids && c.selected_url_bookmark_ids.length > 0
          ? c.selected_url_bookmark_ids
          : undefined,
      skillPrefs: jsonToSkillPrefs(c.skill_prefs),
      parentId: c.parent_id ?? undefined,
      forkedFromMessageId: c.forked_from_message_id ?? undefined,
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
      if (f.full_text) file.extractedFullText = f.full_text
      if (f.extracted_kind) file.extractedKind = f.extracted_kind
      if (f.image_data_url) file.imageDataUrl = f.image_data_url
      if (f.summary) file.summary = f.summary
      if (f.key_topics && f.key_topics.length > 0) {
        file.keyTopics = f.key_topics
      }
      // `deleted_at` column added in migration 0004. Older clients
      // never set it; pre-0004 rows have it null. Either way: nullish
      // → live file; non-null → tombstoned.
      const deletedAt = (f as { deleted_at?: string | null }).deleted_at
      if (deletedAt) file.deletedAt = new Date(deletedAt)
      return file
    })

    const resources: Resource[] = (resourcesRes.data ?? []).map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      fileId: r.file_id,
      addedAt: new Date(r.added_at),
    }))

    const conversationFiles: ConversationFile[] = (
      conversationFilesRes.data ?? []
    ).map((cf) => ({
      id: cf.id,
      conversationId: cf.conversation_id,
      fileId: cf.file_id,
      addedAt: new Date(cf.added_at),
    }))

    const mcpServers: McpServer[] = (mcpServersRes.data ?? []).map((s) => {
      const capabilities =
        s.capabilities && typeof s.capabilities === "object"
          ? (s.capabilities as McpCapabilities)
          : undefined
      const server: McpServer = {
        id: s.id,
        workspaceId: s.workspace_id,
        name: s.name,
        url: s.url,
        transport: s.transport,
        credentialMode: s.credential_mode,
        credentialFingerprint: s.credential_fingerprint ?? undefined,
        capabilities,
        capabilitiesFetchedAt: s.capabilities_fetched_at
          ? new Date(s.capabilities_fetched_at)
          : undefined,
        enabled: s.enabled,
        createdAt: new Date(s.created_at),
        updatedAt: new Date(s.updated_at),
      }
      if (s.deleted_at) server.deletedAt = new Date(s.deleted_at)
      return server
    })

    const mcpResources: McpResource[] = (mcpResourcesRes.data ?? []).map((r) => {
      const resource: McpResource = {
        id: r.id,
        workspaceId: r.workspace_id,
        serverId: r.server_id,
        uri: r.uri,
        name: r.name,
        description: r.description ?? undefined,
        mimeType: r.mime_type ?? undefined,
        addedAt: new Date(r.added_at),
      }
      if (r.deleted_at) resource.deletedAt = new Date(r.deleted_at)
      return resource
    })

    const mcpResourceBindings: McpResourceBinding[] = (
      mcpResourceBindingsRes.data ?? []
    ).map((b) => ({
      id: b.id,
      workspaceId: b.workspace_id,
      resourceId: b.resource_id,
      addedAt: new Date(b.added_at),
    }))

    const conversationMcpResources: ConversationMcpResource[] = (
      conversationMcpResourcesRes.data ?? []
    ).map((cmr) => ({
      id: cmr.id,
      conversationId: cmr.conversation_id,
      resourceId: cmr.resource_id,
      addedAt: new Date(cmr.added_at),
    }))

    const urlBookmarks: UrlBookmark[] = (urlBookmarksRes.data ?? []).map((b) => {
      const bookmark: UrlBookmark = {
        id: b.id,
        workspaceId: b.workspace_id,
        url: b.url,
        title: b.title,
        content: b.content ?? "",
        contentTruncated: b.content_truncated,
        contentHash: b.content_hash,
        description: b.description ?? undefined,
        faviconUrl: b.favicon_url ?? undefined,
        fetchedAt: new Date(b.fetched_at),
        createdAt: new Date(b.created_at),
        updatedAt: new Date(b.updated_at),
      }
      if (b.deleted_at) bookmark.deletedAt = new Date(b.deleted_at)
      return bookmark
    })

    const conversationUrlBookmarks: ConversationUrlBookmark[] = (
      conversationUrlBookmarksRes.data ?? []
    ).map((cub) => ({
      id: cub.id,
      conversationId: cub.conversation_id,
      bookmarkId: cub.bookmark_id,
      addedAt: new Date(cub.added_at),
    }))

    // Build a conversation → workspace map so we can backfill `workspaceId`
    // on notes/artifacts (the cloud schema still keys those by conversation).
    const convToWorkspace = new Map<string, string>()
    for (const c of conversations) convToWorkspace.set(c.id, c.workspaceId)
    const fallbackWorkspaceId = workspaces[0]?.id ?? ""

    // Prefer the direct `workspace_id` column added in migration 0011.
    // Fall back to the conversation-join lookup for rows written before
    // the migration's backfill (or by clients that haven't been updated
    // yet) so we don't lose them.
    const notes: Note[] = (notesRes.data ?? []).map((n) => ({
      id: n.id,
      workspaceId:
        n.workspace_id ??
        (n.conversation_id ? convToWorkspace.get(n.conversation_id) : undefined) ??
        fallbackWorkspaceId,
      conversationId: n.conversation_id,
      messageId: n.message_id,
      body: n.body,
      createdAt: new Date(n.created_at),
      updatedAt: new Date(n.updated_at),
    }))

    const artifacts: Artifact[] = (artifactsRes.data ?? []).map((a) => ({
      id: a.id,
      workspaceId:
        a.workspace_id ??
        (a.conversation_id ? convToWorkspace.get(a.conversation_id) : undefined) ??
        fallbackWorkspaceId,
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

    return {
      workspaces,
      documents,
      conversations,
      files,
      resources,
      conversationFiles,
      notes,
      artifacts,
      mcpServers,
      mcpResources,
      mcpResourceBindings,
      conversationMcpResources,
      urlBookmarks,
      conversationUrlBookmarks,
    }
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
      snapshot.workspaces.map((w, i) => ({
        id: w.id,
        user_id: userId,
        name: w.name,
        system_prompt: w.systemPrompt ?? null,
        skill_prefs: w.skillPrefs ?? {},
        default_model: w.defaultModel ?? null,
        // Fall back to array index when the local snapshot pre-dates
        // the explicit `position` field (v13 migration). Preserves the
        // user's current visible order on first cloud upload.
        position: w.position ?? i,
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
        // document_content / document_updated_at moved onto the workspaces
        // row. Column still exists for one release; client no longer
        // writes to it.
        skill_prefs: c.skillPrefs ?? {},
        parent_id: c.parentId ?? null,
        forked_from_message_id: c.forkedFromMessageId ?? null,
        created_at: c.createdAt.toISOString(),
        updated_at: c.updatedAt.toISOString(),
      }))
    )
    if (error) return { ok: false, error: `conversations: ${error.message}` }
  }

  // documents — workspace-scoped editor docs. FK requires the workspaces
  // rows above to already exist.
  if (snapshot.documents.length > 0) {
    const { error } = await client.from("documents").upsert(
      snapshot.documents.map((d) => ({
        id: d.id,
        user_id: userId,
        workspace_id: d.workspaceId,
        title: d.title,
        content: d.content,
        position: d.position ?? null,
        created_at: d.createdAt.toISOString(),
        updated_at: d.updatedAt.toISOString(),
      }))
    )
    if (error) return { ok: false, error: `documents: ${error.message}` }
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
    reasoning_duration_ms: number | null
    error: Json
    tool_calls: Json
    attached_file_ids: string[]
    suggestions: string[]
    compressed: boolean
    kind: string | null
    recap_message_ids: string[]
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
        reasoning_duration_ms: m.reasoningDurationMs ?? null,
        error: m.error ? (m.error as unknown as Json) : null,
        tool_calls: m.toolCalls ? (m.toolCalls as unknown as Json) : null,
        attached_file_ids: m.attachedFileIds ?? [],
        suggestions: m.suggestions ?? [],
        compressed: m.compressed ?? false,
        kind: m.kind ?? null,
        recap_message_ids: m.recapMessageIds ?? [],
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
        full_text: f.extractedFullText ?? null,
        extracted_kind: f.extractedKind ?? null,
        image_data_url: f.imageDataUrl ?? null,
        summary: f.summary ?? null,
        key_topics: f.keyTopics ?? [],
        uploaded_at: f.uploadedAt.toISOString(),
        deleted_at: f.deletedAt ? f.deletedAt.toISOString() : null,
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

  // conversation_files (depends on files + conversations) — the
  // conversation-private lane introduced in migration 0004. Existing
  // local-only users whose store predates v16 have an empty slice;
  // skip the upsert in that case to avoid an empty round-trip.
  if (snapshot.conversationFiles.length > 0) {
    const { error } = await client.from("conversation_files").upsert(
      snapshot.conversationFiles.map((cf) => ({
        id: cf.id,
        user_id: userId,
        conversation_id: cf.conversationId,
        file_id: cf.fileId,
        added_at: cf.addedAt.toISOString(),
      }))
    )
    if (error) return { ok: false, error: `conversation_files: ${error.message}` }
  }

  // mcp_servers — only local-mode rows reach this path; cloud-mode
  // rows can't exist locally when signed out (the UI disables the
  // radio) and when signed in they're written via the dedicated
  // /api/mcp/server route. We upload metadata with
  // `credentials_encrypted = NULL` and the local fingerprint so
  // other devices can detect "same cred" without sharing it.
  const localServers = snapshot.mcpServers.filter(
    (s) => s.credentialMode === "local"
  )
  if (localServers.length > 0) {
    const { error } = await client.from("mcp_servers").upsert(
      localServers.map((s) => ({
        id: s.id,
        user_id: userId,
        workspace_id: s.workspaceId,
        name: s.name,
        url: s.url,
        transport: s.transport,
        credential_mode: s.credentialMode,
        credential_fingerprint: s.credentialFingerprint ?? null,
        // Cast: McpCapabilities is an open record without an index
        // signature; at runtime it round-trips as plain JSON.
        capabilities: (s.capabilities ?? null) as unknown as Json,
        capabilities_fetched_at: s.capabilitiesFetchedAt
          ? s.capabilitiesFetchedAt.toISOString()
          : null,
        enabled: s.enabled,
        created_at: s.createdAt.toISOString(),
        updated_at: s.updatedAt.toISOString(),
        deleted_at: s.deletedAt ? s.deletedAt.toISOString() : null,
      }))
    )
    if (error) return { ok: false, error: `mcp_servers: ${error.message}` }
  }

  // mcp_resources (depends on mcp_servers + workspaces)
  if (snapshot.mcpResources.length > 0) {
    const { error } = await client.from("mcp_resources").upsert(
      snapshot.mcpResources.map((r) => ({
        id: r.id,
        user_id: userId,
        workspace_id: r.workspaceId,
        server_id: r.serverId,
        uri: r.uri,
        name: r.name,
        description: r.description ?? null,
        mime_type: r.mimeType ?? null,
        added_at: r.addedAt.toISOString(),
        deleted_at: r.deletedAt ? r.deletedAt.toISOString() : null,
      }))
    )
    if (error) return { ok: false, error: `mcp_resources: ${error.message}` }
  }

  // mcp_resource_bindings (depends on mcp_resources + workspaces)
  if (snapshot.mcpResourceBindings.length > 0) {
    const { error } = await client.from("mcp_resource_bindings").upsert(
      snapshot.mcpResourceBindings.map((b) => ({
        id: b.id,
        user_id: userId,
        workspace_id: b.workspaceId,
        resource_id: b.resourceId,
        added_at: b.addedAt.toISOString(),
      }))
    )
    if (error)
      return { ok: false, error: `mcp_resource_bindings: ${error.message}` }
  }

  // conversation_mcp_resources (depends on mcp_resources + conversations)
  if (snapshot.conversationMcpResources.length > 0) {
    const { error } = await client.from("conversation_mcp_resources").upsert(
      snapshot.conversationMcpResources.map((cmr) => ({
        id: cmr.id,
        user_id: userId,
        conversation_id: cmr.conversationId,
        resource_id: cmr.resourceId,
        added_at: cmr.addedAt.toISOString(),
      }))
    )
    if (error)
      return { ok: false, error: `conversation_mcp_resources: ${error.message}` }
  }

  // url_bookmarks (depends on workspaces)
  if (snapshot.urlBookmarks.length > 0) {
    const { error } = await client.from("url_bookmarks").upsert(
      snapshot.urlBookmarks.map((b) => ({
        id: b.id,
        user_id: userId,
        workspace_id: b.workspaceId,
        url: b.url,
        title: b.title,
        content: b.content,
        content_truncated: b.contentTruncated,
        content_hash: b.contentHash,
        description: b.description ?? null,
        favicon_url: b.faviconUrl ?? null,
        fetched_at: b.fetchedAt.toISOString(),
        deleted_at: b.deletedAt ? b.deletedAt.toISOString() : null,
        created_at: b.createdAt.toISOString(),
        updated_at: b.updatedAt.toISOString(),
      }))
    )
    if (error) return { ok: false, error: `url_bookmarks: ${error.message}` }
  }

  // conversation_url_bookmarks (depends on url_bookmarks + conversations)
  if (snapshot.conversationUrlBookmarks.length > 0) {
    const { error } = await client.from("conversation_url_bookmarks").upsert(
      snapshot.conversationUrlBookmarks.map((cub) => ({
        id: cub.id,
        user_id: userId,
        conversation_id: cub.conversationId,
        bookmark_id: cub.bookmarkId,
        added_at: cub.addedAt.toISOString(),
      }))
    )
    if (error)
      return { ok: false, error: `conversation_url_bookmarks: ${error.message}` }
  }

  // notes — workspace-scoped after migration 0011, so orphans
  // (conversationId === null) upload too via the new workspace_id
  // column. Skip rows missing a workspaceId entirely (shouldn't
  // happen post-v12 backfill, but defensive).
  const uploadableNotes = snapshot.notes.filter((n) => !!n.workspaceId)
  if (uploadableNotes.length > 0) {
    const { error } = await client.from("notes").upsert(
      uploadableNotes.map((n) => ({
        id: n.id,
        user_id: userId,
        workspace_id: n.workspaceId,
        conversation_id: n.conversationId,
        message_id: n.messageId,
        body: n.body,
        created_at: n.createdAt.toISOString(),
        updated_at: n.updatedAt.toISOString(),
      }))
    )
    if (error) return { ok: false, error: `notes: ${error.message}` }
  }

  // artifacts — same workspace-scoped story as notes.
  const uploadableArtifacts = snapshot.artifacts.filter((a) => !!a.workspaceId)
  if (uploadableArtifacts.length > 0) {
    const { error } = await client.from("artifacts").upsert(
      uploadableArtifacts.map((a) => ({
        id: a.id,
        user_id: userId,
        workspace_id: a.workspaceId,
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
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )
  const activeWorkspaceId =
    sortedWorkspaces.find((w) => w.id === s.activeWorkspaceId)?.id ??
    sortedWorkspaces[0]?.id ??
    s.activeWorkspaceId

  const candidateConvs = snapshot.conversations.filter(
    (c) => c.workspaceId === activeWorkspaceId
  )
  const sortedConvs = candidateConvs.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )
  const activeConversationId =
    sortedConvs.find((c) => c.id === s.activeConversationId)?.id ??
    sortedConvs[0]?.id ??
    null

  // Active document for the picked workspace: prefer the previously-
  // active id if it lives in that workspace, else the most-recently-
  // updated doc, else null.
  const docsInActiveWorkspace = snapshot.documents.filter(
    (d) => d.workspaceId === activeWorkspaceId
  )
  const sortedDocs = docsInActiveWorkspace.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )
  const activeDocumentId =
    sortedDocs.find((d) => d.id === s.activeDocumentId)?.id ??
    sortedDocs[0]?.id ??
    null

  // Seed sync FIRST so the diff sees no change when setState fires.
  setSyncSnapshot({
    workspaces: snapshot.workspaces,
    documents: snapshot.documents,
    conversations: snapshot.conversations,
    files: snapshot.files,
    resources: snapshot.resources,
    conversationFiles: snapshot.conversationFiles,
    notes: snapshot.notes,
    artifacts: snapshot.artifacts,
    mcpServers: snapshot.mcpServers,
    mcpResources: snapshot.mcpResources,
    mcpResourceBindings: snapshot.mcpResourceBindings,
    conversationMcpResources: snapshot.conversationMcpResources,
    urlBookmarks: snapshot.urlBookmarks,
    conversationUrlBookmarks: snapshot.conversationUrlBookmarks,
  })

  useStore.setState({
    workspaces: snapshot.workspaces,
    documents: snapshot.documents,
    conversations: snapshot.conversations,
    files: snapshot.files,
    resources: snapshot.resources,
    conversationFiles: snapshot.conversationFiles,
    notes: snapshot.notes,
    artifacts: snapshot.artifacts,
    mcpServers: snapshot.mcpServers,
    mcpResources: snapshot.mcpResources,
    mcpResourceBindings: snapshot.mcpResourceBindings,
    conversationMcpResources: snapshot.conversationMcpResources,
    urlBookmarks: snapshot.urlBookmarks,
    conversationUrlBookmarks: snapshot.conversationUrlBookmarks,
    activeWorkspaceId,
    activeConversationId,
    activeDocumentId,
  })
}
