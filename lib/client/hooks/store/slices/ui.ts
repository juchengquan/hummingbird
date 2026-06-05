import "client-only"

import { useShallow } from "zustand/react/shallow"

import type {
  MainView,
  PinnedExplanation,
  ToolCallResult,
} from "@/shared/types"
import { uuid } from "@/shared/uuid"

import { useStore } from "../../use-store"
import { clampResourcesSidebarWidth, clampSidebarWidth } from "../../store-helpers"
import type { SliceCreator } from "../types"

/** Frozen empty-array sentinel for the "no active conversation" branch. */
const EMPTY_PINS: readonly PinnedExplanation[] = Object.freeze([])

export type Theme = "system" | "dark" | "light"
export type ColorScheme = "default" | "anthropic"

/** Which `/api/chat` producer the apiClient hits. See `chatBackend`
 *  on the UI slice for the full rationale. */
export type ChatBackend = "ts" | "python" | "ts-service"

/** Tab ids for the right resources sidebar. */
export type ResourcesSidebarTab =
  | "files"
  | "notes"
  | "artifacts"
  | "skills"
  | "pins"
  | "mcp"
  | "links"
  | "project"

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
      type: "explain"
      text: string
      scope: string
      rect: { top: number; left: number; right: number; bottom: number; width: number; height: number }
    }
  | { type: "quote"; text: string }

// Read theme from localStorage synchronously to prevent flash.
function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark"
  try {
    const stored = localStorage.getItem("hummingbird-storage")
    if (stored) {
      const parsed = JSON.parse(stored)
      return parsed.state?.theme || "dark"
    }
  } catch {}
  return "dark"
}

/**
 * UI slice — theme/colorScheme, the active main-area view, sidebar +
 * panel open/width state, editor prefs, the session-only Explain pins,
 * the selection-action bus, the local-only/local-files toggles, and the
 * one-shot chat-input seed. No cross-entity cascades.
 */
export interface UiSlice {
  // Theme
  theme: Theme
  colorScheme: ColorScheme

  // Active main-area view (single source of truth — see MainArea in dashboard/page.tsx)
  activeView: MainView

  // Sidebar
  sidebarCollapsed: boolean
  /** Custom sidebar width in px. Default 256 (16rem). Clamped 172–480.
   *  Only applies when the sidebar is expanded (not icon-collapsed). */
  sidebarWidth: number

  // Right resources sidebar (chat view)
  resourcesSidebarOpen: boolean
  resourcesSidebarTab: ResourcesSidebarTab
  // Tasks panel (chat view) — the live surface for long-running agent runs.
  tasksPanelOpen: boolean
  /** Custom right-rail content width in px. Default 272 (17rem).
   *  Clamped 200–400. */
  resourcesSidebarWidth: number
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
   * (it's small), but the actual blob never leaves the device.
   */
  localFilesOnly: boolean

  /** One-shot signal from anywhere in the app to ChatPanel's local input
   *  state. Set by sidebar prompt click (after variable expansion) or
   *  any future surface that wants to seed the input. ChatPanel's
   *  useEffect reads, copies to local state, then clears. */
  pendingChatInput: string | null

  /**
   * Backend selector for `/api/chat` streaming.
   *
   * - `'ts'` (default) — Next.js route `/api/chat` (the existing,
   *   feature-complete stack with skills / attachments / MCP / etc.).
   * - `'python'` — the Phase 4-1 agent service at
   *   `<NEXT_PUBLIC_AGENT_PY_URL>/v1/chat`. Text-only today; tools
   *   and skills land in later phases.
   *
   * Per `PLAN-agent-api.md`, both stacks stay live indefinitely —
   * this setting is the user-facing selector, NOT a phased cutover.
   * The toggle only surfaces in the UI when `NEXT_PUBLIC_AGENT_PY_URL`
   * is set; without it, every value here is treated as 'ts'.
   *
   * Survives reloads via partialize (so a user who switched stays
   * switched). Default is 'ts' — existing users see no behaviour
   * change post-update.
   */
  chatBackend: ChatBackend

  // View / sidebar actions
  toggleSidebar: () => void
  setActiveView: (view: MainView) => void
  setSidebarWidth: (width: number) => void
  setResourcesSidebarOpen: (open: boolean) => void
  toggleResourcesSidebar: () => void
  setResourcesSidebarTab: (tab: ResourcesSidebarTab) => void
  setTasksPanelOpen: (open: boolean) => void
  toggleTasksPanel: () => void
  setResourcesSidebarWidth: (width: number) => void
  setEditorPref: <K extends keyof UiSlice["editorPrefs"]>(
    key: K,
    value: UiSlice["editorPrefs"][K]
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
  setPendingChatInput: (value: string | null) => void
  setChatBackend: (value: ChatBackend) => void

  // Theme actions
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setColorScheme: (scheme: ColorScheme) => void
}

export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
  theme: getInitialTheme(),
  colorScheme: "default" as ColorScheme,
  activeView: "workspaces",
  sidebarCollapsed: false,
  sidebarWidth: 256,
  // Right resources sidebar — default open on first load; the mobile
  // override happens in ResourcesSidebar's first-mount effect.
  resourcesSidebarOpen: true,
  resourcesSidebarTab: "files",
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
  pendingChatInput: null,
  chatBackend: "ts",

  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setActiveView: (view) => set({ activeView: view }),
  setResourcesSidebarOpen: (open) => set({ resourcesSidebarOpen: open }),
  toggleResourcesSidebar: () =>
    set((state) => ({ resourcesSidebarOpen: !state.resourcesSidebarOpen })),
  setResourcesSidebarTab: (tab) => set({ resourcesSidebarTab: tab }),
  setTasksPanelOpen: (open) => set({ tasksPanelOpen: open }),
  toggleTasksPanel: () =>
    set((state) => ({ tasksPanelOpen: !state.tasksPanelOpen })),
  setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
  setResourcesSidebarWidth: (width) =>
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
  setPendingChatInput: (value) => set({ pendingChatInput: value }),
  setChatBackend: (value) => set({ chatBackend: value }),

  setTheme: (theme) => set({ theme }),
  toggleTheme: () => {
    const currentTheme = get().theme
    const themes: Theme[] = ["system", "dark", "light"]
    const currentIndex = themes.indexOf(currentTheme)
    const nextIndex = (currentIndex + 1) % themes.length
    set({ theme: themes[nextIndex] })
  },
  setColorScheme: (scheme) => set({ colorScheme: scheme }),
})

export const useConversationPinnedExplanations = () =>
  useStore(
    useShallow((state) => {
      if (!state.activeConversationId) return EMPTY_PINS as PinnedExplanation[]
      return state.pinnedExplanations.filter(
        (p) => p.conversationId === state.activeConversationId,
      )
    }),
  )
