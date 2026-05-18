"use client"

import { useEffect, useRef } from "react"
import { ChevronLeft, ChevronRight, FolderOpen, StickyNote, Archive } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStore, useWorkspaceResources, useConversationNotes, useConversationArtifacts } from "@/lib/hooks/use-store"
import { ChatResourcesPanel } from "@/components/panels/chat-resources-panel"

const RAIL_TABS = [
  { id: "files" as const, label: "Files", Icon: FolderOpen },
  { id: "notes" as const, label: "Notes", Icon: StickyNote },
  { id: "artifacts" as const, label: "Artifacts", Icon: Archive },
]

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
  // user hasn't toggled since the v6 migration seeded `true`. We can't
  // distinguish that perfectly, so use a sessionStorage marker.
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
        "hidden lg:flex flex-col h-full min-h-0 shrink-0 border-l border-[var(--border)] bg-[var(--background)]/60",
        "transition-[width] duration-200 ease-out",
        open ? "w-80" : "w-12"
      )}
    >
      {open ? (
        <>
          <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
            <span className="text-xs font-medium text-[var(--foreground)]">Resources</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Collapse resources sidebar"
              title="Collapse (⌘⇧B)"
              className="p-1 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]/50 transition-colors"
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <ChatResourcesPanel />
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center gap-1 py-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Expand resources sidebar"
            title="Expand (⌘⇧B)"
            className="p-1.5 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]/50 transition-colors"
          >
            <ChevronLeft size={14} />
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
                  setTab(id)
                  setOpen(true)
                }}
                aria-label={label}
                title={`${label}${count > 0 ? ` (${count})` : ""}`}
                className={cn(
                  "relative p-1.5 rounded transition-colors",
                  active
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
      )}
    </aside>
  )
}
