"use client"
import "client-only"

/**
 * Aggregator hook that returns the categorized snapshot of everything
 * currently "attached" to the active conversation — files,
 * conversation-private files, URL bookmarks, MCP resources, and
 * enabled skills. The chat input's `<ContextPicker>` reads this to
 * render its popover; `<ContextInlinePreview>` reads it for the
 * 0-to-2-chip preview row.
 *
 * Pure derived state from existing store slices — no new schema.
 * Returns memo-friendly arrays so consumers can `useMemo` over them
 * without doing the join work twice. Each entry carries the minimum
 * the picker needs: a stable `id`, a display label, and the source
 * data the × handler reaches for (file id, bookmark id, skill id, …).
 */
import { useMemo } from "react"

import { SKILLS } from "@/shared/skills/registry"
import { resolveSkill, type SkillDescriptor, type SkillId } from "@/shared/skills/types"
import type {
  McpResource,
  UploadedFile,
  UrlBookmark,
} from "@/shared/types"

import {
  useActiveConversation,
  useActiveWorkspace,
  useConversationPrivateFiles,
  useConversationSelectedFileIds,
  useStore,
  useWorkspaceMcpResources,
  useWorkspaceResources,
  useWorkspaceUrlBookmarks,
} from "@/client/hooks/use-store"

export interface AttachedSkill {
  kind: "skill"
  id: SkillId
  name: string
  icon: SkillDescriptor["icon"]
}

export interface AttachedFile {
  kind: "workspaceFile" | "conversationFile"
  id: string
  name: string
  /** Mime type — drives icon selection in the picker. */
  type: string
  size: number
}

export interface AttachedBookmark {
  kind: "bookmark"
  id: string
  title: string
  url: string
}

export interface AttachedMcpResource {
  kind: "mcpResource"
  id: string
  name: string
  /** Server name for the row's subtitle (e.g. "GitHub"). */
  serverName: string
}

export type AttachedItem =
  | AttachedSkill
  | AttachedFile
  | AttachedBookmark
  | AttachedMcpResource

export interface AttachedContext {
  skills: AttachedSkill[]
  workspaceFiles: AttachedFile[]
  conversationFiles: AttachedFile[]
  bookmarks: AttachedBookmark[]
  mcpResources: AttachedMcpResource[]
  /** Sum of all section lengths — used by the picker badge + the
   *  inline preview's overflow indicator. */
  totalCount: number
}

export function useAttachedContext(): AttachedContext {
  const workspace = useActiveWorkspace()
  const conversation = useActiveConversation()
  const selectedFileIds = useConversationSelectedFileIds()
  const workspaceResources = useWorkspaceResources()
  const conversationPrivateFiles = useConversationPrivateFiles()
  const workspaceBookmarks = useWorkspaceUrlBookmarks()
  const workspaceMcpResources = useWorkspaceMcpResources()
  const mcpServers = useStore((s) => s.mcpServers)

  // Selected bookmark / MCP-resource id sets live on the conversation
  // row; access via store rather than dedicated selectors to keep this
  // hook self-contained.
  const selectedUrlBookmarkIds = conversation?.selectedUrlBookmarkIds ?? []
  const selectedMcpResourceIds = conversation?.selectedMcpResourceIds ?? []

  return useMemo<AttachedContext>(() => {
    // --- Skills: enabled (resolved cascade), ordered by registry. ---
    const skills: AttachedSkill[] = SKILLS.filter((s) =>
      resolveSkill(s, workspace?.skillPrefs, conversation?.skillPrefs)
    ).map((s) => ({
      kind: "skill",
      id: s.id,
      name: s.name,
      icon: s.icon,
    }))

    // --- Workspace files: those ticked into the active conversation. ---
    const workspaceFilesById = new Map<string, UploadedFile>()
    for (const f of workspaceResources) workspaceFilesById.set(f.id, f)
    const workspaceFiles: AttachedFile[] = selectedFileIds
      .map((id) => workspaceFilesById.get(id))
      .filter((f): f is UploadedFile => !!f)
      .map((f) => ({
        kind: "workspaceFile",
        id: f.id,
        name: f.name,
        type: f.type,
        size: f.size,
      }))

    // --- Conversation-private files: every private file is "attached"
    //     by definition (they're scoped to this chat). ---
    const conversationFiles: AttachedFile[] = conversationPrivateFiles.map((f) => ({
      kind: "conversationFile",
      id: f.id,
      name: f.name,
      type: f.type,
      size: f.size,
    }))

    // --- URL bookmarks: ticked into the conversation. ---
    const bookmarksById = new Map<string, UrlBookmark>()
    for (const b of workspaceBookmarks) bookmarksById.set(b.id, b)
    const bookmarks: AttachedBookmark[] = selectedUrlBookmarkIds
      .map((id) => bookmarksById.get(id))
      .filter((b): b is UrlBookmark => !!b)
      .map((b) => ({
        kind: "bookmark",
        id: b.id,
        title: b.title || b.url,
        url: b.url,
      }))

    // --- MCP resources: ticked into the conversation. ---
    const mcpResourcesById = new Map<string, McpResource>()
    for (const r of workspaceMcpResources) mcpResourcesById.set(r.id, r)
    const serverNamesById = new Map<string, string>()
    for (const s of mcpServers) serverNamesById.set(s.id, s.name)
    const mcpResources: AttachedMcpResource[] = selectedMcpResourceIds
      .map((id) => mcpResourcesById.get(id))
      .filter((r): r is McpResource => !!r)
      .map((r) => ({
        kind: "mcpResource",
        id: r.id,
        name: r.name,
        serverName: serverNamesById.get(r.serverId) ?? "MCP",
      }))

    return {
      skills,
      workspaceFiles,
      conversationFiles,
      bookmarks,
      mcpResources,
      totalCount:
        skills.length +
        workspaceFiles.length +
        conversationFiles.length +
        bookmarks.length +
        mcpResources.length,
    }
  }, [
    workspace?.skillPrefs,
    conversation?.skillPrefs,
    selectedFileIds,
    workspaceResources,
    conversationPrivateFiles,
    workspaceBookmarks,
    selectedUrlBookmarkIds,
    workspaceMcpResources,
    selectedMcpResourceIds,
    mcpServers,
  ])
}
