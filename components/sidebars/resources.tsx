"use client"

import { useEffect, useRef } from "react"
import { ChevronLeft, ChevronRight, FolderOpen, StickyNote, Archive } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStore, useWorkspaceResources, useConversationNotes, useConversationArtifacts } from "@/lib/hooks/use-store"
import { ChatResourcesPanel } from "@/components/panels/chat-resources-panel"

/**
 * Right-edge "activity bar" sidebar.
 *
 * Always-visible icon column on the viewport edge (IDE-style — VS Code's
 * activity bar). Content panel slides in to its *left* when expanded.
 * Adding more tabs in future just appends to the icon column; the layout
 * scales without redesign.
 *
 * Interaction model:
 * - Click an inactive tab icon → switch to that tab + expand.
 * - Click the active tab icon when expanded → collapse (preserves tab
 *   so reopening lands the user back where they were).
 * - Collapse / expand chevron at the *top* of the icon bar — single
 *   affordance regardless of state.
 */
const RAIL_TABS = [
  { id: "files" as const, label: "Files", Icon: FolderOpen },
  { id: "notes" as const, label: "Notes", Icon: StickyNote },
  { id: "artifacts" as const, label: "Artifacts", Icon: Archive },
]

// Width tokens picked so the open total (icon bar + content) equals the
// previous w-80 (320px), keeping the chat column width unchanged for users.
const RAIL_WIDTH_CLASS = "w-12" // 48px
const CONTENT_WIDTH_CLASS = "w-[272px]"

export function ResourcesSidebar() {
  const open = useStore((s) => s.resourcesSidebarOpen)
  const tab = useStore((s) => s.resourcesSidebarTab)
  const setOpen = useStore((s) => s.setResourcesSidebarOpen)
  const toggleOpen = useStore((s) => s.toggleResourcesSidebar)
  const setTab = useStore((s) => s.setResourcesSidebarTab)
  const resourcesCount = useWorkspaceResources().length
  const notesCount = useConversationNotes().length
  const artifactsCount = useConversationArtifacts().length

  // First-mount mobile override: only fires once per browser, and only if
  // user hasn't toggled since the v6 migration seeded `true`.
  const didMobileCheckRef = useRef(false)
  useEffect(() => {
    if (didMobileCheckRef.current) return
    didMobileCheckRef.current = true
    if (typeof window === "undefined") return
    const marker = "hummingbird-resources-sidebar-mobile-checked"
    if (sessionStorage.getItem(marker)) return
    sessionStorage.setItem(marker, "1")
    if (window.matchMedia("(max-width: 768px)").matches) {
      setOpen(false)
    }
  }, [setOpen])

  // Cmd/Ctrl+Shift+B toggles the right resources sidebar.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "b" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        toggleOpen()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [toggleOpen])

  const counts: Record<typeof tab, number> = {
    files: resourcesCount,
    notes: notesCount,
    artifacts: artifactsCount,
  }

  return (
    <aside
      data-state={open ? "expanded" : "collapsed"}
      className={cn(
        "hidden lg:flex flex-row h-full min-h-0 shrink-0 border-l border-[var(--border)] bg-[var(--background)]/60",
        "transition-[width] duration-200 ease-out",
        open ? "w-80" : RAIL_WIDTH_CLASS
      )}
    >
      {/* Content panel — slides in to the LEFT of the icon bar when open */}
      {open && (
        <div
          className={cn(
            "flex flex-col h-full min-h-0 shrink-0 border-r border-[var(--border)]",
            CONTENT_WIDTH_CLASS
          )}
        >
          <ChatResourcesPanel />
        </div>
      )}

      {/* Activity bar — always rendered, pinned to the right viewport edge */}
      <div
        className={cn(
          "flex flex-col items-center gap-1 py-2 shrink-0",
          RAIL_WIDTH_CLASS
        )}
      >
        {/* Collapse / expand at the top */}
        <button
          type="button"
          onClick={toggleOpen}
          aria-label={open ? "Collapse resources sidebar" : "Expand resources sidebar"}
          title={`${open ? "Collapse" : "Expand"} (⌘⇧B)`}
          className="p-1.5 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]/50 transition-colors"
        >
          {open ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
        <div className="my-1 h-px w-6 bg-[var(--border)]" />

        {RAIL_TABS.map(({ id, label, Icon }) => {
          const count = counts[id]
          const active = tab === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                if (open && active) {
                  // Collapsing — preserve the tab so reopening lands here.
                  setOpen(false)
                } else {
                  setTab(id)
                  setOpen(true)
                }
              }}
              aria-label={label}
              aria-pressed={open && active}
              title={`${label}${count > 0 ? ` (${count})` : ""}`}
              className={cn(
                "relative p-1.5 rounded transition-colors",
                open && active
                  ? "text-[var(--foreground)] bg-[var(--accent)]/60"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]/50"
              )}
            >
              <Icon size={16} />
              {count > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-1 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] text-[9px] leading-[14px] font-medium tabular-nums">
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </aside>
  )
}
