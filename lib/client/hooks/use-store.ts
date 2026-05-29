import "client-only"
import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  UploadedFile,
  Workspace,
  Document,
  Resource,
  ConversationFile,
  McpServer,
  McpResource,
  McpResourceBinding,
  ConversationMcpResource,
  McpCapabilities,
  McpCredentialMode,
  UrlBookmark,
  ConversationUrlBookmark,
  Message,
  MessageError,
  Conversation,
  MainView,
  Note,
  Artifact,
  ArtifactKind,
  GeneratedImage,
  Prompt,
  ToolCallRecord,
  ToolCallResult,
  PinnedExplanation,
} from '@/shared/types'
import { DEFAULT_CHAT_MODEL } from '@/shared/models'
import { buildCompressedMessages } from '@/shared/compression'
import { deleteBlob as deleteLocalBlob, clearAll as clearLocalBlobs } from '@/client/files/local-store'
import {
  bulkTombstoneByKind,
  cloneAttachmentSelections,
  forkConversationJoins,
  gcOrphanedAttachment,
  gcOrphanedAttachments,
  tombstoneFile,
  tombstoneMcpResource,
  tombstoneUrlBookmark,
  type AttachmentRef,
} from '@/client/store/cascade'
import { reviveDates } from '@/client/store/revive-dates'
import { uuid } from '@/shared/uuid'
import { parseTemplate } from '@/shared/prompts/expand'

// Short, URL-safe id for prompts. Re-uses the existing uuid helper so we
// don't add a nanoid dep; the slice doesn't need RFC4122 cryptographic
// uniqueness, just unique-within-a-user's-library.
const nanoid = uuid

const SIDEBAR_WIDTH_MIN = 160
const SIDEBAR_WIDTH_MAX = 480
function clampSidebarWidth(n: number): number {
  if (!Number.isFinite(n)) return 256
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(n)))
}

const RESOURCES_SIDEBAR_WIDTH_MIN = 200
const RESOURCES_SIDEBAR_WIDTH_MAX = 400
function clampResourcesSidebarWidth(n: number): number {
  if (!Number.isFinite(n)) return 272
  return Math.max(RESOURCES_SIDEBAR_WIDTH_MIN, Math.min(RESOURCES_SIDEBAR_WIDTH_MAX, Math.round(n)))
}

/**
 * Slugify a prompt name for the future `/<slug>` slash trigger. Lowercase,
 * spaces and punctuation collapsed to single dashes, leading/trailing
 * dashes trimmed. Empty string → "prompt" (the createPrompt action layers
 * collision-handling on top via `ensureUniquePromptSlug`).
 */
function defaultSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "prompt"
}

/**
 * Append `-2`, `-3`, ... to `base` until the slug is unique within the
 * caller's prompt list. `excludePromptId` lets updatePrompt re-check its
 * own slug without colliding with itself.
 */
function ensureUniquePromptSlug(
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
  return `${base}-${nanoid().slice(0, 6)}`
}

export type {
  UploadedFile,
  Workspace,
  Document,
  Resource,
  ConversationFile,
  McpServer,
  McpResource,
  McpResourceBinding,
  ConversationMcpResource,
  McpCapabilities,
  McpCredentialMode,
  UrlBookmark,
  ConversationUrlBookmark,
  Message,
  MessageError,
  Conversation,
  MainView,
  Note,
  Artifact,
  ArtifactKind,
  GeneratedImage,
  ToolCallRecord,
} from '@/shared/types'

type Theme = 'system' | 'dark' | 'light'
type ColorScheme = 'default' | 'anthropic'

// Read theme from localStorage synchronously to prevent flash
function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  try {
    const stored = localStorage.getItem('hummingbird-storage')
    if (stored) {
      const parsed = JSON.parse(stored)
      return parsed.state?.theme || 'dark'
    }
  } catch {}
  return 'dark'
}

// Track hydration state for SSR/client synchronization. We expose it via
// useSyncExternalStore so subscribers update when Zustand's persist
// middleware finishes loading from localStorage. Server snapshot is
// always `false` to keep SSR + first client paint consistent; the flip
// to `true` happens after hydration, post-mount.
let hasHydratedInternal = false
const hydrationSubscribers = new Set<() => void>()
function subscribeHydration(callback: () => void): () => void {
  hydrationSubscribers.add(callback)
  return () => {
    hydrationSubscribers.delete(callback)
  }
}
function notifyHydrated(): void {
  hasHydratedInternal = true
  for (const cb of hydrationSubscribers) cb()
}
export const useHydrated = () =>
  useSyncExternalStore(
    subscribeHydration,
    () => hasHydratedInternal,
    () => false
  )

/**
 * Tombstone an `McpServer`: mark it deleted and drop the cached
 * `capabilities` blob (which can be large after a discovery). The
 * stub keeps id / workspaceId / name / transport / createdAt so any
 * historical message that referenced an MCP tool from this server
 * resolves to a "🗑 GitHub MCP (removed)" label.
 */
function tombstoneMcpServer(server: McpServer): McpServer {
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

/**
 * Deep-merge a `Partial<WebSearchConfig>` patch into an existing config,
 * dropping any leaf or sub-object whose patched value is `undefined`.
 * Pruning empty sub-objects (or returning `undefined` for the whole
 * thing) is what lets a "reset to default" flow remove the override so
 * the next cascade level takes over.
 */
function mergeWebFetchConfig(
  base: import('@/shared/skills/web-fetch-config').WebFetchConfig | undefined,
  patch: Partial<import('@/shared/skills/web-fetch-config').WebFetchConfig>
):
  | import('@/shared/skills/web-fetch-config').WebFetchConfig
  | undefined {
  const next: Record<string, unknown> = { ...(base ?? {}) }
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    const value = patch[key]
    if (value === undefined) delete next[key as string]
    else next[key as string] = value
  }
  if (Object.keys(next).length === 0) return undefined
  return next as import('@/shared/skills/web-fetch-config').WebFetchConfig
}

function mergeImageGenConfig(
  base: import('@/shared/skills/image-gen-config').ImageGenConfig | undefined,
  patch: Partial<import('@/shared/skills/image-gen-config').ImageGenConfig>
):
  | import('@/shared/skills/image-gen-config').ImageGenConfig
  | undefined {
  const next: Record<string, unknown> = { ...(base ?? {}) }
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    const value = patch[key]
    if (value === undefined) delete next[key as string]
    else next[key as string] = value
  }
  if (Object.keys(next).length === 0) return undefined
  return next as import('@/shared/skills/image-gen-config').ImageGenConfig
}

function mergeFileSearchConfig(
  base: import('@/shared/skills/file-search-config').FileSearchConfig | undefined,
  patch: Partial<import('@/shared/skills/file-search-config').FileSearchConfig>
):
  | import('@/shared/skills/file-search-config').FileSearchConfig
  | undefined {
  const next: Record<string, unknown> = { ...(base ?? {}) }
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    const value = patch[key]
    if (value === undefined) delete next[key as string]
    else next[key as string] = value
  }
  if (Object.keys(next).length === 0) return undefined
  return next as import('@/shared/skills/file-search-config').FileSearchConfig
}

function mergeWebSearchConfig(
  base: import('@/shared/skills/web-search-config').WebSearchConfig | undefined,
  patch: Partial<import('@/shared/skills/web-search-config').WebSearchConfig>
):
  | import('@/shared/skills/web-search-config').WebSearchConfig
  | undefined {
  const next: Record<string, unknown> = { ...(base ?? {}) }
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    const value = patch[key]
    if (value === undefined) {
      delete next[key as string]
      continue
    }
    if (key === 'tavily' || key === 'brave' || key === 'exa') {
      // Sub-object merge: deep on the known provider sub-configs.
      const prior = (next[key as string] ?? {}) as Record<string, unknown>
      const merged: Record<string, unknown> = { ...prior }
      for (const [subKey, subValue] of Object.entries(value)) {
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
  return next as import('@/shared/skills/web-search-config').WebSearchConfig
}

// Default initial values for store
const DEFAULT_WORKSPACE_ID = 'default'

const getDefaultWorkspaces = (): Workspace[] => {
  const now = new Date('2024-01-01T12:00:00Z')
  return [
    {
      id: DEFAULT_WORKSPACE_ID,
      name: 'My Workspace',
      createdAt: now,
      updatedAt: now,
    },
  ]
}

const getDefaultConversations = (): Conversation[] => {
  const baseTime = new Date('2024-01-01T12:00:00Z').getTime()
  return [
    {
      id: 'demo-1',
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: 'Welcome',
      // Empty by design — the chat panel renders <EmptyChatWelcome> when
      // there are no messages, with feature bullets and suggestion chips.
      // Leaving stale pretend-messages here makes the app feel like a
      // demo someone forgot to wipe before shipping.
      messages: [],
      createdAt: new Date(baseTime - 120000),
      updatedAt: new Date(baseTime),
      pinned: true,
      selectedFileIds: [],
    },
  ]
}

/**
 * Bus payload for selection-driven actions dispatched from outside the
 * `SelectionTrigger` (currently: the ⌘K command palette). The palette
 * captures `window.getSelection()` at open time, then fires one of these
 * via `fireSelectionAction`. `SelectionTrigger` consumes + clears it.
 *
 * `rect` is a plain object (not a `DOMRect`) so it survives any future
 * serialization without coupling consumers to the live DOM range.
 */
export type PendingSelectionAction =
  | {
      type: 'explain'
      text: string
      scope: string
      rect: { top: number; left: number; right: number; bottom: number; width: number; height: number }
    }
  | { type: 'quote'; text: string }

interface AppState {
  // Theme
  theme: Theme

  // Active main-area view (single source of truth — see MainArea in dashboard/page.tsx)
  activeView: MainView

  // Sidebar
  sidebarCollapsed: boolean
  /** Custom sidebar width in px. Default 256 (16rem). Clamped 172–480.
   *  Only applies when the sidebar is expanded (not icon-collapsed). */
  sidebarWidth: number
  setSidebarWidth: (width: number) => void

  // Right resources sidebar (chat view)
  resourcesSidebarOpen: boolean
  resourcesSidebarTab: 'files' | 'notes' | 'artifacts' | 'skills' | 'pins' | 'mcp' | 'links'
  // Tasks panel (chat view) — the live surface for long-running agent runs.
  tasksPanelOpen: boolean
  /** Custom right-rail content width in px. Default 272 (17rem).
   *  Clamped 200–400. */
  resourcesSidebarWidth: number
  setResourcesSidebarWidth: (width: number) => void
  /** Per-user editor preferences. Persisted across reloads.
   *  - `aiReviewChanges`: when true (default), AI `edit`-mode output
   *    lands as Plate suggestion marks the user can accept/reject
   *    per chunk. When false, the AI's output replaces the selected
   *    text directly (the pre-diff-mode behaviour). */
  editorPrefs: {
    aiReviewChanges: boolean
  }

  /** Session-only pinned explanations from the selection-driven Explain
   *  action. Excluded from `partialize` — by design, pins vanish on
   *  reload. Scoped to a conversation via the `conversationId` field. */
  pinnedExplanations: PinnedExplanation[]

  /** One-shot bus for selection-driven actions dispatched from outside
   *  the SelectionTrigger (e.g. the command palette). The trigger
   *  subscribes; on consumption it calls `clearSelectionAction`.
   *  Excluded from `partialize`. */
  pendingSelectionAction: PendingSelectionAction | null

  /**
   * When true, behave as if Supabase isn't configured — no sync, no
   * reconcile pulls, no auth flows. Lets users opt out even when
   * `NEXT_PUBLIC_SUPABASE_URL` is set (e.g., on a shared machine).
   * Survives reloads via partialize.
   */
  localOnlyMode: boolean

  /**
   * When true, raw file blobs are kept in IndexedDB instead of being
   * uploaded to Supabase Storage. Extracted text + metadata still sync
   * (it's small), but the actual blob never leaves the device. Useful
   * when the user wants to stay under Supabase Storage quotas.
   */
  localFilesOnly: boolean

  // Files
  files: UploadedFile[]

  // Workspaces
  workspaces: Workspace[]
  activeWorkspaceId: string

  // Documents — rich-text docs inside a workspace. A workspace owns N
  // documents; `activeDocumentId` tracks which one the editor panel is
  // showing. Switching workspaces resyncs `activeDocumentId` to that
  // workspace's most-recently-updated doc (or null if none yet).
  documents: Document[]
  activeDocumentId: string | null

  // Resources (file-to-workspace associations)
  resources: Resource[]

  // Conversation-private file attachments (file-to-conversation join).
  // Sits alongside `resources`: a `fileId` can be in either, both, or
  // neither. Private files are scoped to one conversation and never
  // appear in the workspace library.
  conversationFiles: ConversationFile[]

  // MCP — workspace-scoped server bindings + the resources they expose.
  // Same lane model as files: workspace library (`mcpResourceBindings`)
  // + conversation-private (`conversationMcpResources`).
  mcpServers: McpServer[]
  mcpResources: McpResource[]
  mcpResourceBindings: McpResourceBinding[]
  conversationMcpResources: ConversationMcpResource[]

  // URL bookmarks — saved web pages. Third source type after files
  // and MCP resources; workspace-library rows ticked on per conversation
  // via `Conversation.selectedUrlBookmarkIds`, plus a private lane.
  urlBookmarks: UrlBookmark[]
  conversationUrlBookmarks: ConversationUrlBookmark[]

  // Notes (free-form notes & message bookmarks, scoped to a conversation)
  notes: Note[]

  // Artifacts (assistant-generated content captured by the user)
  artifacts: Artifact[]
  /** Bumped to force the editor to reload its content (e.g. on "Send to editor"). */
  editorReloadToken: number

  // Prompts — user-scoped saved templates. Listed in the left sidebar's
  // Prompts group; click-to-insert drops the expanded template into the
  // chat input via `pendingChatInput`. See docs/_done/PLAN-prompt-library.md.
  // Phase 1: local-only. Phase 2 will add Supabase sync.
  prompts: Prompt[]

  /** One-shot signal from anywhere in the app to ChatPanel's local input
   *  state. Set by sidebar prompt click (after variable expansion) or
   *  any future surface that wants to seed the input. ChatPanel's
   *  useEffect reads, copies to local state, then clears (so the same
   *  string can be inserted again later without dedup confusion). */
  pendingChatInput: string | null

  // Conversations
  conversations: Conversation[]
  activeConversationId: string | null

  // Chat
  /** Conversation ids currently mid-stream — populated by chat.tsx
   *  when it starts a send, cleared on stream end (or abort/error).
   *  Per-conversation so switching to another chat while one is
   *  streaming doesn't blanket-disable input everywhere; see
   *  `useIsConversationTyping(id)` for the derived per-conversation
   *  flag. Not persisted: streaming state is ephemeral. */
  typingConversationIds: string[]
  streamingContent: string
  chatModel: string
  /**
   * Pending image-to-image reference for the next user message. Set by
   * the "Remix" action on a `GeneratedImagesGallery` tile; cleared on
   * send or on explicit dismiss. Lives only at the runtime layer — not
   * persisted (and intentionally not synced) because it's an in-flight
   * compose-time hint, not a property of any saved message.
   *
   * The URL must be publicly fetchable for the Minimax server to load
   * it (signed Supabase Storage URLs qualify; `data:` URLs do not, so
   * Remix is gated on a non-data URL upstream).
   */
  pendingReferenceImage: {
    url: string
    /** Optional source prompt — used in the chip caption so the user
     *  knows which image they're remixing. */
    sourcePrompt?: string
  } | null
  /**
   * True when the user has touched the chat-input model picker since
   * the current workspace was activated. Suppresses the workspace's
   * `defaultModel` from re-applying on every render. Resets when the
   * active workspace changes. Not persisted — this is a per-session
   * intent flag.
   */
  sessionModelOverridden: boolean

  // View / sidebar actions
  toggleSidebar: () => void
  setActiveView: (view: MainView) => void
  setResourcesSidebarOpen: (open: boolean) => void
  toggleResourcesSidebar: () => void
  setResourcesSidebarTab: (tab: 'files' | 'notes' | 'artifacts' | 'skills' | 'pins' | 'mcp' | 'links') => void
  setTasksPanelOpen: (open: boolean) => void
  toggleTasksPanel: () => void
  setEditorPref: <K extends keyof AppState['editorPrefs']>(
    key: K,
    value: AppState['editorPrefs'][K]
  ) => void
  /** Pin an explanation produced by the selection-driven Explain
   *  action. Returns the inserted record (with id + createdAt set). */
  pinExplanation: (input: {
    conversationId: string
    selection: string
    content: string
    model: string
    results?: ToolCallResult[]
  }) => PinnedExplanation
  unpinExplanation: (id: string) => void
  /** Drop all pins for a conversation. Used when a conversation is
   *  deleted so we don't leak references to a vanished `conversationId`. */
  clearPinnedExplanationsForConversation: (conversationId: string) => void
  fireSelectionAction: (action: PendingSelectionAction) => void
  clearSelectionAction: () => void
  setLocalOnlyMode: (value: boolean) => void
  setLocalFilesOnly: (value: boolean) => void

  // Workspace actions
  createWorkspace: (name: string) => Workspace
  /** Reorder workspaces by id. Unknown ids are dropped; missing ids keep
   *  their relative tail order. */
  reorderWorkspaces: (orderedIds: string[]) => void
  deleteWorkspace: (workspaceId: string) => void
  renameWorkspace: (workspaceId: string, name: string) => void
  setWorkspaceSystemPrompt: (workspaceId: string, prompt: string) => void
  /** Patch the project-mode config on a workspace (toggle / goal /
   *  milestones). Only the keys present in `patch` are written, so
   *  e.g. flipping the toggle leaves an existing goal untouched. See
   *  `docs/PLAN-project-mode.md`. */
  setWorkspaceProjectConfig: (
    workspaceId: string,
    patch: Partial<Pick<Workspace, "isProject" | "goal" | "milestones">>
  ) => void
  /** Pin a default chat model on a workspace. Empty string clears the pin. */
  setWorkspaceDefaultModel: (workspaceId: string, modelId: string) => void
  /** Set a workspace skill default. `null` clears the entry (skill returns to default). */
  setWorkspaceSkillPref: (workspaceId: string, skillId: string, value: boolean | null) => void
  /** Patch the workspace-level `webSearch` config. Pass a partial
   *  `WebSearchConfig`; provided fields overwrite, others are kept.
   *  Setting a leaf to `undefined` (or the whole config to `null`)
   *  drops that override so the level below in the cascade takes
   *  over. */
  patchWorkspaceWebSearchConfig: (
    workspaceId: string,
    patch: Partial<import("@/shared/skills/web-search-config").WebSearchConfig> | null
  ) => void
  /** Patch the workspace-level `webFetch` config. Same cascade
   *  semantics as `patchWorkspaceWebSearchConfig`. */
  patchWorkspaceWebFetchConfig: (
    workspaceId: string,
    patch: Partial<import("@/shared/skills/web-fetch-config").WebFetchConfig> | null
  ) => void
  /** Patch the workspace-level `imageGen` config. Same cascade
   *  semantics as `patchWorkspaceWebSearchConfig`. */
  patchWorkspaceImageGenConfig: (
    workspaceId: string,
    patch: Partial<import("@/shared/skills/image-gen-config").ImageGenConfig> | null
  ) => void
  /** Patch the workspace-level `searchFiles` config. Same cascade
   *  semantics as `patchWorkspaceWebFetchConfig`. */
  patchWorkspaceFileSearchConfig: (
    workspaceId: string,
    patch: Partial<import("@/shared/skills/file-search-config").FileSearchConfig> | null
  ) => void
  /** Replace the workspace's spatial-canvas layout wholesale. Unlike the
   *  skill-config patchers this is a full set (the canvas panel owns the
   *  in-session React Flow state and writes the settled snapshot back on
   *  drag-stop / connect / add / delete). `null` clears the canvas. */
  setWorkspaceCanvasState: (
    workspaceId: string,
    state: import("@/shared/canvas/types").CanvasState | null
  ) => void
  setActiveWorkspace: (workspaceId: string) => void

  // Resource actions
  addResource: (workspaceId: string, fileId: string) => void
  removeResource: (resourceId: string) => void

  // Conversation-private file actions
  /** Attach a file privately to a conversation. The file is **not**
   *  added to the workspace library — it lives only inside this chat.
   *  No-op if the join already exists. */
  addConversationFile: (conversationId: string, fileId: string) => void
  /** Detach a private file from a conversation. If this was the last
   *  reference to the underlying `UploadedFile` (no `resources` row and
   *  no other `conversationFiles` row), the file is GC'd. */
  removeConversationFile: (conversationId: string, fileId: string) => void

  // MCP server actions
  /** Create a new MCP server config in the active workspace. Returns
   *  the inserted record. Discovery (`capabilities`) happens out-of-
   *  band via the proxy route. */
  addMcpServer: (input: {
    workspaceId: string
    name: string
    url: string
    credentialMode: McpCredentialMode
    credentialFingerprint?: string
    enabled?: boolean
  }) => McpServer
  /** Patch arbitrary fields on a server. Bumps `updatedAt`. */
  updateMcpServer: (
    serverId: string,
    patch: Partial<
      Pick<McpServer, 'name' | 'url' | 'enabled' | 'credentialMode' | 'credentialFingerprint'>
    >
  ) => void
  /** Replace the cached `capabilities` blob — called after a successful
   *  discovery round-trip. Also stamps `capabilitiesFetchedAt`. */
  setMcpServerCapabilities: (serverId: string, capabilities: McpCapabilities) => void
  setMcpServerEnabled: (serverId: string, enabled: boolean) => void
  /** Tombstone a server. Drops all dependent rows (resources, bindings,
   *  conversation joins) atomically; metadata stub remains so historic
   *  references resolve cleanly. */
  removeMcpServer: (serverId: string) => void

  // MCP resource actions
  /** Upsert a server-discovered resource into the cache. Idempotent on
   *  (serverId, uri). */
  upsertMcpResource: (input: {
    workspaceId: string
    serverId: string
    uri: string
    name: string
    description?: string
    mimeType?: string
  }) => McpResource
  /** Add a workspace-library binding for an MCP resource. No-op if the
   *  binding already exists. */
  addMcpResourceBinding: (workspaceId: string, resourceId: string) => void
  /** Drop a workspace-library binding. Strips the resource id from every
   *  conversation's `selectedMcpResourceIds`. If no other join references
   *  the underlying `McpResource`, it's GC'd (tombstoned). */
  removeMcpResourceBinding: (bindingId: string) => void
  /** Pin an MCP resource privately to a conversation. No-op if it's
   *  already pinned. */
  addConversationMcpResource: (conversationId: string, resourceId: string) => void
  /** Unpin a private MCP resource. GC's the underlying `McpResource`
   *  if it has no remaining live references. */
  removeConversationMcpResource: (conversationId: string, resourceId: string) => void
  /** Toggle a workspace-library MCP resource on/off for the active
   *  conversation (mirrors `toggleConversationFileSelection`). */
  toggleConversationMcpResourceSelection: (resourceId: string) => void

  // URL bookmark actions
  /** Add a freshly-fetched bookmark to the active workspace. The
   *  caller is responsible for the `/api/url/fetch` round-trip and
   *  passes the extracted fields here. Returns the inserted row. */
  addUrlBookmark: (input: {
    workspaceId: string
    url: string
    title: string
    content: string
    contentTruncated: boolean
    contentHash: string
    description?: string
    faviconUrl?: string
  }) => UrlBookmark
  /** Replace the cached content of a bookmark after a manual refresh.
   *  Bumps `fetchedAt` + `updatedAt` automatically. */
  updateUrlBookmark: (
    bookmarkId: string,
    patch: Partial<
      Pick<
        UrlBookmark,
        | 'title'
        | 'content'
        | 'contentTruncated'
        | 'contentHash'
        | 'description'
        | 'faviconUrl'
      >
    >
  ) => void
  /** Tombstone a bookmark. Drops all joins and selection ids
   *  atomically; metadata stub (url, title, createdAt) remains so
   *  historical message references resolve cleanly. */
  removeUrlBookmark: (bookmarkId: string) => void
  /** Pin a bookmark privately to a conversation. No-op if already
   *  pinned. */
  addConversationUrlBookmark: (conversationId: string, bookmarkId: string) => void
  /** Unpin a private bookmark. GC's the underlying bookmark when no
   *  other live join references it. */
  removeConversationUrlBookmark: (
    conversationId: string,
    bookmarkId: string
  ) => void
  /** Toggle a workspace-library bookmark on/off for the active
   *  conversation (mirrors the file + MCP-resource selection). */
  toggleConversationUrlBookmarkSelection: (bookmarkId: string) => void

  // Notes actions
  createNote: (input: { conversationId: string | null; messageId?: string | null; body?: string }) => Note
  updateNoteBody: (noteId: string, body: string) => void
  deleteNote: (noteId: string) => void
  /** Returns the resulting bookmark note if created, or null if removed. */
  toggleMessageBookmark: (conversationId: string, messageId: string) => Note | null

  // Artifacts actions
  createArtifact: (input: {
    conversationId: string
    messageId?: string | null
    kind: ArtifactKind
    language?: string | null
    title?: string
    content: string
    storagePath?: string | null
  }) => Artifact
  deleteArtifact: (artifactId: string) => void
  togglePinArtifact: (artifactId: string) => void
  updateArtifactTitle: (artifactId: string, title: string) => void
  requestEditorReload: () => void

  // Prompt actions — user-scoped saved templates. Slug is auto-derived
  // from `name` on create via `defaultSlug()`; the create action accepts
  // optional `slug` for cases (import, duplicate-with-rename) where the
  // caller wants control.
  createPrompt: (input: {
    workspaceId: string
    name: string
    template: string
    slug?: string
  }) => Prompt
  updatePrompt: (
    promptId: string,
    patch: Partial<Pick<Prompt, "name" | "slug" | "template">>
  ) => void
  /** Soft-delete — sets `deletedAt`. The Phase 2 sync layer reads the
   *  marker; the UI filters it out everywhere. */
  deletePrompt: (promptId: string) => void
  /** Clears the soft-delete marker. Restored prompts re-appear in the
   *  sidebar list. Currently no Undo UI for this in v1 — exposed
   *  programmatically for future surfaces. */
  restorePrompt: (promptId: string) => void

  /** Set the one-shot chat-input seed read by ChatPanel. Pass null to
   *  clear. ChatPanel clears immediately after reading. */
  setPendingChatInput: (value: string | null) => void

  // File actions
  addFile: (file: UploadedFile) => void
  removeFile: (fileId: string) => void
  clearFiles: () => void
  setFileExtraction: (
    fileId: string,
    patch: Partial<
      Pick<
        UploadedFile,
        | 'extractionStatus'
        | 'extractedText'
        | 'extractionTruncated'
        | 'extractedKind'
        | 'imageDataUrl'
        | 'summary'
        | 'keyTopics'
      >
    >
  ) => void
  setFileStorage: (fileId: string, patch: { storagePath?: string | null }) => void

  // Conversation actions
  createConversation: (workspaceId?: string) => Conversation
  /**
   * Branch a conversation at a specific message. Returns a new conversation
   * that contains a copy of every message up to and including `untilMessageId`,
   * inherits the source's workspace + selected files + document content +
   * skill prefs, and is set as active. Messages get fresh ids so the two
   * threads can diverge independently.
   */
  forkConversation: (conversationId: string, untilMessageId: string) => Conversation | null
  deleteConversation: (conversationId: string) => void
  renameConversation: (conversationId: string, title: string) => void
  /** Set a conversation skill override. `null` clears the entry (falls back to workspace default). */
  setConversationSkillPref: (conversationId: string, skillId: string, value: boolean | null) => void
  /** Patch the per-conversation `webSearch` config override (same shape
   *  and semantics as `patchWorkspaceWebSearchConfig`). */
  patchConversationWebSearchConfig: (
    conversationId: string,
    patch: Partial<import("@/shared/skills/web-search-config").WebSearchConfig> | null
  ) => void
  /** Patch the per-conversation `webFetch` config override (same shape
   *  and semantics as `patchWorkspaceWebFetchConfig`). */
  patchConversationWebFetchConfig: (
    conversationId: string,
    patch: Partial<import("@/shared/skills/web-fetch-config").WebFetchConfig> | null
  ) => void
  /** Patch the per-conversation `imageGen` config override. */
  patchConversationImageGenConfig: (
    conversationId: string,
    patch: Partial<import("@/shared/skills/image-gen-config").ImageGenConfig> | null
  ) => void
  /** Patch the per-conversation `searchFiles` config override (same shape
   *  and semantics as `patchWorkspaceFileSearchConfig`). */
  patchConversationFileSearchConfig: (
    conversationId: string,
    patch: Partial<import("@/shared/skills/file-search-config").FileSearchConfig> | null
  ) => void
  /** Toggle a file's attachment to the active conversation (no-op if no active conversation). */
  toggleConversationFileSelection: (fileId: string) => void
  /** Clear all attached files on the active conversation. */
  clearConversationFileSelection: () => void
  togglePin: (conversationId: string) => void
  setActiveConversation: (conversationId: string | null) => void

  // Message actions
  //
  // INVARIANT: every mutator below addresses a message by id and finds
  // the owning conversation by scanning every conversation's `messages`
  // array. None of them rely on `activeConversationId`. This is
  // deliberate so two conversations streaming in parallel land their
  // chunks correctly even when the user switches tabs mid-stream.
  // Don't reintroduce an `activeConversationId` filter inside these
  // mutators (the old wrong pattern) — see `addMessage`'s
  // `conversationId` parameter for the "I want to target a specific
  // conversation that may not be active" path.
  /** Append a message. Defaults to the active conversation; pass
   *  `conversationId` explicitly when a streaming callback may
   *  outlive the user's focus (e.g. they switch chats while a
   *  response is in flight). */
  addMessage: (
    message: Omit<Message, 'id' | 'timestamp'>,
    conversationId?: string
  ) => Message
  deleteMessage: (messageId: string) => void
  updateMessage: (messageId: string, content: string) => void
  truncateMessagesAfter: (messageId: string, inclusive?: boolean) => void
  /** Replace a slice of messages with a synthetic `kind: 'recap'`
   *  assistant message that summarises them. The originals stay on
   *  disk + visible, but are flagged `compressed: true` so the chat
   *  request builder skips them. Returns the inserted recap message
   *  (or null if no messages matched, which only happens if the caller
   *  passes stale ids). */
  compressMessages: (
    conversationId: string,
    messageIds: string[],
    recapContent: string
  ) => Message | null
  /** Inverse of `compressMessages`: removes the recap message and
   *  un-flags every message it stood in for. No-op if `recapMessageId`
   *  doesn't refer to a recap. */
  uncompressRecap: (conversationId: string, recapMessageId: string) => void
  clearMessages: () => void
  /** Mark a conversation as "typing" (loading dots above the
   *  message list). Idempotent — passing `true` twice for the same
   *  id is a no-op. */
  setConversationTyping: (conversationId: string, typing: boolean) => void
  /** Set the pending I2I reference for the next user message. Pass
   *  `null` to clear. */
  setPendingReferenceImage: (
    value: { url: string; sourcePrompt?: string } | null
  ) => void
  setStreamingContent: (content: string) => void
  setChatModel: (model: string) => void
  appendToMessage: (messageId: string, chunk: string) => void
  appendToMessageReasoning: (messageId: string, chunk: string) => void
  setMessageReasoningDuration: (messageId: string, durationMs: number) => void
  setMessageToolCalls: (messageId: string, toolCalls: ToolCallRecord[]) => void
  setMessageSuggestions: (messageId: string, suggestions: string[]) => void
  appendMessageGeneratedImages: (messageId: string, images: GeneratedImage[]) => void
  setMessageError: (messageId: string, error: MessageError) => void
  clearMessageError: (messageId: string) => void

  // Document actions. Workspaces own N documents; one is active at a
  // time across the app (top-level `activeDocumentId`).
  createDocument: (workspaceId: string, title?: string) => Document
  deleteDocument: (documentId: string) => void
  renameDocument: (documentId: string, title: string) => void
  setDocumentContent: (documentId: string, content: string) => void
  /** Append a markdown fragment to a document with a horizontal-rule
   *  separator. Used by "Send to editor" sites so prior work isn't
   *  overwritten. */
  appendToDocument: (documentId: string, fragment: string) => void
  setActiveDocument: (documentId: string | null) => void
  /** Convenience for "Send to editor" callers: appends to the active
   *  document, or creates one in the active workspace if none is set. */
  appendToActiveDocumentOrCreate: (fragment: string) => void

  // Theme actions
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  colorScheme: ColorScheme
  setColorScheme: (scheme: ColorScheme) => void
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Theme
      theme: getInitialTheme(),
      colorScheme: 'default' as ColorScheme,

      // Active main-area view
      activeView: 'workspaces',

      // Sidebar
      sidebarCollapsed: false,
      sidebarWidth: 256,

      // Right resources sidebar — default open on first load; the mobile
      // override happens in ResourcesSidebar's first-mount effect.
      resourcesSidebarOpen: true,
      resourcesSidebarTab: 'files',
      // Tasks panel — closed until the user launches a task.
      tasksPanelOpen: false,
      resourcesSidebarWidth: 272,
      editorPrefs: { aiReviewChanges: true },

      // Session-only selection-driven explain state (excluded from
      // partialize — pins vanish on reload by design).
      pinnedExplanations: [],
      pendingSelectionAction: null,

      // Local-only mode — off by default; users opt in via AccountMenu.
      localOnlyMode: false,
      localFilesOnly: false,

      // Files
      files: [],

      // Workspaces
      workspaces: getDefaultWorkspaces(),
      activeWorkspaceId: DEFAULT_WORKSPACE_ID,

      // Documents
      documents: [],
      activeDocumentId: null,

      // Resources
      resources: [],

      // Conversation-private file attachments
      conversationFiles: [],

      // MCP — server bindings and the resources they expose
      mcpServers: [],
      mcpResources: [],
      mcpResourceBindings: [],
      conversationMcpResources: [],

      // URL bookmarks
      urlBookmarks: [],
      conversationUrlBookmarks: [],

      // Notes
      notes: [],

      // Artifacts
      artifacts: [],
      editorReloadToken: 0,

      // Prompts (Phase 1: local-only)
      prompts: [],
      pendingChatInput: null,

      // Conversations
      conversations: getDefaultConversations().map((c: Conversation) => ({
        ...c,
        pinned: c.pinned ?? false,
        selectedFileIds: c.selectedFileIds ?? [],
      })),
      activeConversationId: 'demo-1',

      // Chat
      typingConversationIds: [],
      streamingContent: '',
      chatModel: DEFAULT_CHAT_MODEL,
      sessionModelOverridden: false,
      pendingReferenceImage: null,

      // View / sidebar actions
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setActiveView: (view: MainView) => set({ activeView: view }),
      setResourcesSidebarOpen: (open: boolean) =>
        set({ resourcesSidebarOpen: open }),
      toggleResourcesSidebar: () =>
        set((state) => ({ resourcesSidebarOpen: !state.resourcesSidebarOpen })),
      setResourcesSidebarTab: (tab) => set({ resourcesSidebarTab: tab }),
      setTasksPanelOpen: (open: boolean) => set({ tasksPanelOpen: open }),
      toggleTasksPanel: () =>
        set((state) => ({ tasksPanelOpen: !state.tasksPanelOpen })),
      setSidebarWidth: (width: number) =>
        set({ sidebarWidth: clampSidebarWidth(width) }),
      setResourcesSidebarWidth: (width: number) =>
        set({ resourcesSidebarWidth: clampResourcesSidebarWidth(width) }),
      setEditorPref: (key, value) =>
        set((state) => ({
          editorPrefs: { ...state.editorPrefs, [key]: value },
        })),
      pinExplanation: (input) => {
        const pin: PinnedExplanation = {
          id: uuid(),
          conversationId: input.conversationId,
          selection: input.selection,
          content: input.content,
          model: input.model,
          results: input.results,
          createdAt: Date.now(),
        }
        set((state) => ({ pinnedExplanations: [pin, ...state.pinnedExplanations] }))
        return pin
      },
      unpinExplanation: (id) =>
        set((state) => ({
          pinnedExplanations: state.pinnedExplanations.filter((p) => p.id !== id),
        })),
      clearPinnedExplanationsForConversation: (conversationId) =>
        set((state) => ({
          pinnedExplanations: state.pinnedExplanations.filter(
            (p) => p.conversationId !== conversationId
          ),
        })),
      fireSelectionAction: (action) => set({ pendingSelectionAction: action }),
      clearSelectionAction: () => set({ pendingSelectionAction: null }),
      setLocalOnlyMode: (value) => set({ localOnlyMode: value }),
      setLocalFilesOnly: (value) => set({ localFilesOnly: value }),

      // Workspace actions
      createWorkspace: (name: string) => {
        const newWorkspace: Workspace = {
          id: uuid(),
          name,
          createdAt: new Date(),
          updatedAt: new Date(),
          // Goes to the front of the list — position 0 — and the existing
          // workspaces shift by 1. Single update so the diff fires once.
          position: 0,
        }
        set((state) => ({
          workspaces: [
            newWorkspace,
            ...state.workspaces.map((w, i) => ({ ...w, position: i + 1 })),
          ],
        }))
        return newWorkspace
      },
      reorderWorkspaces: (orderedIds: string[]) =>
        set((state) => {
          const byId = new Map(state.workspaces.map((w) => [w.id, w]))
          const reordered: Workspace[] = []
          for (const id of orderedIds) {
            const w = byId.get(id)
            if (w) {
              reordered.push(w)
              byId.delete(id)
            }
          }
          // Append any workspaces not mentioned by the caller (defensive
          // against partial id lists).
          for (const w of byId.values()) reordered.push(w)
          // Stamp positions so the cross-device sync can reproduce the
          // order. Bump updatedAt too so the diff fires the upsert
          // (position alone would still be picked up via workspaceEquals,
          // but bumping updatedAt keeps "last touched" honest).
          const now = new Date()
          return {
            workspaces: reordered.map((w, i) =>
              w.position === i ? w : { ...w, position: i, updatedAt: now }
            ),
          }
        }),
      deleteWorkspace: (workspaceId: string) =>
        set((state) => {
          if (state.workspaces.length <= 1) return state // Prevent deleting last workspace
          const newWorkspaces = state.workspaces.filter((w) => w.id !== workspaceId)
          const newActiveWorkspaceId = state.activeWorkspaceId === workspaceId
            ? newWorkspaces[0]?.id
            : state.activeWorkspaceId
          // Cascade: drop resources, conversations, notes, artifacts, and
          // documents that belonged to the workspace.
          const newResources = state.resources.filter((r) => r.workspaceId !== workspaceId)
          const newConversations = state.conversations.filter((c) => c.workspaceId !== workspaceId)
          const newNotes = state.notes.filter((n) => n.workspaceId !== workspaceId)
          const newArtifacts = state.artifacts.filter((a) => a.workspaceId !== workspaceId)
          const newDocuments = state.documents.filter((d) => d.workspaceId !== workspaceId)
          // Drop conversation-private joins whose conversation lived in
          // this workspace, then GC files that lost their last reference.
          // `gcOrphanedAttachments` does the ref-count + tombstone logic;
          // its internal dedup stops it from running twice on the same
          // file id when multiple deleted conversations had it privately
          // attached.
          //
          // Two sources of orphan candidates:
          //   1. Files attached to a deleted conversation via the
          //      private `conversationFiles` join.
          //   2. Files held in the workspace library via a `resources`
          //      row in the deleted workspace. Without these, a file
          //      attached *only* via the workspace library (no private
          //      join) would leak as an untombstoned row after its
          //      workspace went away.
          const droppedConvIds = new Set(
            state.conversations
              .filter((c) => c.workspaceId === workspaceId)
              .map((c) => c.id)
          )
          const droppedFileRefs: AttachmentRef[] = [
            ...state.conversationFiles
              .filter((cf) => droppedConvIds.has(cf.conversationId))
              .map((cf) => ({ kind: 'file' as const, id: cf.fileId })),
            ...state.resources
              .filter((r) => r.workspaceId === workspaceId)
              .map((r) => ({ kind: 'file' as const, id: r.fileId })),
          ]
          const newConversationFiles = state.conversationFiles.filter(
            (cf) => !droppedConvIds.has(cf.conversationId)
          )
          // If the active doc lived in the deleted workspace, swap to the
          // most-recently-updated doc in the new active workspace (if any).
          let newActiveDocumentId = state.activeDocumentId
          if (
            state.activeDocumentId &&
            !newDocuments.some((d) => d.id === state.activeDocumentId)
          ) {
            const fallback = newDocuments
              .filter((d) => d.workspaceId === newActiveWorkspaceId)
              .sort(
                (a, b) =>
                  new Date(b.updatedAt).getTime() -
                  new Date(a.updatedAt).getTime()
              )[0]
            newActiveDocumentId = fallback?.id ?? null
          }
          // MCP cascade: tombstone every server in the workspace, then
          // tombstone their resources via `bulkTombstoneByKind`, drop
          // matching bindings and conversation joins. The metadata
          // stubs (server, resource) remain so historic message
          // references stay resolvable.
          const droppedServerIds = new Set(
            state.mcpServers
              .filter((s) => s.workspaceId === workspaceId && !s.deletedAt)
              .map((s) => s.id)
          )
          const droppedResourceIds = new Set(
            state.mcpResources
              .filter((r) => droppedServerIds.has(r.serverId) && !r.deletedAt)
              .map((r) => r.id)
          )
          const newMcpServers = state.mcpServers.map((s) =>
            droppedServerIds.has(s.id) ? tombstoneMcpServer(s) : s
          )
          const mcpTombstones = bulkTombstoneByKind(state, 'mcp_resource', droppedResourceIds)
          const newMcpBindings = state.mcpResourceBindings.filter(
            (b) => !droppedResourceIds.has(b.resourceId)
          )
          const newConvMcpResources = state.conversationMcpResources.filter(
            (cmr) => !droppedResourceIds.has(cmr.resourceId)
          )
          // URL bookmarks cascade — same shape as MCP. Selection ids on
          // the (now-deleted) conversations don't need stripping since
          // the conversations themselves are gone.
          const droppedBookmarkIds = new Set(
            state.urlBookmarks
              .filter((b) => b.workspaceId === workspaceId && !b.deletedAt)
              .map((b) => b.id)
          )
          const urlTombstones = bulkTombstoneByKind(state, 'url_bookmark', droppedBookmarkIds)
          const newConvUrlBookmarks = state.conversationUrlBookmarks.filter(
            (cub) => !droppedBookmarkIds.has(cub.bookmarkId)
          )
          const patch: Partial<AppState> = {
            workspaces: newWorkspaces,
            activeWorkspaceId: newActiveWorkspaceId,
            resources: newResources,
            conversations: newConversations,
            conversationFiles: newConversationFiles,
            notes: newNotes,
            artifacts: newArtifacts,
            documents: newDocuments,
            activeDocumentId: newActiveDocumentId,
            mcpServers: newMcpServers,
            mcpResourceBindings: newMcpBindings,
            conversationMcpResources: newConvMcpResources,
            conversationUrlBookmarks: newConvUrlBookmarks,
            ...mcpTombstones,
            ...urlTombstones,
          }
          // GC files whose last private-join reference lived on a
          // conversation in the deleted workspace.
          return {
            ...patch,
            ...gcOrphanedAttachments({ ...state, ...patch }, droppedFileRefs),
          }
        }),
      renameWorkspace: (workspaceId: string, name: string) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, name, updatedAt: new Date() } : w
          ),
        })),
      setWorkspaceSystemPrompt: (workspaceId: string, prompt: string) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) =>
            w.id === workspaceId
              ? { ...w, systemPrompt: prompt, updatedAt: new Date() }
              : w
          ),
        })),
      setWorkspaceProjectConfig: (workspaceId, patch) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            const next = { ...w, updatedAt: new Date() }
            if ("isProject" in patch) next.isProject = patch.isProject
            if ("goal" in patch) next.goal = patch.goal
            if ("milestones" in patch) next.milestones = patch.milestones
            return next
          }),
        })),
      setWorkspaceDefaultModel: (workspaceId: string, modelId: string) =>
        set((state) => {
          const trimmed = modelId.trim()
          const value = trimmed.length === 0 ? undefined : trimmed
          const isActive = state.activeWorkspaceId === workspaceId
          return {
            workspaces: state.workspaces.map((w) =>
              w.id === workspaceId
                ? { ...w, defaultModel: value, updatedAt: new Date() }
                : w
            ),
            // Apply immediately when the user pins a default on the *current*
            // workspace AND hasn't manually overridden the session model. The
            // intent is "from now on, this workspace = this model" — waiting
            // until the next workspace switch to apply would feel inert.
            chatModel:
              isActive && value && !state.sessionModelOverridden
                ? value
                : state.chatModel,
          }
        }),
      setWorkspaceSkillPref: (workspaceId, skillId, value) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            const current = w.skillPrefs ?? {}
            const next: Record<string, boolean> = { ...current }
            if (value === null) delete next[skillId]
            else next[skillId] = value
            return { ...w, skillPrefs: next, updatedAt: new Date() }
          }),
        })),
      patchWorkspaceWebSearchConfig: (workspaceId, patch) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            if (patch === null) {
              const { webSearchConfig: _drop, ...rest } = w
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeWebSearchConfig(w.webSearchConfig, patch)
            return { ...w, webSearchConfig: merged, updatedAt: new Date() }
          }),
        })),
      patchWorkspaceWebFetchConfig: (workspaceId, patch) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            if (patch === null) {
              const { webFetchConfig: _drop, ...rest } = w
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeWebFetchConfig(w.webFetchConfig, patch)
            return { ...w, webFetchConfig: merged, updatedAt: new Date() }
          }),
        })),
      patchWorkspaceImageGenConfig: (workspaceId, patch) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            if (patch === null) {
              const { imageGenConfig: _drop, ...rest } = w
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeImageGenConfig(w.imageGenConfig, patch)
            return { ...w, imageGenConfig: merged, updatedAt: new Date() }
          }),
        })),
      patchWorkspaceFileSearchConfig: (workspaceId, patch) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            if (patch === null) {
              const { fileSearchConfig: _drop, ...rest } = w
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeFileSearchConfig(w.fileSearchConfig, patch)
            return { ...w, fileSearchConfig: merged, updatedAt: new Date() }
          }),
        })),
      setWorkspaceCanvasState: (workspaceId, canvasState) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) => {
            if (w.id !== workspaceId) return w
            if (canvasState === null) {
              const { canvasState: _drop, ...rest } = w
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            return { ...w, canvasState, updatedAt: new Date() }
          }),
        })),
      setActiveWorkspace: (workspaceId: string) =>
        set((state) => {
          if (workspaceId === state.activeWorkspaceId) {
            return { activeWorkspaceId: workspaceId }
          }
          const next = state.workspaces.find((w) => w.id === workspaceId)
          const pinned = next?.defaultModel
          // Pick the new workspace's most-recently-updated doc as the
          // active one so the editor opens to something familiar.
          // Falls through to null when the workspace has no docs yet.
          const nextDoc = state.documents
            .filter((d) => d.workspaceId === workspaceId)
            .sort(
              (a, b) =>
                new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
            )[0]
          return {
            activeWorkspaceId: workspaceId,
            activeDocumentId: nextDoc?.id ?? null,
            // Apply the new workspace's pinned model (or keep the current
            // one if it doesn't have a pin). Crossing into a new workspace
            // resets the session-override flag — picking a model in the
            // previous workspace was per-that-workspace intent.
            chatModel: pinned ?? state.chatModel,
            sessionModelOverridden: false,
          }
        }),

      // Resource actions
      addResource: (workspaceId: string, fileId: string) => {
        const newResource: Resource = {
          id: uuid(),
          workspaceId,
          fileId,
          addedAt: new Date(),
        }
        set((state) => ({
          resources: [...state.resources, newResource],
        }))
      },
      removeResource: (resourceId: string) =>
        set((state) => {
          const target = state.resources.find((r) => r.id === resourceId)
          const newResources = state.resources.filter((r) => r.id !== resourceId)
          if (!target) return { resources: newResources }
          // Strip the fileId from every conversation's selection — once the
          // resource is gone the workspace-library tick no longer makes sense.
          const newConversations = state.conversations.map((c) =>
            c.selectedFileIds.includes(target.fileId)
              ? {
                  ...c,
                  selectedFileIds: c.selectedFileIds.filter((id) => id !== target.fileId),
                }
              : c
          )
          const orphanPatch = gcOrphanedAttachment(
            { ...state, resources: newResources, conversations: newConversations },
            { kind: 'file', id: target.fileId }
          )
          return { resources: newResources, conversations: newConversations, ...orphanPatch }
        }),

      // Conversation-private file actions
      addConversationFile: (conversationId: string, fileId: string) =>
        set((state) => {
          // Idempotent: don't add a second join row for the same pair.
          if (
            state.conversationFiles.some(
              (cf) => cf.conversationId === conversationId && cf.fileId === fileId
            )
          ) {
            return state
          }
          const newJoin: ConversationFile = {
            id: uuid(),
            conversationId,
            fileId,
            addedAt: new Date(),
          }
          return {
            conversationFiles: [...state.conversationFiles, newJoin],
          }
        }),
      removeConversationFile: (conversationId: string, fileId: string) =>
        set((state) => {
          const newConversationFiles = state.conversationFiles.filter(
            (cf) => !(cf.conversationId === conversationId && cf.fileId === fileId)
          )
          const orphanPatch = gcOrphanedAttachment(
            { ...state, conversationFiles: newConversationFiles },
            { kind: 'file', id: fileId }
          )
          return { conversationFiles: newConversationFiles, ...orphanPatch }
        }),

      // MCP server actions
      addMcpServer: ({ workspaceId, name, url, credentialMode, credentialFingerprint, enabled = true }) => {
        const now = new Date()
        const newServer: McpServer = {
          id: uuid(),
          workspaceId,
          name,
          url,
          transport: 'http',
          credentialMode,
          credentialFingerprint,
          enabled,
          createdAt: now,
          updatedAt: now,
        }
        set((state) => ({ mcpServers: [...state.mcpServers, newServer] }))
        return newServer
      },
      updateMcpServer: (serverId, patch) =>
        set((state) => ({
          mcpServers: state.mcpServers.map((s) =>
            s.id === serverId && !s.deletedAt
              ? { ...s, ...patch, updatedAt: new Date() }
              : s
          ),
        })),
      setMcpServerCapabilities: (serverId, capabilities) =>
        set((state) => ({
          mcpServers: state.mcpServers.map((s) =>
            s.id === serverId && !s.deletedAt
              ? {
                  ...s,
                  capabilities,
                  capabilitiesFetchedAt: new Date(),
                  updatedAt: new Date(),
                }
              : s
          ),
        })),
      setMcpServerEnabled: (serverId, enabled) =>
        set((state) => ({
          mcpServers: state.mcpServers.map((s) =>
            s.id === serverId && !s.deletedAt
              ? { ...s, enabled, updatedAt: new Date() }
              : s
          ),
        })),
      removeMcpServer: (serverId) =>
        set((state) => {
          // Atomic cascade: tombstone the server, drop every dependent
          // row (resources, bindings, conversation joins, selection ids).
          // Resources cascade-tombstone too — their addressing depends on
          // the server existing.
          const droppedResourceIds = new Set(
            state.mcpResources
              .filter((r) => r.serverId === serverId && !r.deletedAt)
              .map((r) => r.id)
          )
          return {
            mcpServers: state.mcpServers.map((s) =>
              s.id === serverId && !s.deletedAt ? tombstoneMcpServer(s) : s
            ),
            mcpResources: state.mcpResources.map((r) =>
              droppedResourceIds.has(r.id) ? tombstoneMcpResource(r) : r
            ),
            mcpResourceBindings: state.mcpResourceBindings.filter(
              (b) => !droppedResourceIds.has(b.resourceId)
            ),
            conversationMcpResources: state.conversationMcpResources.filter(
              (cmr) => !droppedResourceIds.has(cmr.resourceId)
            ),
            conversations: state.conversations.map((c) => {
              const selected = c.selectedMcpResourceIds ?? []
              const filtered = selected.filter((id) => !droppedResourceIds.has(id))
              return filtered.length === selected.length
                ? c
                : { ...c, selectedMcpResourceIds: filtered }
            }),
          }
        }),

      // MCP resource actions
      upsertMcpResource: ({ workspaceId, serverId, uri, name, description, mimeType }) => {
        // Idempotent on (serverId, uri): re-discovery shouldn't create
        // duplicate cache rows. Update name/description in place when
        // they change.
        const existing = get().mcpResources.find(
          (r) => r.serverId === serverId && r.uri === uri && !r.deletedAt
        )
        if (existing) {
          set((state) => ({
            mcpResources: state.mcpResources.map((r) =>
              r.id === existing.id
                ? { ...r, name, description, mimeType }
                : r
            ),
          }))
          return { ...existing, name, description, mimeType }
        }
        const newResource: McpResource = {
          id: uuid(),
          workspaceId,
          serverId,
          uri,
          name,
          description,
          mimeType,
          addedAt: new Date(),
        }
        set((state) => ({ mcpResources: [...state.mcpResources, newResource] }))
        return newResource
      },
      addMcpResourceBinding: (workspaceId, resourceId) =>
        set((state) => {
          if (
            state.mcpResourceBindings.some(
              (b) => b.workspaceId === workspaceId && b.resourceId === resourceId
            )
          ) {
            return state
          }
          const newBinding: McpResourceBinding = {
            id: uuid(),
            workspaceId,
            resourceId,
            addedAt: new Date(),
          }
          return {
            mcpResourceBindings: [...state.mcpResourceBindings, newBinding],
          }
        }),
      removeMcpResourceBinding: (bindingId) =>
        set((state) => {
          const target = state.mcpResourceBindings.find((b) => b.id === bindingId)
          if (!target) return state
          const newBindings = state.mcpResourceBindings.filter((b) => b.id !== bindingId)
          // Strip the resource id from every conversation's selection.
          const newConversations = state.conversations.map((c) => {
            const selected = c.selectedMcpResourceIds ?? []
            if (!selected.includes(target.resourceId)) return c
            return {
              ...c,
              selectedMcpResourceIds: selected.filter((id) => id !== target.resourceId),
            }
          })
          const orphanPatch = gcOrphanedAttachment(
            {
              ...state,
              mcpResourceBindings: newBindings,
              conversations: newConversations,
            },
            { kind: 'mcp_resource', id: target.resourceId }
          )
          return {
            mcpResourceBindings: newBindings,
            conversations: newConversations,
            ...orphanPatch,
          }
        }),
      addConversationMcpResource: (conversationId, resourceId) =>
        set((state) => {
          if (
            state.conversationMcpResources.some(
              (cmr) => cmr.conversationId === conversationId && cmr.resourceId === resourceId
            )
          ) {
            return state
          }
          const newJoin: ConversationMcpResource = {
            id: uuid(),
            conversationId,
            resourceId,
            addedAt: new Date(),
          }
          return {
            conversationMcpResources: [...state.conversationMcpResources, newJoin],
          }
        }),
      removeConversationMcpResource: (conversationId, resourceId) =>
        set((state) => {
          const newJoins = state.conversationMcpResources.filter(
            (cmr) => !(cmr.conversationId === conversationId && cmr.resourceId === resourceId)
          )
          const orphanPatch = gcOrphanedAttachment(
            { ...state, conversationMcpResources: newJoins },
            { kind: 'mcp_resource', id: resourceId }
          )
          return { conversationMcpResources: newJoins, ...orphanPatch }
        }),
      toggleConversationMcpResourceSelection: (resourceId) =>
        set((state) => {
          const id = state.activeConversationId
          if (!id) return state
          return {
            conversations: state.conversations.map((c) => {
              if (c.id !== id) return c
              const selected = c.selectedMcpResourceIds ?? []
              return {
                ...c,
                selectedMcpResourceIds: selected.includes(resourceId)
                  ? selected.filter((x) => x !== resourceId)
                  : [...selected, resourceId],
              }
            }),
          }
        }),

      // URL bookmark actions
      addUrlBookmark: ({
        workspaceId,
        url,
        title,
        content,
        contentTruncated,
        contentHash,
        description,
        faviconUrl,
      }) => {
        const now = new Date()
        const newBookmark: UrlBookmark = {
          id: uuid(),
          workspaceId,
          url,
          title,
          content,
          contentTruncated,
          fetchedAt: now,
          contentHash,
          description,
          faviconUrl,
          createdAt: now,
          updatedAt: now,
        }
        set((state) => ({ urlBookmarks: [...state.urlBookmarks, newBookmark] }))
        return newBookmark
      },
      updateUrlBookmark: (bookmarkId, patch) =>
        set((state) => ({
          urlBookmarks: state.urlBookmarks.map((b) =>
            b.id === bookmarkId && !b.deletedAt
              ? {
                  ...b,
                  ...patch,
                  fetchedAt: new Date(),
                  updatedAt: new Date(),
                }
              : b
          ),
        })),
      removeUrlBookmark: (bookmarkId) =>
        set((state) => ({
          urlBookmarks: state.urlBookmarks.map((b) =>
            b.id === bookmarkId && !b.deletedAt ? tombstoneUrlBookmark(b) : b
          ),
          // Atomic cascade: drop join rows and selection ids that
          // reference the bookmark.
          conversationUrlBookmarks: state.conversationUrlBookmarks.filter(
            (cub) => cub.bookmarkId !== bookmarkId
          ),
          conversations: state.conversations.map((c) => {
            const selected = c.selectedUrlBookmarkIds ?? []
            const filtered = selected.filter((id) => id !== bookmarkId)
            return filtered.length === selected.length
              ? c
              : { ...c, selectedUrlBookmarkIds: filtered }
          }),
        })),
      addConversationUrlBookmark: (conversationId, bookmarkId) =>
        set((state) => {
          if (
            state.conversationUrlBookmarks.some(
              (cub) =>
                cub.conversationId === conversationId &&
                cub.bookmarkId === bookmarkId
            )
          ) {
            return state
          }
          const newJoin: ConversationUrlBookmark = {
            id: uuid(),
            conversationId,
            bookmarkId,
            addedAt: new Date(),
          }
          return {
            conversationUrlBookmarks: [
              ...state.conversationUrlBookmarks,
              newJoin,
            ],
          }
        }),
      removeConversationUrlBookmark: (conversationId, bookmarkId) =>
        set((state) => {
          const newJoins = state.conversationUrlBookmarks.filter(
            (cub) =>
              !(
                cub.conversationId === conversationId &&
                cub.bookmarkId === bookmarkId
              )
          )
          const orphanPatch = gcOrphanedAttachment(
            { ...state, conversationUrlBookmarks: newJoins },
            { kind: 'url_bookmark', id: bookmarkId }
          )
          return { conversationUrlBookmarks: newJoins, ...orphanPatch }
        }),
      toggleConversationUrlBookmarkSelection: (bookmarkId) =>
        set((state) => {
          const id = state.activeConversationId
          if (!id) return state
          return {
            conversations: state.conversations.map((c) => {
              if (c.id !== id) return c
              const selected = c.selectedUrlBookmarkIds ?? []
              return {
                ...c,
                selectedUrlBookmarkIds: selected.includes(bookmarkId)
                  ? selected.filter((x) => x !== bookmarkId)
                  : [...selected, bookmarkId],
              }
            }),
          }
        }),

      // Notes actions
      createNote: ({ conversationId, messageId = null, body = '' }) => {
        const conv = conversationId
          ? get().conversations.find((c) => c.id === conversationId)
          : undefined
        const workspaceId = conv?.workspaceId ?? get().activeWorkspaceId
        const now = new Date()
        const newNote: Note = {
          id: uuid(),
          workspaceId,
          conversationId,
          messageId,
          body,
          createdAt: now,
          updatedAt: now,
        }
        set((state) => ({ notes: [newNote, ...state.notes] }))
        return newNote
      },
      updateNoteBody: (noteId: string, body: string) =>
        set((state) => ({
          notes: state.notes.map((n) =>
            n.id === noteId ? { ...n, body, updatedAt: new Date() } : n
          ),
        })),
      deleteNote: (noteId: string) =>
        set((state) => ({
          notes: state.notes.filter((n) => n.id !== noteId),
        })),
      toggleMessageBookmark: (conversationId: string, messageId: string) => {
        const existing = get().notes.find(
          (n) => n.conversationId === conversationId && n.messageId === messageId
        )
        if (existing) {
          set((state) => ({
            notes: state.notes.filter((n) => n.id !== existing.id),
          }))
          return null
        }
        const conv = get().conversations.find((c) => c.id === conversationId)
        const workspaceId = conv?.workspaceId ?? get().activeWorkspaceId
        const now = new Date()
        const newNote: Note = {
          id: uuid(),
          workspaceId,
          conversationId,
          messageId,
          body: '',
          createdAt: now,
          updatedAt: now,
        }
        set((state) => ({ notes: [newNote, ...state.notes] }))
        return newNote
      },

      // Artifacts actions
      createArtifact: ({ conversationId, messageId = null, kind, language = null, title, content, storagePath = null }) => {
        const fallbackTitle =
          title ?? content.split('\n')[0].slice(0, 60).trim() ?? 'Untitled'
        const conv = get().conversations.find((c) => c.id === conversationId)
        const workspaceId = conv?.workspaceId ?? get().activeWorkspaceId
        const newArtifact: Artifact = {
          id: uuid(),
          workspaceId,
          conversationId,
          messageId,
          kind,
          language,
          title: fallbackTitle || 'Untitled',
          content,
          storagePath,
          pinned: false,
          createdAt: new Date(),
        }
        set((state) => ({ artifacts: [newArtifact, ...state.artifacts] }))
        return newArtifact
      },
      deleteArtifact: (artifactId: string) =>
        set((state) => ({
          artifacts: state.artifacts.filter((a) => a.id !== artifactId),
        })),
      togglePinArtifact: (artifactId: string) =>
        set((state) => ({
          artifacts: state.artifacts.map((a) =>
            a.id === artifactId ? { ...a, pinned: !a.pinned } : a
          ),
        })),
      updateArtifactTitle: (artifactId: string, title: string) =>
        set((state) => ({
          artifacts: state.artifacts.map((a) =>
            a.id === artifactId ? { ...a, title } : a
          ),
        })),
      requestEditorReload: () =>
        set((state) => ({ editorReloadToken: state.editorReloadToken + 1 })),

      // Prompt actions
      createPrompt: ({ workspaceId, name, template, slug }) => {
        const now = new Date()
        const baseSlug = slug?.trim() || defaultSlug(name)
        const uniqueSlug = ensureUniquePromptSlug(
          baseSlug,
          get().prompts.filter(p => p.workspaceId === workspaceId)
        )
        const prompt: Prompt = {
          id: nanoid(),
          workspaceId,
          name: name.trim(),
          slug: uniqueSlug,
          template,
          variables: parseTemplate(template).variables,
          createdAt: now,
          updatedAt: now,
        }
        set((state) => ({ prompts: [...state.prompts, prompt] }))
        return prompt
      },
      updatePrompt: (promptId, patch) =>
        set((state) => ({
          prompts: state.prompts.map((p) => {
            if (p.id !== promptId) return p
            const nextName = patch.name?.trim() ?? p.name
            const nextTemplate = patch.template ?? p.template
            // Slug rules:
            //   - Explicit slug in patch wins (after slug-collision check).
            //   - Otherwise keep the existing slug stable across renames.
            //     (Auto-rederiving from name would break muscle memory once
            //     Phase 3 slash triggers ship.)
            let nextSlug = p.slug
            if (patch.slug !== undefined) {
              const requested = patch.slug.trim() || defaultSlug(nextName)
              nextSlug = ensureUniquePromptSlug(
                requested,
                state.prompts,
                p.id
              )
            }
            return {
              ...p,
              name: nextName,
              slug: nextSlug,
              template: nextTemplate,
              variables: parseTemplate(nextTemplate).variables,
              updatedAt: new Date(),
            }
          }),
        })),
      deletePrompt: (promptId) =>
        set((state) => ({
          prompts: state.prompts.map((p) =>
            p.id === promptId
              ? { ...p, deletedAt: new Date(), updatedAt: new Date() }
              : p
          ),
        })),
      restorePrompt: (promptId) =>
        set((state) => ({
          prompts: state.prompts.map((p) =>
            p.id === promptId
              ? { ...p, deletedAt: undefined, updatedAt: new Date() }
              : p
          ),
        })),

      setPendingChatInput: (value) => set({ pendingChatInput: value }),

      // File actions
      addFile: (file: UploadedFile) =>
        set((state) => ({ files: [...state.files, file] })),
      removeFile: (fileId: string) => {
        // Fire-and-forget — IDB delete is best-effort and shouldn't block
        // the UI update. The metadata row stays (tombstoned) so future
        // references — message `attachedFileIds`, notes, citations —
        // resolve to a "removed" label instead of dangling.
        void deleteLocalBlob(fileId)
        set((state) => ({
          files: state.files.map((f) =>
            f.id === fileId && !f.deletedAt ? tombstoneFile(f) : f
          ),
          // Atomic cascade: drop every live join row that references this
          // file. The metadata stub remains for historical references but
          // join rows shouldn't claim the file is still attached.
          resources: state.resources.filter((r) => r.fileId !== fileId),
          conversationFiles: state.conversationFiles.filter(
            (cf) => cf.fileId !== fileId
          ),
          conversations: state.conversations.map((c) =>
            c.selectedFileIds.includes(fileId)
              ? { ...c, selectedFileIds: c.selectedFileIds.filter((id) => id !== fileId) }
              : c
          ),
        }))
      },
      clearFiles: () => {
        void clearLocalBlobs()
        set((state) => ({
          files: state.files.map((f) => (f.deletedAt ? f : tombstoneFile(f))),
          resources: [],
          conversationFiles: [],
          conversations: state.conversations.map((c) =>
            c.selectedFileIds.length > 0 ? { ...c, selectedFileIds: [] } : c
          ),
        }))
      },
      setFileExtraction: (fileId, patch) =>
        set((state) => ({
          files: state.files.map((f) =>
            f.id === fileId ? { ...f, ...patch } : f
          ),
        })),
      setFileStorage: (fileId, patch) =>
        set((state) => ({
          files: state.files.map((f) =>
            f.id === fileId
              ? {
                  ...f,
                  ...(patch.storagePath !== undefined
                    ? { storagePath: patch.storagePath ?? undefined }
                    : {}),
                }
              : f
          ),
        })),

      // Conversation actions
      createConversation: (workspaceId?: string) => {
        const activeWorkspaceId = workspaceId || get().activeWorkspaceId
        const newConversation: Conversation = {
          id: uuid(),
          workspaceId: activeWorkspaceId,
          title: `New Chat ${get().conversations.filter(c => c.workspaceId === activeWorkspaceId).length + 1}`,
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          pinned: false,
          selectedFileIds: [],
        }
        set((state) => ({
          conversations: [newConversation, ...state.conversations],
          activeConversationId: newConversation.id,
        }))
        return newConversation
      },
      forkConversation: (conversationId, untilMessageId) => {
        const source = get().conversations.find((c) => c.id === conversationId)
        if (!source) return null
        const idx = source.messages.findIndex((m) => m.id === untilMessageId)
        if (idx === -1) return null
        const slice = source.messages.slice(0, idx + 1)
        // Re-id messages so edits to either branch don't bleed across.
        // Keep timestamps + content + reasoning + attachments intact so
        // the fork reads as a faithful copy of the past.
        const copiedMessages: Message[] = slice.map((m) => ({
          ...m,
          id: uuid(),
        }))
        const fork: Conversation = {
          id: uuid(),
          workspaceId: source.workspaceId,
          title: `${source.title} (branch)`,
          messages: copiedMessages,
          createdAt: new Date(),
          updatedAt: new Date(),
          pinned: false,
          ...cloneAttachmentSelections(source),
          skillPrefs: source.skillPrefs ? { ...source.skillPrefs } : undefined,
          parentId: source.id,
          forkedFromMessageId: untilMessageId,
        }
        set((state) => {
          // Inherit the source's conversation-private joins onto the
          // fork. Single helper covers all three lanes; the underlying
          // entities (files / MCP resources / URL bookmarks) are
          // shared via their existing ids.
          const inherited = forkConversationJoins(state, source.id, fork.id, uuid)
          return {
            conversations: [fork, ...state.conversations],
            conversationFiles: [...state.conversationFiles, ...inherited.conversationFiles],
            conversationMcpResources: [
              ...state.conversationMcpResources,
              ...inherited.conversationMcpResources,
            ],
            conversationUrlBookmarks: [
              ...state.conversationUrlBookmarks,
              ...inherited.conversationUrlBookmarks,
            ],
            activeConversationId: fork.id,
          }
        })
        return fork
      },
      deleteConversation: (conversationId: string) =>
        set((state) => {
          const newConversations = state.conversations.filter(
            (c) => c.id !== conversationId
          )
          // Drop every conversation-private join for this conversation
          // across all three lanes. Pre-collect the (kind, id) refs
          // that were orphaned so we can GC them after the join arrays
          // shrink.
          const droppedFileRefs: AttachmentRef[] = state.conversationFiles
            .filter((cf) => cf.conversationId === conversationId)
            .map((cf) => ({ kind: 'file' as const, id: cf.fileId }))
          const droppedMcpRefs: AttachmentRef[] = state.conversationMcpResources
            .filter((cmr) => cmr.conversationId === conversationId)
            .map((cmr) => ({ kind: 'mcp_resource' as const, id: cmr.resourceId }))
          const droppedUrlRefs: AttachmentRef[] = state.conversationUrlBookmarks
            .filter((cub) => cub.conversationId === conversationId)
            .map((cub) => ({ kind: 'url_bookmark' as const, id: cub.bookmarkId }))

          const remainingFileJoins = state.conversationFiles.filter(
            (cf) => cf.conversationId !== conversationId
          )
          const remainingMcpJoins = state.conversationMcpResources.filter(
            (cmr) => cmr.conversationId !== conversationId
          )
          const remainingUrlJoins = state.conversationUrlBookmarks.filter(
            (cub) => cub.conversationId !== conversationId
          )

          // Notes/artifacts are workspace-scoped, but bookmarks (notes with
          // messageId !== null) anchor to a specific message that no longer
          // exists once the conversation is gone — drop those. Free-form
          // notes and all artifacts are orphaned (conversationId → null) so
          // they remain visible at the workspace level.
          const newNotes = state.notes
            .filter(
              (n) => !(n.conversationId === conversationId && n.messageId !== null)
            )
            .map((n) =>
              n.conversationId === conversationId ? { ...n, conversationId: null } : n
            )
          const newArtifacts = state.artifacts.map((a) =>
            a.conversationId === conversationId ? { ...a, conversationId: null } : a
          )
          // Pins are session-only and conversation-scoped — drop them
          // when the conversation goes away so we don't keep dangling
          // references that would never render again.
          const newPins = state.pinnedExplanations.filter(
            (p) => p.conversationId !== conversationId
          )

          // GC each orphaned attachment against the post-drop state.
          // De-dup refs (a workspace file referenced by multiple
          // conversation joins shouldn't get tombstoned twice).
          const patch: Partial<AppState> = {
            conversations: newConversations,
            conversationFiles: remainingFileJoins,
            conversationMcpResources: remainingMcpJoins,
            conversationUrlBookmarks: remainingUrlJoins,
            notes: newNotes,
            artifacts: newArtifacts,
            pinnedExplanations: newPins,
            activeConversationId:
              state.activeConversationId === conversationId
                ? newConversations[0]?.id || null
                : state.activeConversationId,
          }
          return {
            ...patch,
            ...gcOrphanedAttachments({ ...state, ...patch }, [
              ...droppedFileRefs,
              ...droppedMcpRefs,
              ...droppedUrlRefs,
            ]),
          }
        }),
      renameConversation: (conversationId: string, title: string) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, title, updatedAt: new Date() } : c
          ),
        })),
      setConversationSkillPref: (conversationId, skillId, value) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            const current = c.skillPrefs ?? {}
            const next: Record<string, boolean> = { ...current }
            if (value === null) delete next[skillId]
            else next[skillId] = value
            return { ...c, skillPrefs: next, updatedAt: new Date() }
          }),
        })),
      patchConversationWebSearchConfig: (conversationId, patch) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            if (patch === null) {
              const { webSearchConfig: _drop, ...rest } = c
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeWebSearchConfig(c.webSearchConfig, patch)
            return { ...c, webSearchConfig: merged, updatedAt: new Date() }
          }),
        })),
      patchConversationWebFetchConfig: (conversationId, patch) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            if (patch === null) {
              const { webFetchConfig: _drop, ...rest } = c
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeWebFetchConfig(c.webFetchConfig, patch)
            return { ...c, webFetchConfig: merged, updatedAt: new Date() }
          }),
        })),
      patchConversationImageGenConfig: (conversationId, patch) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            if (patch === null) {
              const { imageGenConfig: _drop, ...rest } = c
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeImageGenConfig(c.imageGenConfig, patch)
            return { ...c, imageGenConfig: merged, updatedAt: new Date() }
          }),
        })),
      patchConversationFileSearchConfig: (conversationId, patch) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            if (patch === null) {
              const { fileSearchConfig: _drop, ...rest } = c
              void _drop
              return { ...rest, updatedAt: new Date() }
            }
            const merged = mergeFileSearchConfig(c.fileSearchConfig, patch)
            return { ...c, fileSearchConfig: merged, updatedAt: new Date() }
          }),
        })),
      togglePin: (conversationId: string) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, pinned: !c.pinned } : c
          ),
        })),
      toggleConversationFileSelection: (fileId: string) =>
        set((state) => {
          const id = state.activeConversationId
          if (!id) return state
          return {
            conversations: state.conversations.map((c) =>
              c.id === id
                ? {
                    ...c,
                    selectedFileIds: c.selectedFileIds.includes(fileId)
                      ? c.selectedFileIds.filter((x) => x !== fileId)
                      : [...c.selectedFileIds, fileId],
                  }
                : c
            ),
          }
        }),
      clearConversationFileSelection: () =>
        set((state) => {
          const id = state.activeConversationId
          if (!id) return state
          return {
            conversations: state.conversations.map((c) =>
              c.id === id ? { ...c, selectedFileIds: [] } : c
            ),
          }
        }),
      setActiveConversation: (conversationId: string | null) =>
        set({ activeConversationId: conversationId }),

      // Message actions
      addMessage: (
        message: Omit<Message, 'id' | 'timestamp'>,
        conversationId?: string
      ) => {
        const newMessage: Message = {
          ...message,
          id: uuid(),
          timestamp: new Date(),
        }
        set((state) => {
          const targetId = conversationId ?? state.activeConversationId
          if (!targetId) return {}
          const updatedConversations = state.conversations.map((c) => {
            if (c.id === targetId) {
              return {
                ...c,
                messages: [...c.messages, newMessage],
                updatedAt: new Date(),
              }
            }
            return c
          })
          return { conversations: updatedConversations }
        })
        return newMessage
      },
      deleteMessage: (messageId: string) =>
        set((state) => ({
          // Find by messageId across ALL conversations rather than only
          // the active one. Message ids are uuids, so they uniquely
          // identify the owning conversation; filtering on `activeId`
          // here would misfire whenever the user has switched tabs since
          // the message was created — particularly during parallel
          // streams. (Same pattern applied to every other per-message
          // mutator below.)
          conversations: state.conversations.map((c) => {
            if (c.messages.some((m) => m.id === messageId)) {
              return {
                ...c,
                messages: c.messages.filter((m) => m.id !== messageId),
              }
            }
            return c
          }),
          // Detach any bookmarks / artifacts anchored to this message
          // (mirrors the `on delete set null` from the Supabase schema).
          notes: state.notes.map((n) =>
            n.messageId === messageId ? { ...n, messageId: null } : n
          ),
          artifacts: state.artifacts.map((a) =>
            a.messageId === messageId ? { ...a, messageId: null } : a
          ),
        })),
      updateMessage: (messageId: string, content: string) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.messages.some((m) => m.id === messageId)) {
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === messageId ? { ...m, content } : m
                ),
              }
            }
            return c
          }),
        })),
      truncateMessagesAfter: (messageId: string, inclusive: boolean = false) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            const idx = c.messages.findIndex((m) => m.id === messageId)
            if (idx === -1) return c
            const endExclusive = inclusive ? idx : idx + 1
            return { ...c, messages: c.messages.slice(0, endExclusive) }
          }),
        })),
      compressMessages: (
        conversationId: string,
        messageIds: string[],
        recapContent: string
      ) => {
        // The array surgery (insert recap, flag the slice, fold any
        // prior recap so a single Undo restores both spans) lives in
        // the pure `buildCompressedMessages` helper. We assign its
        // result out of the `set` updater so the caller still gets the
        // inserted recap back for scroll/focus.
        const recapId = uuid()
        const now = new Date()
        let recap: Message | null = null
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            const built = buildCompressedMessages(
              c.messages,
              messageIds,
              recapId,
              recapContent,
              now
            )
            if (!built) return c
            recap = built.recap
            return { ...c, messages: built.messages, updatedAt: now }
          }),
        }))
        return recap
      },
      uncompressRecap: (conversationId: string, recapMessageId: string) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            const recap = c.messages.find(
              (m) => m.id === recapMessageId && m.kind === 'recap'
            )
            if (!recap) return c
            const restore = new Set(recap.recapMessageIds ?? [])
            return {
              ...c,
              messages: c.messages
                .filter((m) => m.id !== recapMessageId)
                .map((m) =>
                  restore.has(m.id) ? { ...m, compressed: false } : m
                ),
              updatedAt: new Date(),
            }
          }),
        })),
      clearMessages: () =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id === state.activeConversationId) {
              return { ...c, messages: [] }
            }
            return c
          }),
        })),
      setConversationTyping: (conversationId: string, typing: boolean) =>
        set((state) => {
          const has = state.typingConversationIds.includes(conversationId)
          if (typing && has) return {}
          if (!typing && !has) return {}
          return {
            typingConversationIds: typing
              ? [...state.typingConversationIds, conversationId]
              : state.typingConversationIds.filter((id) => id !== conversationId),
          }
        }),
      setPendingReferenceImage: (value) =>
        set({ pendingReferenceImage: value }),
      setStreamingContent: (content: string) => set({ streamingContent: content }),
      setChatModel: (model: string) =>
        set({ chatModel: model, sessionModelOverridden: true }),
      appendToMessage: (messageId: string, chunk: string) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.messages.some((m) => m.id === messageId)) {
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === messageId ? { ...m, content: m.content + chunk } : m
                ),
              }
            }
            return c
          }),
        })),
      appendToMessageReasoning: (messageId: string, chunk: string) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.messages.some((m) => m.id === messageId)) {
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === messageId
                    ? { ...m, reasoning: (m.reasoning ?? '') + chunk }
                    : m
                ),
              }
            }
            return c
          }),
        })),
      setMessageReasoningDuration: (messageId: string, durationMs: number) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.messages.some((m) => m.id === messageId)) {
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === messageId
                    ? { ...m, reasoningDurationMs: durationMs }
                    : m
                ),
              }
            }
            return c
          }),
        })),
      setMessageToolCalls: (messageId, toolCalls) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.messages.some((m) => m.id === messageId)) {
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === messageId
                    ? { ...m, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }
                    : m
                ),
              }
            }
            return c
          }),
        })),
      setMessageSuggestions: (messageId: string, suggestions: string[]) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.messages.some((m) => m.id === messageId)) {
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === messageId ? { ...m, suggestions } : m
                ),
              }
            }
            return c
          }),
        })),
      appendMessageGeneratedImages: (messageId, images) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (!c.messages.some((m) => m.id === messageId)) return c
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId) return m
                const next = [...(m.generatedImages ?? []), ...images]
                return { ...m, generatedImages: next }
              }),
            }
          }),
        })),
      setMessageError: (messageId: string, error: MessageError) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.messages.some((m) => m.id === messageId)) {
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === messageId ? { ...m, error } : m
                ),
              }
            }
            return c
          }),
        })),
      clearMessageError: (messageId: string) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.messages.some((m) => m.id === messageId)) {
              return {
                ...c,
                messages: c.messages.map((m) => {
                  if (m.id !== messageId) return m
                  const { error: _ignored, ...rest } = m
                  void _ignored
                  return rest
                }),
              }
            }
            return c
          }),
        })),

      // Document actions
      createDocument: (workspaceId: string, title?: string) => {
        const now = new Date()
        // Default title: "Untitled" + a disambiguator scoped to the
        // workspace (so the doc list doesn't show three "Untitled"s).
        const existingCount = get().documents.filter(
          (d) => d.workspaceId === workspaceId
        ).length
        const defaultTitle =
          existingCount === 0 ? 'Untitled' : `Untitled ${existingCount + 1}`
        const newDoc: Document = {
          id: uuid(),
          workspaceId,
          title: title?.trim() || defaultTitle,
          content: '',
          position: existingCount,
          createdAt: now,
          updatedAt: now,
        }
        set((state) => ({
          documents: [newDoc, ...state.documents],
        }))
        return newDoc
      },
      deleteDocument: (documentId: string) =>
        set((state) => {
          const newDocuments = state.documents.filter((d) => d.id !== documentId)
          // If the active doc was the one deleted, swap to the next most-
          // recently-updated doc in the same workspace (or null).
          let newActiveDocumentId = state.activeDocumentId
          if (state.activeDocumentId === documentId) {
            const deleted = state.documents.find((d) => d.id === documentId)
            const wsId = deleted?.workspaceId
            const fallback = newDocuments
              .filter((d) => d.workspaceId === wsId)
              .sort(
                (a, b) =>
                  new Date(b.updatedAt).getTime() -
                  new Date(a.updatedAt).getTime()
              )[0]
            newActiveDocumentId = fallback?.id ?? null
          }
          return {
            documents: newDocuments,
            activeDocumentId: newActiveDocumentId,
          }
        }),
      renameDocument: (documentId: string, title: string) =>
        set((state) => {
          const trimmed = title.trim()
          if (!trimmed) return state
          return {
            documents: state.documents.map((d) =>
              d.id === documentId ? { ...d, title: trimmed, updatedAt: new Date() } : d
            ),
          }
        }),
      setDocumentContent: (documentId: string, content: string) =>
        set((state) => ({
          documents: state.documents.map((d) =>
            d.id === documentId
              ? { ...d, content, updatedAt: new Date() }
              : d
          ),
        })),
      appendToDocument: (documentId: string, fragment: string) =>
        set((state) => ({
          documents: state.documents.map((d) => {
            if (d.id !== documentId) return d
            const trimmedFragment = fragment.trim()
            if (!trimmedFragment) return d
            const existing = (d.content ?? '').trim()
            const next = existing
              ? `${existing}\n\n---\n\n${trimmedFragment}\n`
              : `${trimmedFragment}\n`
            return { ...d, content: next, updatedAt: new Date() }
          }),
        })),
      setActiveDocument: (documentId: string | null) =>
        set({ activeDocumentId: documentId }),
      appendToActiveDocumentOrCreate: (fragment: string) => {
        const trimmed = fragment.trim()
        if (!trimmed) return
        const state = get()
        const targetId =
          state.activeDocumentId ??
          (state.activeWorkspaceId
            ? get().createDocument(state.activeWorkspaceId).id
            : null)
        if (!targetId) return
        if (!state.activeDocumentId) {
          // The doc we just created — make it active so the editor opens
          // to it after the upcoming reload.
          set({ activeDocumentId: targetId })
        }
        get().appendToDocument(targetId, trimmed)
      },

      // Theme actions
      setTheme: (theme: Theme) => set({ theme }),
      toggleTheme: () => {
        const currentTheme = get().theme
        const themes: Theme[] = ['system', 'dark', 'light']
        const currentIndex = themes.indexOf(currentTheme)
        const nextIndex = (currentIndex + 1) % themes.length
        set({ theme: themes[nextIndex] })
      },
      setColorScheme: (scheme: ColorScheme) => set({ colorScheme: scheme }),
    }),
    {
      name: 'hummingbird-storage',
      version: 19,
      migrate: (persistedState, fromVersion) => {
        if (!persistedState || typeof persistedState !== 'object') return persistedState
        const state = persistedState as Record<string, unknown>
        if (fromVersion < 2) {
          const stale = [
            'chatPanelOpen', 'editorPanelOpen', 'resourcesPanelOpen', 'sourcesPanelOpen',
            'chatSessionsPanelOpen', 'workspacePanelOpen',
            'chatSessionsPanelWidth', 'resourcesPanelWidth', 'editorPanelWidth',
            'selectedFileIds',
          ]
          for (const k of stale) delete state[k]
        }
        if (fromVersion < 3) {
          // selectedFileIds moved from useSessionStore onto each Conversation.
          // Backfill an empty array on any persisted conversation missing it.
          const convs = state.conversations
          if (Array.isArray(convs)) {
            state.conversations = convs.map((c) =>
              c && typeof c === 'object' && !('selectedFileIds' in c)
                ? { ...c, selectedFileIds: [] }
                : c
            )
          }
        }
        if (fromVersion < 4) {
          // documentContent / editorContent / documentLastSaved removed from
          // the root state. Each conversation now owns its own documentContent.
          // Copy any legacy global doc into the active conversation so the
          // user's previous editor content is not lost.
          const legacyDoc =
            typeof state.documentContent === 'string' ? state.documentContent : ''
          const activeId = state.activeConversationId
          const convs = state.conversations
          if (Array.isArray(convs)) {
            state.conversations = convs.map((c) => {
              if (!c || typeof c !== 'object') return c
              const conv = c as Record<string, unknown>
              if ('documentContent' in conv) return conv
              return {
                ...conv,
                documentContent: conv.id === activeId ? legacyDoc : '',
              }
            })
          }
          delete state.documentContent
          delete state.documentLastSaved
          delete state.editorContent
        }
        if (fromVersion < 5) {
          // Workspaces gained an optional systemPrompt field — backfill
          // empty so the typed accessors don't hit `undefined` and so the
          // textarea in workspaces.tsx renders cleanly.
          const ws = state.workspaces
          if (Array.isArray(ws)) {
            state.workspaces = ws.map((w) => {
              if (!w || typeof w !== 'object') return w
              const ws = w as Record<string, unknown>
              if ('systemPrompt' in ws) return ws
              return { ...ws, systemPrompt: '' }
            })
          }
        }
        if (fromVersion < 6) {
          // Right resources sidebar gained persisted open/tab state. Seed
          // defaults so the first render after upgrade isn't undefined.
          if (!('resourcesSidebarOpen' in state)) state.resourcesSidebarOpen = true
          if (!('resourcesSidebarTab' in state)) state.resourcesSidebarTab = 'files'
        }
        if (fromVersion < 7) {
          // Local-only mode opt-out toggle. Default OFF so existing users
          // keep cloud sync unchanged unless they explicitly turn it on.
          if (!('localOnlyMode' in state)) state.localOnlyMode = false
        }
        if (fromVersion < 8) {
          // Local-files-only toggle. Default OFF so signed-in users keep
          // Supabase Storage uploads. Storing raw blobs locally is opt-in.
          if (!('localFilesOnly' in state)) state.localFilesOnly = false
        }
        if (fromVersion < 9) {
          // Skill prefs added on workspaces + conversations. Backfill empty
          // maps so the typed accessors don't hit undefined.
          const ws = state.workspaces
          if (Array.isArray(ws)) {
            state.workspaces = ws.map((w) => {
              if (!w || typeof w !== 'object') return w
              const obj = w as Record<string, unknown>
              if ('skillPrefs' in obj) return obj
              return { ...obj, skillPrefs: {} }
            })
          }
          const convs = state.conversations
          if (Array.isArray(convs)) {
            state.conversations = convs.map((c) => {
              if (!c || typeof c !== 'object') return c
              const obj = c as Record<string, unknown>
              if ('skillPrefs' in obj) return obj
              return { ...obj, skillPrefs: {} }
            })
          }
        }
        if (fromVersion < 10) {
          // Conversation lineage (parentId / forkedFromMessageId). No
          // backfill needed — existing rows aren't part of any tree so
          // they remain as standalone roots. Nothing to do but bump
          // the version marker.
        }
        if (fromVersion < 11) {
          // Workspace.defaultModel added. Existing workspaces stay with
          // `undefined` (no pinned model), which is the same as the global
          // default — nothing changes for them. Marker bump only.
        }
        if (fromVersion < 12) {
          // Notes and artifacts moved from per-conversation to per-workspace
          // scope. Backfill `workspaceId` on each item by looking up its
          // conversation's workspaceId. Orphaned items (conversation already
          // gone) fall back to the first workspace so they remain visible
          // somewhere rather than silently disappearing.
          const convs = state.conversations
          const fallback =
            (Array.isArray(state.workspaces)
              ? (state.workspaces[0] as { id?: string } | undefined)?.id
              : undefined) ?? null
          const convMap = new Map<string, string>()
          if (Array.isArray(convs)) {
            for (const c of convs) {
              if (c && typeof c === 'object') {
                const conv = c as { id?: string; workspaceId?: string }
                if (conv.id && conv.workspaceId) convMap.set(conv.id, conv.workspaceId)
              }
            }
          }
          const stamp = <T extends { conversationId?: string | null; workspaceId?: string }>(
            item: T
          ): T => {
            if (item.workspaceId) return item
            const wsFromConv = item.conversationId ? convMap.get(item.conversationId) : null
            return {
              ...item,
              workspaceId: wsFromConv ?? fallback ?? '',
            }
          }
          const notes = state.notes
          if (Array.isArray(notes)) {
            state.notes = notes.map((n) =>
              n && typeof n === 'object' ? stamp(n as Record<string, unknown>) : n
            )
          }
          const arts = state.artifacts
          if (Array.isArray(arts)) {
            state.artifacts = arts.map((a) =>
              a && typeof a === 'object' ? stamp(a as Record<string, unknown>) : a
            )
          }
        }
        if (fromVersion < 13) {
          // Workspace.position added. Backfill by index in the current
          // array so existing ordering is preserved — the array order
          // before this version *was* the user-perceived order.
          const ws = state.workspaces
          if (Array.isArray(ws)) {
            state.workspaces = ws.map((w, i) => {
              if (!w || typeof w !== 'object') return w
              const obj = w as Record<string, unknown>
              if (typeof obj.position === 'number') return obj
              return { ...obj, position: i }
            })
          }
        }
        if (fromVersion < 14) {
          // Editor doc moved from conversation to workspace. For each
          // workspace, lift its most-recently-updated non-empty
          // conversation document onto the workspace row. Empty / orphan
          // docs are dropped — the editor was a transient scratchpad in
          // most cases and conflating multiple non-empty docs would
          // require user input we don't have at migration time.
          const ws = state.workspaces
          const convs = state.conversations
          if (Array.isArray(ws) && Array.isArray(convs)) {
            const bestByWorkspace = new Map<string, { doc: string; updatedAt: number }>()
            for (const c of convs) {
              if (!c || typeof c !== 'object') continue
              const conv = c as {
                workspaceId?: string
                documentContent?: string
                updatedAt?: string | Date
              }
              const doc = conv.documentContent
              if (!conv.workspaceId || typeof doc !== 'string' || !doc.trim()) continue
              const ts = new Date(conv.updatedAt ?? 0).getTime()
              const prev = bestByWorkspace.get(conv.workspaceId)
              if (!prev || ts > prev.updatedAt) {
                bestByWorkspace.set(conv.workspaceId, { doc, updatedAt: ts })
              }
            }
            state.workspaces = ws.map((w) => {
              if (!w || typeof w !== 'object') return w
              const obj = w as Record<string, unknown>
              if (typeof obj.documentContent === 'string') return obj
              const id = obj.id as string | undefined
              const carry = id ? bestByWorkspace.get(id)?.doc ?? '' : ''
              return { ...obj, documentContent: carry }
            })
            // Strip the legacy field off conversations so the persisted
            // shape matches the new type. Sync uploads to the legacy
            // column already stopped — see lib/client/sync/handlers.ts.
            state.conversations = convs.map((c) => {
              if (!c || typeof c !== 'object') return c
              const { documentContent: _drop, ...rest } = c as Record<string, unknown> & {
                documentContent?: unknown
              }
              void _drop
              return rest
            })
          }
        }
        if (fromVersion < 15) {
          // Multi-doc per workspace: convert each workspace's single
          // `documentContent` (from v14) into a row in the new
          // `documents` slice. Then strip the field off workspaces.
          // Active doc is set to the active workspace's migrated doc
          // when one exists.
          const ws = state.workspaces
          const existing = Array.isArray(state.documents) ? state.documents : []
          const activeId = state.activeWorkspaceId as string | undefined
          if (Array.isArray(ws)) {
            const created: Document[] = []
            const now = new Date()
            const stamp = (
              d: Date | string | undefined
            ): Date => (d ? new Date(d) : now)
            for (const w of ws) {
              if (!w || typeof w !== 'object') continue
              const obj = w as Record<string, unknown>
              const id = obj.id as string | undefined
              const name = (obj.name as string | undefined) ?? 'Workspace'
              const legacyDoc = obj.documentContent
              if (!id || typeof legacyDoc !== 'string' || !legacyDoc.trim()) continue
              created.push({
                id: uuid(),
                workspaceId: id,
                title: name,
                content: legacyDoc,
                position: 0,
                createdAt: stamp(obj.createdAt as Date | string | undefined),
                updatedAt: stamp(obj.updatedAt as Date | string | undefined),
              })
            }
            state.workspaces = ws.map((w) => {
              if (!w || typeof w !== 'object') return w
              const { documentContent: _drop, ...rest } = w as Record<string, unknown> & {
                documentContent?: unknown
              }
              void _drop
              return rest
            })
            state.documents = [...existing, ...created]
            // Pick the active workspace's migrated doc, if any.
            const forActive = created.find((d) => d.workspaceId === activeId)
            state.activeDocumentId =
              (state.activeDocumentId as string | null | undefined) ?? forActive?.id ?? null
          }
        }
        if (fromVersion < 16) {
          // Conversation-private files lane added. Seed an empty slice
          // on existing stores so the typed accessor doesn't hit
          // `undefined`. Defensive prune of dangling joins / dangling
          // `selectedFileIds` runs on every rehydrate (see
          // `onRehydrateStorage`) so it's not duplicated here.
          if (!('conversationFiles' in state)) state.conversationFiles = []
        }
        if (fromVersion < 17) {
          // MCP slices added — workspace-scoped servers + the resources
          // they expose, plus the workspace and conversation-private
          // resource joins. Seed empties; the actual capability discovery
          // happens out-of-band via the /api/mcp/* proxy.
          if (!('mcpServers' in state)) state.mcpServers = []
          if (!('mcpResources' in state)) state.mcpResources = []
          if (!('mcpResourceBindings' in state)) state.mcpResourceBindings = []
          if (!('conversationMcpResources' in state)) {
            state.conversationMcpResources = []
          }
          // `Conversation.selectedMcpResourceIds` is optional in the
          // type, so no backfill needed — read sites default to [].
        }
        if (fromVersion < 18) {
          // URL-bookmark slices added — workspace-library bookmarks
          // (`urlBookmarks`) + conversation-private join
          // (`conversationUrlBookmarks`). Seed empties; the actual
          // fetch + extraction happens out-of-band via /api/url/fetch.
          // `Conversation.selectedUrlBookmarkIds` is optional, no
          // backfill required.
          if (!('urlBookmarks' in state)) state.urlBookmarks = []
          if (!('conversationUrlBookmarks' in state)) {
            state.conversationUrlBookmarks = []
          }
        }
        if (fromVersion < 19) {
          // `webSearchMaxCalls` (flat number) folded into
          // `webSearchConfig.maxCalls` on both Workspace and Conversation,
          // alongside the new per-provider sub-config. Also retires the
          // short-lived `webSearchBrave` skill id by folding its enabled
          // state into `webSearchConfig.brave.enabled` and stripping the
          // entry from `skillPrefs`.
          const foldOne = (obj: Record<string, unknown>) => {
            const legacyMax = obj.webSearchMaxCalls
            const cfg =
              (typeof obj.webSearchConfig === 'object' && obj.webSearchConfig)
                ? { ...(obj.webSearchConfig as Record<string, unknown>) }
                : ({} as Record<string, unknown>)
            if (typeof legacyMax === 'number' && cfg.maxCalls === undefined) {
              cfg.maxCalls = legacyMax
            }
            delete obj.webSearchMaxCalls
            // Fold legacy skillPrefs.webSearchBrave (a brief two-skill
            // detour) back into webSearchConfig.brave.enabled.
            const prefs = obj.skillPrefs
            if (prefs && typeof prefs === 'object') {
              const p = prefs as Record<string, unknown>
              if ('webSearchBrave' in p) {
                const wantsBrave = p.webSearchBrave === true
                const brave =
                  (typeof cfg.brave === 'object' && cfg.brave)
                    ? { ...(cfg.brave as Record<string, unknown>) }
                    : ({} as Record<string, unknown>)
                // Only fold a `false` override — `true` is the default
                // when the env key is present, no need to store it.
                if (!wantsBrave) brave.enabled = false
                if (Object.keys(brave).length > 0) cfg.brave = brave
                delete p.webSearchBrave
              }
            }
            if (Object.keys(cfg).length > 0) {
              obj.webSearchConfig = cfg
            }
          }
          const ws = state.workspaces
          if (Array.isArray(ws)) {
            state.workspaces = ws.map((w) => {
              if (!w || typeof w !== 'object') return w
              const obj = { ...(w as Record<string, unknown>) }
              foldOne(obj)
              return obj
            })
          }
          const convs = state.conversations
          if (Array.isArray(convs)) {
            state.conversations = convs.map((c) => {
              if (!c || typeof c !== 'object') return c
              const obj = { ...(c as Record<string, unknown>) }
              foldOne(obj)
              return obj
            })
          }
        }
        return persistedState
      },
      onRehydrateStorage: () => (state) => {
        // Revive Date fields. Zustand-persist round-trips Dates through
        // JSON which strips them to ISO strings; without this pass
        // every `Date`-typed field on the store would be a string at
        // runtime and any `.toISOString()` / `.getTime()` call would
        // need to defend itself. See `lib/client/store/revive-dates.ts`.
        if (state) {
          reviveDates(state as unknown as Record<string, unknown>)
        }
        // Defensive prune: drop join rows and selection ids that
        // reference a missing or tombstoned target. Cheap (one pass
        // per array), no-op on healthy data; covers cross-tab races
        // and any future bugs in new mutators.
        if (state) {
          const liveFileIds = new Set(
            state.files.filter((f) => !f.deletedAt).map((f) => f.id)
          )
          const liveMcpResourceIds = new Set(
            state.mcpResources.filter((r) => !r.deletedAt).map((r) => r.id)
          )
          const liveUrlBookmarkIds = new Set(
            state.urlBookmarks.filter((b) => !b.deletedAt).map((b) => b.id)
          )
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
            const fileChanged = fileSel.length !== c.selectedFileIds.length
            const mcpChanged =
              mcpSel.length !== (c.selectedMcpResourceIds ?? []).length
            const urlChanged =
              urlSel.length !== (c.selectedUrlBookmarkIds ?? []).length
            if (!fileChanged && !mcpChanged && !urlChanged) return c
            return {
              ...c,
              selectedFileIds: fileSel,
              selectedMcpResourceIds: mcpSel.length > 0 ? mcpSel : undefined,
              selectedUrlBookmarkIds: urlSel.length > 0 ? urlSel : undefined,
            }
          })
        }
        notifyHydrated()
      },
      partialize: (state) => ({
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
        prompts: state.prompts,
        // pendingChatInput is deliberately NOT persisted — it's a
        // one-shot event signal, not durable state. Surviving a reload
        // would re-trigger an insert on next mount.
      }),
    }
  )
)

// Separate store for session-based state (cleared when browser tab is closed)
interface SessionState {
  selectedFileIds: string[]
  toggleFileSelection: (fileId: string) => void
  setSelectedFileIds: (ids: string[]) => void
  clearSelectedFiles: () => void
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      selectedFileIds: [],
      toggleFileSelection: (fileId: string) =>
        set((state) => ({
          selectedFileIds: state.selectedFileIds.includes(fileId)
            ? state.selectedFileIds.filter((id) => id !== fileId)
            : [...state.selectedFileIds, fileId],
        })),
      setSelectedFileIds: (ids: string[]) => set({ selectedFileIds: ids }),
      clearSelectedFiles: () => set({ selectedFileIds: [] }),
    }),
    {
      name: 'hummingbird-session',
      storage: (typeof window !== 'undefined')
        ? createJSONStorage(() => sessionStorage)
        : undefined,
    }
  )
)

// Helper selectors
export const useActiveWorkspace = () => {
  const workspaces = useStore((state) => state.workspaces)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return workspaces.find((w) => w.id === activeWorkspaceId) || null
}

export const useActiveConversation = () => {
  const conversations = useStore((state) => state.conversations)
  const activeConversationId = useStore((state) => state.activeConversationId)
  return conversations.find((c) => c.id === activeConversationId) || null
}

/** True iff the given conversation is currently mid-stream. `null`
 *  conversation id always returns false. Cheap O(n) lookup over the
 *  typing-ids array which is realistically always 0–few items long. */
export const useIsConversationTyping = (conversationId: string | null): boolean => {
  return useStore((state) =>
    conversationId !== null && state.typingConversationIds.includes(conversationId)
  )
}

/**
 * Returns the file IDs the active conversation has attached as context for its
 * next message. Empty array if there's no active conversation.
 */
export const useConversationSelectedFileIds = (): string[] => {
  const conv = useActiveConversation()
  return conv?.selectedFileIds ?? []
}

export const useWorkspaceConversations = () => {
  const conversations = useStore((state) => state.conversations)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return conversations.filter((c) => c.workspaceId === activeWorkspaceId)
}

export const useWorkspaceResources = () => {
  const resources = useStore((state) => state.resources)
  const files = useStore((state) => state.files)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  const workspaceResources = resources.filter((r) => r.workspaceId === activeWorkspaceId)
  return workspaceResources
    .map((r) => files.find((f) => f.id === r.fileId))
    .filter((f): f is UploadedFile => !!f && !f.deletedAt)
}

/**
 * Files attached privately to the active conversation. These do NOT
 * appear in the workspace library — they're scoped to one chat. Empty
 * when there's no active conversation. Inner-joins against `files[]`
 * so dangling refs are skipped silently.
 */
export const useConversationPrivateFiles = (): UploadedFile[] => {
  const conversationFiles = useStore((state) => state.conversationFiles)
  const files = useStore((state) => state.files)
  const activeConversationId = useStore((state) => state.activeConversationId)
  if (!activeConversationId) return []
  return conversationFiles
    .filter((cf) => cf.conversationId === activeConversationId)
    .map((cf) => files.find((f) => f.id === cf.fileId))
    .filter((f): f is UploadedFile => !!f && !f.deletedAt)
}

/** MCP servers belonging to the active workspace (live, non-tombstoned). */
export const useWorkspaceMcpServers = (): McpServer[] => {
  const mcpServers = useStore((state) => state.mcpServers)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return mcpServers.filter(
    (s) => s.workspaceId === activeWorkspaceId && !s.deletedAt
  )
}

/** MCP resources bound to the active workspace's library. */
export const useWorkspaceMcpResources = (): McpResource[] => {
  const mcpResourceBindings = useStore((state) => state.mcpResourceBindings)
  const mcpResources = useStore((state) => state.mcpResources)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return mcpResourceBindings
    .filter((b) => b.workspaceId === activeWorkspaceId)
    .map((b) => mcpResources.find((r) => r.id === b.resourceId))
    .filter((r): r is McpResource => !!r && !r.deletedAt)
}

/** MCP resources pinned privately to the active conversation. */
export const useConversationPrivateMcpResources = (): McpResource[] => {
  const conversationMcpResources = useStore(
    (state) => state.conversationMcpResources
  )
  const mcpResources = useStore((state) => state.mcpResources)
  const activeConversationId = useStore((state) => state.activeConversationId)
  if (!activeConversationId) return []
  return conversationMcpResources
    .filter((cmr) => cmr.conversationId === activeConversationId)
    .map((cmr) => mcpResources.find((r) => r.id === cmr.resourceId))
    .filter((r): r is McpResource => !!r && !r.deletedAt)
}

/** Workspace MCP resources ticked on for the active conversation. */
export const useConversationSelectedMcpResourceIds = (): string[] => {
  const conv = useActiveConversation()
  return conv?.selectedMcpResourceIds ?? []
}

/** Live URL bookmarks in the active workspace. */
export const useWorkspaceUrlBookmarks = (): UrlBookmark[] => {
  const urlBookmarks = useStore((state) => state.urlBookmarks)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return urlBookmarks.filter(
    (b) => b.workspaceId === activeWorkspaceId && !b.deletedAt
  )
}

/** URL bookmarks pinned privately to the active conversation. */
export const useConversationPrivateUrlBookmarks = (): UrlBookmark[] => {
  const conversationUrlBookmarks = useStore(
    (state) => state.conversationUrlBookmarks
  )
  const urlBookmarks = useStore((state) => state.urlBookmarks)
  const activeConversationId = useStore((state) => state.activeConversationId)
  if (!activeConversationId) return []
  return conversationUrlBookmarks
    .filter((cub) => cub.conversationId === activeConversationId)
    .map((cub) => urlBookmarks.find((b) => b.id === cub.bookmarkId))
    .filter((b): b is UrlBookmark => !!b && !b.deletedAt)
}

/** Workspace URL bookmarks ticked on for the active conversation. */
export const useConversationSelectedUrlBookmarkIds = (): string[] => {
  const conv = useActiveConversation()
  return conv?.selectedUrlBookmarkIds ?? []
}

export const useConversationNotes = () => {
  const notes = useStore((state) => state.notes)
  const activeConversationId = useStore((state) => state.activeConversationId)
  if (!activeConversationId) return [] as Note[]
  return notes.filter((n) => n.conversationId === activeConversationId)
}

/** Notes visible in the active workspace. Replaces the per-conversation
 *  view in the right rail's Notes tab — notes now survive conversation
 *  deletion and accumulate at the workspace level. */
export const useWorkspaceNotes = () => {
  const notes = useStore((state) => state.notes)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  if (!activeWorkspaceId) return [] as Note[]
  return notes.filter((n) => n.workspaceId === activeWorkspaceId)
}

export const useMessageBookmark = (messageId: string) => {
  const notes = useStore((state) => state.notes)
  const activeConversationId = useStore((state) => state.activeConversationId)
  if (!activeConversationId) return null
  return notes.find(
    (n) => n.conversationId === activeConversationId && n.messageId === messageId
  ) ?? null
}

/** Documents in the active workspace, sorted by position (asc) and then
 *  by updatedAt (desc) as a tiebreaker. Switching workspaces re-runs the
 *  derivation through the `activeWorkspaceId` dependency. */
export const useWorkspaceDocuments = (): Document[] => {
  const documents = useStore((state) => state.documents)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  if (!activeWorkspaceId) return []
  return documents
    .filter((d) => d.workspaceId === activeWorkspaceId)
    .sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
}

/** Non-deleted prompts scoped to the active workspace, sorted by
 *  updatedAt desc. */
export const useWorkspacePrompts = (): Prompt[] => {
  const prompts = useStore((state) => state.prompts)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  if (!activeWorkspaceId) return []
  return prompts
    .filter((p) => p.workspaceId === activeWorkspaceId && !p.deletedAt)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
}

/** Current open document, or null when the workspace has none yet. */
export const useActiveDocument = (): Document | null => {
  const documents = useStore((state) => state.documents)
  const activeDocumentId = useStore((state) => state.activeDocumentId)
  if (!activeDocumentId) return null
  return documents.find((d) => d.id === activeDocumentId) ?? null
}

/** Convenience: just the active doc's `content`. Empty string when none. */
export const useActiveDocumentContent = (): string => {
  const doc = useActiveDocument()
  return doc?.content ?? ''
}

export const useConversationArtifacts = () => {
  const artifacts = useStore((state) => state.artifacts)
  const activeConversationId = useStore((state) => state.activeConversationId)
  if (!activeConversationId) return [] as Artifact[]
  return artifacts
    .filter((a) => a.conversationId === activeConversationId)
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
}

/** Artifacts visible in the active workspace. Same shape as
 *  `useConversationArtifacts` but scoped one level up. */
export const useWorkspaceArtifacts = () => {
  const artifacts = useStore((state) => state.artifacts)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  if (!activeWorkspaceId) return [] as Artifact[]
  return artifacts
    .filter((a) => a.workspaceId === activeWorkspaceId)
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
}

export const useConversationPinnedExplanations = () => {
  const pins = useStore((state) => state.pinnedExplanations)
  const activeConversationId = useStore((state) => state.activeConversationId)
  if (!activeConversationId) return [] as PinnedExplanation[]
  return pins.filter((p) => p.conversationId === activeConversationId)
}
