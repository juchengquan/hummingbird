import "client-only"

import { reviveDates } from "@/client/store/revive-dates"

import type { AppState } from "../use-store"

/**
 * Selects the subset of `AppState` that persists to localStorage.
 *
 * Wired into the zustand-persist `partialize` field. Keys not listed
 * here are runtime-only — e.g. `pendingChatInput` (a one-shot bus),
 * `streamingContent` / `typingConversationIds` (mid-stream state), and
 * `pinnedExplanations` / `pendingSelectionAction` (intentionally
 * session-scoped).
 *
 * **Frozen shape** — every key here is part of the persisted contract
 * with users' localStorage (key `hummingbird-storage`, current
 * `STORE_VERSION`). Don't add / remove / rename a key without a
 * matching migration step in `runMigrations`.
 */
export const partializeState = (state: AppState) => ({
  theme: state.theme,
  colorScheme: state.colorScheme,
  activeView: state.activeView,
  workspaces: state.workspaces,
  activeWorkspaceId: state.activeWorkspaceId,
  resources: state.resources,
  conversationFiles: state.conversationFiles,
  mcpServers: state.mcpServers,
  mcpResources: state.mcpResources,
  mcpResourceBindings: state.mcpResourceBindings,
  conversationMcpResources: state.conversationMcpResources,
  urlBookmarks: state.urlBookmarks,
  conversationUrlBookmarks: state.conversationUrlBookmarks,
  conversations: state.conversations,
  activeConversationId: state.activeConversationId,
  files: state.files,
  chatModel: state.chatModel,
  chatReasoningEffort: state.chatReasoningEffort,
  customInstructionsAbout: state.customInstructionsAbout,
  customInstructionsStyle: state.customInstructionsStyle,
  memoryEnabled: state.memoryEnabled,
  notes: state.notes,
  artifacts: state.artifacts,
  documents: state.documents,
  activeDocumentId: state.activeDocumentId,
  resourcesSidebarOpen: state.resourcesSidebarOpen,
  resourcesSidebarTab: state.resourcesSidebarTab,
  tasksPanelOpen: state.tasksPanelOpen,
  sidebarWidth: state.sidebarWidth,
  resourcesSidebarWidth: state.resourcesSidebarWidth,
  editorPrefs: state.editorPrefs,
  localOnlyMode: state.localOnlyMode,
  localFilesOnly: state.localFilesOnly,
  verifyCitations: state.verifyCitations,
  chatBackend: state.chatBackend,
  prompts: state.prompts,
  agents: state.agents,
  activeAgentId: state.activeAgentId,
  userSkills: state.userSkills,
  projectTasks: state.projectTasks,
  // pendingChatInput is deliberately NOT persisted — it's a
  // one-shot event signal, not durable state. Surviving a reload
  // would re-trigger an insert on next mount.
})

/**
 * Mutates a freshly-rehydrated state into runtime shape:
 *
 * 1. Revives Date fields. Zustand-persist round-trips Dates through
 *    JSON which strips them to ISO strings; without this pass every
 *    `Date`-typed field would be a string at runtime and any
 *    `.toISOString()` / `.getTime()` call would need to defend itself.
 *    See `lib/client/store/revive-dates.ts`.
 *
 * 2. Defensive prune: drops join rows and selection ids that
 *    reference a missing or tombstoned target. Cheap (one pass per
 *    array), no-op on healthy data; covers cross-tab races and any
 *    future bugs in new mutators.
 *
 * Caller wires this into `onRehydrateStorage` and is responsible for
 * calling `notifyHydrated()` afterwards.
 */
export function reviveAndPruneState(state: AppState): void {
  reviveDates(state as unknown as Record<string, unknown>)

  const liveFileIds = new Set(
    state.files.filter((f) => !f.deletedAt).map((f) => f.id)
  )
  const liveMcpResourceIds = new Set(
    state.mcpResources.filter((r) => !r.deletedAt).map((r) => r.id)
  )
  const liveUrlBookmarkIds = new Set(
    state.urlBookmarks.filter((b) => !b.deletedAt).map((b) => b.id)
  )
  const liveArtifactIds = new Set(state.artifacts.map((a) => a.id))
  state.resources = state.resources.filter((r) => liveFileIds.has(r.fileId))
  state.conversationFiles = state.conversationFiles.filter((cf) =>
    liveFileIds.has(cf.fileId)
  )
  state.mcpResourceBindings = state.mcpResourceBindings.filter((b) =>
    liveMcpResourceIds.has(b.resourceId)
  )
  state.conversationMcpResources = state.conversationMcpResources.filter(
    (cmr) => liveMcpResourceIds.has(cmr.resourceId)
  )
  state.conversationUrlBookmarks = state.conversationUrlBookmarks.filter(
    (cub) => liveUrlBookmarkIds.has(cub.bookmarkId)
  )
  state.conversations = state.conversations.map((c) => {
    const fileSel = c.selectedFileIds.filter((id) => liveFileIds.has(id))
    const mcpSel = (c.selectedMcpResourceIds ?? []).filter((id) =>
      liveMcpResourceIds.has(id)
    )
    const urlSel = (c.selectedUrlBookmarkIds ?? []).filter((id) =>
      liveUrlBookmarkIds.has(id)
    )
    const artifactSel = (c.selectedArtifactIds ?? []).filter((id) =>
      liveArtifactIds.has(id)
    )
    const fileChanged = fileSel.length !== c.selectedFileIds.length
    const mcpChanged =
      mcpSel.length !== (c.selectedMcpResourceIds ?? []).length
    const urlChanged =
      urlSel.length !== (c.selectedUrlBookmarkIds ?? []).length
    const artifactChanged =
      artifactSel.length !== (c.selectedArtifactIds ?? []).length
    if (!fileChanged && !mcpChanged && !urlChanged && !artifactChanged) return c
    return {
      ...c,
      selectedFileIds: fileSel,
      selectedMcpResourceIds: mcpSel.length > 0 ? mcpSel : undefined,
      selectedUrlBookmarkIds: urlSel.length > 0 ? urlSel : undefined,
      selectedArtifactIds: artifactSel.length > 0 ? artifactSel : undefined,
    }
  })
}
