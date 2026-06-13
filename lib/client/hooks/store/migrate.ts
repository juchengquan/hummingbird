import "client-only"

import type { Document } from "@/shared/types"
import { uuid } from "@/shared/uuid"

/**
 * Current persisted-state schema version. Bump when adding a migration
 * step in `runMigrations`. Wired into the `version` field of the persist
 * config in `use-store.ts`.
 */
export const STORE_VERSION = 29

/**
 * Sequential schema migrations from older persisted shapes to the
 * current one. Each `if (fromVersion < N)` block describes the change
 * landed at version `N`. Operates on the raw rehydrated record and
 * returns it (in-place mutation is fine — zustand-persist hands us the
 * value before it's exposed to subscribers).
 */
export function runMigrations(
  persistedState: unknown,
  fromVersion: number
): unknown {
  if (!persistedState || typeof persistedState !== "object") return persistedState
  const state = persistedState as Record<string, unknown>
  if (fromVersion < 2) {
    const stale = [
      "chatPanelOpen", "editorPanelOpen", "resourcesPanelOpen", "sourcesPanelOpen",
      "chatSessionsPanelOpen", "workspacePanelOpen",
      "chatSessionsPanelWidth", "resourcesPanelWidth", "editorPanelWidth",
      "selectedFileIds",
    ]
    for (const k of stale) delete state[k]
  }
  if (fromVersion < 3) {
    // selectedFileIds moved from useSessionStore onto each Conversation.
    // Backfill an empty array on any persisted conversation missing it.
    const convs = state.conversations
    if (Array.isArray(convs)) {
      state.conversations = convs.map((c) =>
        c && typeof c === "object" && !("selectedFileIds" in c)
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
      typeof state.documentContent === "string" ? state.documentContent : ""
    const activeId = state.activeConversationId
    const convs = state.conversations
    if (Array.isArray(convs)) {
      state.conversations = convs.map((c) => {
        if (!c || typeof c !== "object") return c
        const conv = c as Record<string, unknown>
        if ("documentContent" in conv) return conv
        return {
          ...conv,
          documentContent: conv.id === activeId ? legacyDoc : "",
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
        if (!w || typeof w !== "object") return w
        const ws = w as Record<string, unknown>
        if ("systemPrompt" in ws) return ws
        return { ...ws, systemPrompt: "" }
      })
    }
  }
  if (fromVersion < 6) {
    // Right resources sidebar gained persisted open/tab state. Seed
    // defaults so the first render after upgrade isn't undefined.
    if (!("resourcesSidebarOpen" in state)) state.resourcesSidebarOpen = true
    if (!("resourcesSidebarTab" in state)) state.resourcesSidebarTab = "files"
  }
  if (fromVersion < 7) {
    // Local-only mode opt-out toggle. Default OFF so existing users
    // keep cloud sync unchanged unless they explicitly turn it on.
    if (!("localOnlyMode" in state)) state.localOnlyMode = false
  }
  if (fromVersion < 8) {
    // Local-files-only toggle. Default OFF so signed-in users keep
    // Supabase Storage uploads. Storing raw blobs locally is opt-in.
    if (!("localFilesOnly" in state)) state.localFilesOnly = false
  }
  if (fromVersion < 9) {
    // Skill prefs added on workspaces + conversations. Backfill empty
    // maps so the typed accessors don't hit undefined.
    const ws = state.workspaces
    if (Array.isArray(ws)) {
      state.workspaces = ws.map((w) => {
        if (!w || typeof w !== "object") return w
        const obj = w as Record<string, unknown>
        if ("skillPrefs" in obj) return obj
        return { ...obj, skillPrefs: {} }
      })
    }
    const convs = state.conversations
    if (Array.isArray(convs)) {
      state.conversations = convs.map((c) => {
        if (!c || typeof c !== "object") return c
        const obj = c as Record<string, unknown>
        if ("skillPrefs" in obj) return obj
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
        if (c && typeof c === "object") {
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
        workspaceId: wsFromConv ?? fallback ?? "",
      }
    }
    const notes = state.notes
    if (Array.isArray(notes)) {
      state.notes = notes.map((n) =>
        n && typeof n === "object" ? stamp(n as Record<string, unknown>) : n
      )
    }
    const arts = state.artifacts
    if (Array.isArray(arts)) {
      state.artifacts = arts.map((a) =>
        a && typeof a === "object" ? stamp(a as Record<string, unknown>) : a
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
        if (!w || typeof w !== "object") return w
        const obj = w as Record<string, unknown>
        if (typeof obj.position === "number") return obj
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
        if (!c || typeof c !== "object") continue
        const conv = c as {
          workspaceId?: string
          documentContent?: string
          updatedAt?: string | Date
        }
        const doc = conv.documentContent
        if (!conv.workspaceId || typeof doc !== "string" || !doc.trim()) continue
        const ts = new Date(conv.updatedAt ?? 0).getTime()
        const prev = bestByWorkspace.get(conv.workspaceId)
        if (!prev || ts > prev.updatedAt) {
          bestByWorkspace.set(conv.workspaceId, { doc, updatedAt: ts })
        }
      }
      state.workspaces = ws.map((w) => {
        if (!w || typeof w !== "object") return w
        const obj = w as Record<string, unknown>
        if (typeof obj.documentContent === "string") return obj
        const id = obj.id as string | undefined
        const carry = id ? bestByWorkspace.get(id)?.doc ?? "" : ""
        return { ...obj, documentContent: carry }
      })
      // Strip the legacy field off conversations so the persisted
      // shape matches the new type. Sync uploads to the legacy
      // column already stopped — see lib/client/sync/handlers.ts.
      state.conversations = convs.map((c) => {
        if (!c || typeof c !== "object") return c
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
        if (!w || typeof w !== "object") continue
        const obj = w as Record<string, unknown>
        const id = obj.id as string | undefined
        const name = (obj.name as string | undefined) ?? "Workspace"
        const legacyDoc = obj.documentContent
        if (!id || typeof legacyDoc !== "string" || !legacyDoc.trim()) continue
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
        if (!w || typeof w !== "object") return w
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
    if (!("conversationFiles" in state)) state.conversationFiles = []
  }
  if (fromVersion < 17) {
    // MCP slices added — workspace-scoped servers + the resources
    // they expose, plus the workspace and conversation-private
    // resource joins. Seed empties; the actual capability discovery
    // happens out-of-band via the /api/mcp/* proxy.
    if (!("mcpServers" in state)) state.mcpServers = []
    if (!("mcpResources" in state)) state.mcpResources = []
    if (!("mcpResourceBindings" in state)) state.mcpResourceBindings = []
    if (!("conversationMcpResources" in state)) {
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
    if (!("urlBookmarks" in state)) state.urlBookmarks = []
    if (!("conversationUrlBookmarks" in state)) {
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
        (typeof obj.webSearchConfig === "object" && obj.webSearchConfig)
          ? { ...(obj.webSearchConfig as Record<string, unknown>) }
          : ({} as Record<string, unknown>)
      if (typeof legacyMax === "number" && cfg.maxCalls === undefined) {
        cfg.maxCalls = legacyMax
      }
      delete obj.webSearchMaxCalls
      // Fold legacy skillPrefs.webSearchBrave (a brief two-skill
      // detour) back into webSearchConfig.brave.enabled.
      const prefs = obj.skillPrefs
      if (prefs && typeof prefs === "object") {
        const p = prefs as Record<string, unknown>
        if ("webSearchBrave" in p) {
          const wantsBrave = p.webSearchBrave === true
          const brave =
            (typeof cfg.brave === "object" && cfg.brave)
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
        if (!w || typeof w !== "object") return w
        const obj = { ...(w as Record<string, unknown>) }
        foldOne(obj)
        return obj
      })
    }
    const convs = state.conversations
    if (Array.isArray(convs)) {
      state.conversations = convs.map((c) => {
        if (!c || typeof c !== "object") return c
        const obj = { ...(c as Record<string, unknown>) }
        foldOne(obj)
        return obj
      })
    }
  }
  if (fromVersion < 20) {
    // Chat-backend selector added (Phase 4-2 of PLAN-agent-api).
    // Default to 'ts' so existing users keep hitting the Next.js
    // route unchanged. Users who want the Python agent service have
    // to opt in via the account-menu toggle.
    if (!("chatBackend" in state)) state.chatBackend = "ts"
  }
  if (fromVersion < 21) {
    // Phase 5 of PLAN-agent-ts widened ChatBackend to also accept
    // 'ts-service'. Existing 'ts' and 'python' values stay valid —
    // no rewrites needed. The version bump exists so a downgrade
    // doesn't see a value it doesn't recognise.
  }
  if (fromVersion < 22) {
    // `Conversation.systemPrompt` added as the missing middle tier
    // in the chat-send cascade (workspace → conversation → persona).
    // Backfill empty so the typed accessor doesn't hit `undefined` and
    // so the composer trims the empty out of the prompt. See
    // `docs/PLAN-conversation-system-prompt.md`.
    const convs = state.conversations
    if (Array.isArray(convs)) {
      state.conversations = convs.map((c) => {
        if (!c || typeof c !== "object") return c
        const obj = c as Record<string, unknown>
        if (typeof obj.systemPrompt === "string") return obj
        return { ...obj, systemPrompt: "" }
      })
    }
  }
  if (fromVersion < 23) {
    // `Conversation.fileRetrievalModes` added — per-attached-file
    // RAG-vs-inline override. The field is optional in the type, but
    // we explicitly seed an empty object on existing rows so the sync
    // diff has a stable shape to compare against (no spurious
    // `fileRetrievalModes: undefined` vs `{}` mismatches). See
    // `docs/PLAN-cross-product-inspirations.md` item #6.
    const convs = state.conversations
    if (Array.isArray(convs)) {
      state.conversations = convs.map((c) => {
        if (!c || typeof c !== "object") return c
        const obj = c as Record<string, unknown>
        if (
          obj.fileRetrievalModes &&
          typeof obj.fileRetrievalModes === "object" &&
          !Array.isArray(obj.fileRetrievalModes)
        ) {
          return obj
        }
        return { ...obj, fileRetrievalModes: {} }
      })
    }
  }
  if (fromVersion < 24) {
    // `chatReasoningEffort` added to the chat slice (reasoning-effort
    // control). It's a nullable scalar whose slice initial value is
    // `null`, so a store predating it falls back to that default on
    // rehydrate — no backfill needed. Marker bump only, so the pinned
    // persisted key set in `persist.test.ts` stays in lockstep with the
    // version. See `docs/PLAN-reasoning-effort-control.md`.
  }
  if (fromVersion < 25) {
    // `Message.uiParts` added — generative-UI parts produced by the
    // `renderUI` tool. The field is OPTIONAL in the type, so no
    // backfill is strictly required — existing messages without
    // `uiParts` render exactly as before. The version bump is a
    // marker so a downgrade can't silently lose a part written by a
    // newer client. Defensive prune of malformed entries happens at
    // render via `parsePersistedUiPart`. See
    // `docs/PLAN-generative-ui-parts.md`.
  }
  if (fromVersion < 26) {
    // `editorPrefs.inlineComplete` added (inline editor ghost-text
    // autocomplete). Default OFF — ghost text is opinionated and adds
    // per-keystroke cost, so v1 is opt-in. Backfill `false` on existing
    // `editorPrefs` so the toggle starts at "off" rather than
    // `undefined`. See `docs/PLAN-inline-autocomplete.md`.
    const prefs = state.editorPrefs
    if (prefs && typeof prefs === "object") {
      const obj = prefs as Record<string, unknown>
      if (typeof obj.inlineComplete !== "boolean") {
        state.editorPrefs = { ...obj, inlineComplete: false }
      }
    }
  }
  if (fromVersion < 27) {
    // `userSkills` slice added (portable Agent Skills / SKILL.md). New
    // persisted array with an initial value of `[]`, so a store
    // predating it falls back to that default on rehydrate — no backfill
    // needed. Marker bump only, keeping the pinned persisted key set in
    // `persist.test.ts` in lockstep with the version. Local-only in v1
    // (no Supabase sync). See `docs/PLAN-portable-skills.md`.
  }
  if (fromVersion < 28) {
    // MCP Apps polish (phase 3) — `McpAppPart.resourceUri` and
    // `McpAppPart.truncated` added so the refresh button can re-read
    // the `ui://` resource and the renderer can swap in the explicit
    // "UI too large" stub. Both fields are OPTIONAL on the persisted
    // type — existing `Message.mcpApps` entries simply have neither
    // and render exactly as they did before, just without a refresh
    // button. The version bump is a marker so a downgrade can't
    // silently lose a part written by a newer client. See
    // `docs/PLAN-mcp-apps.md`.
  }
  if (fromVersion < 29) {
    // Citation-verification opt-in toggle (`verifyCitations`). Default
    // OFF so existing users see no behaviour change until they enable it
    // in the account menu (Deep Research mode enables it independently).
    // See `docs/PLAN-citation-verifiability.md`.
    if (!("verifyCitations" in state)) state.verifyCitations = false
  }
  return persistedState
}
