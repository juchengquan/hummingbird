"use client"

import { useEffect, useRef } from "react"
import { PanelRightClose, PanelRightOpen, FolderOpen, StickyNote, Archive, Sparkles, FileText, Pin, Plug, Globe, MessagesSquare, KanbanSquare } from "lucide-react"
import { cn } from "@/shared/utils"
import {
  useStore,
  useWorkspaceResources,
  useWorkspaceNotes,
  useWorkspaceArtifacts,
  useActiveWorkspace,
  useActiveConversation,
  useConversationPinnedExplanations,
  useWorkspaceMcpResources,
  useWorkspaceUrlBookmarks,
  useWorkspaceProjectTasks,
} from "@/client/hooks/use-store"
import { ChatResourcesPanel } from "@/components/panels/chat-resources-panel"
import { SKILLS } from "@/shared/skills/registry"
import { resolveSkill } from "@/shared/skills/types"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

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
// Rail tab order: per-conversation content (Files / Notes / Artifacts /
// Pins) first, then capability / integration tabs (Links / MCP / Skills)
// at the tail — they get reached for less often, so putting them last
// keeps the most-used icons within easy thumb reach at the top.
const ALL_RAIL_TABS = [
  { id: "files" as const, label: "Files", Icon: FolderOpen },
  { id: "links" as const, label: "Links", Icon: Globe },
  { id: "notes" as const, label: "Notes", Icon: StickyNote },
  { id: "artifacts" as const, label: "Artifacts", Icon: Archive },
  { id: "pins" as const, label: "Pins", Icon: Pin },
  { id: "mcp" as const, label: "MCP", Icon: Plug },
  { id: "skills" as const, label: "Skills", Icon: Sparkles },
]

// Project-board tab — only shown for project-mode workspaces, prepended
// ahead of the everyday tabs (it's the primary surface for a project).
const PROJECT_TAB = { id: "project" as const, label: "Tasks", Icon: KanbanSquare }

// Width tokens picked so the open total (icon bar + content) equals the
// previous w-80 (320px), keeping the chat column width unchanged for users.
const RAIL_WIDTH_CLASS = "w-12" // 48px

interface ResourcesSidebarProps {
  /**
   * `chat` (default): all four tabs (Files/Notes/Artifacts/Skills),
   * conversation-scoped Files behavior, persisted active tab.
   *
   * `workspaces`: Files-only rail. `ChatResourcesPanel` runs in `manage`
   * mode (no attach checkboxes, per-row delete, no conversation footer).
   * Used by `WorkspacesPanel` so users can manage workspace files without
   * leaving the workspaces grid.
   */
  mode?: "chat" | "workspaces"
}

export function ResourcesSidebar({ mode = "chat" }: ResourcesSidebarProps = {}) {
  const isWorkspaceMode = mode === "workspaces"

  const open = useStore((s) => s.resourcesSidebarOpen)
  const tab = useStore((s) => s.resourcesSidebarTab)
  const setOpen = useStore((s) => s.setResourcesSidebarOpen)
  const toggleOpen = useStore((s) => s.toggleResourcesSidebar)
  const setTab = useStore((s) => s.setResourcesSidebarTab)
  const panelWidth = useStore((s) => s.resourcesSidebarWidth)
  const setPanelWidth = useStore((s) => s.setResourcesSidebarWidth)
  const activeView = useStore((s) => s.activeView)
  const setActiveView = useStore((s) => s.setActiveView)
  const resourcesCount = useWorkspaceResources().length
  const notesCount = useWorkspaceNotes().length
  const artifactsCount = useWorkspaceArtifacts().length
  const pinsCount = useConversationPinnedExplanations().length
  const mcpCount = useWorkspaceMcpResources().length
  const linksCount = useWorkspaceUrlBookmarks().length
  const projectTasksCount = useWorkspaceProjectTasks().length
  const workspace = useActiveWorkspace()
  const conversation = useActiveConversation()
  const skillsActive = SKILLS.filter((s) =>
    resolveSkill(s, workspace?.skillPrefs, conversation?.skillPrefs)
  ).length

  // Project-mode workspaces get the Tasks board tab at the head of the
  // rail; everyone gets the standard set.
  const railTabs = workspace?.isProject
    ? [PROJECT_TAB, ...ALL_RAIL_TABS]
    : ALL_RAIL_TABS

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

  // Cmd/Ctrl+Shift+B toggles the right resources sidebar. `e.key` can be
  // undefined for composition events / some password-manager autofills, so
  // guard it before lowercasing.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key?.toLowerCase() === "b" &&
        e.shiftKey &&
        (e.metaKey || e.ctrlKey)
      ) {
        e.preventDefault()
        toggleOpen()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [toggleOpen])

  const counts: Record<typeof tab, number> = {
    files: resourcesCount,
    links: linksCount,
    notes: notesCount,
    artifacts: artifactsCount,
    mcp: mcpCount,
    pins: pinsCount,
    skills: skillsActive,
    project: projectTasksCount,
  }

  return (
    <aside
      data-state={open ? "expanded" : "collapsed"}
      className={cn(
        "hidden lg:flex flex-row h-full min-h-0 shrink-0 bg-[var(--background)]/60"
      )}
    >
      {/* Content panel — its WIDTH animates 0 ↔ 272px so the activity bar
          stays anchored at the viewport's right edge. The inner panel keeps
          a fixed width so its layout doesn't reflow mid-transition; overflow
          on the outer wrapper clips it cleanly. Border lives on the left so
          it slides in with the panel rather than reappearing late. */}
      <div
        className={cn(
          "h-full min-h-0 shrink-0 overflow-hidden relative",
          "transition-[width] duration-200 ease-out",
          open
            ? "border-l border-[var(--border)]"
            : "w-0 border-l-0"
        )}
        style={open ? { width: panelWidth } : undefined}
        aria-hidden={!open}
      >
        <div
          className="flex flex-col h-full min-h-0"
          style={{ width: panelWidth }}
        >
          <ChatResourcesPanel mode={isWorkspaceMode ? "manage" : "chat"} />
        </div>
        {open && (
          <RightRailResizeHandle
            panelWidth={panelWidth}
            setPanelWidth={setPanelWidth}
          />
        )}
      </div>

      {/* Activity bar — always rendered at fixed width; its position never
          changes when the content panel expands or collapses. The left
          border anchors it visually whether or not the content is open. */}
      <div
        className={cn(
          "flex flex-col items-center gap-1 py-2 shrink-0 border-l border-[var(--border)]",
          RAIL_WIDTH_CLASS
        )}
      >
        {/* Collapse / expand at the top — structural panel control. */}
        <button
          type="button"
          onClick={toggleOpen}
          aria-label={open ? "Collapse resources sidebar" : "Expand resources sidebar"}
          className="p-1.5 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]/50 transition-colors"
        >
          {open ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
        <div className="my-1 h-px w-6 bg-[var(--border)]" />

        {/* Editor/Chat quick-switch — context-sensitive launcher.
            When viewing Chat → opens Editor. When viewing Editor →
            opens Chat. Otherwise → opens Editor (default). */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() =>
                setActiveView(activeView === "editor" ? "chat" : "editor")
              }
              aria-label={activeView === "editor" ? "Chat" : "Editor"}
              className={cn(
                "p-1.5 rounded transition-colors",
                activeView === "editor"
                  ? "text-[var(--foreground)] bg-[var(--accent)]/60"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]/50"
              )}
            >
              {activeView === "editor" ? (
                <MessagesSquare size={16} />
              ) : (
                <FileText size={16} />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={6}>
            {activeView === "editor" ? "Chat" : "Editor"}
          </TooltipContent>
        </Tooltip>
        <div className="my-1 h-px w-6 bg-[var(--border)]" />

        {railTabs.map((t) => (
          <RailTabButton
            key={t.id}
            id={t.id}
            label={t.label}
            Icon={t.Icon}
            count={counts[t.id]}
            active={tab === t.id}
            open={open}
            onActivate={() => {
              if (open && tab === t.id) setOpen(false)
              else {
                setTab(t.id)
                setOpen(true)
              }
            }}
          />
        ))}
      </div>
    </aside>
  )
}

/**
 * A single tab button in the right-rail activity bar. Extracted so the
 * top and bottom tab groups share identical rendering — icon + active
 * state + count badge + tooltip — without duplicating the JSX.
 *
 * `count` of 0 hides the badge; > 99 shows "99+" to keep the badge a
 * stable width.
 */
function RailTabButton({
  id,
  label,
  Icon,
  count,
  active,
  open,
  onActivate,
}: {
  id: string
  label: string
  Icon: React.ComponentType<{ size?: number; className?: string }>
  count: number
  active: boolean
  open: boolean
  onActivate: () => void
}) {
  return (
    <Tooltip key={id}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onActivate}
          aria-label={label}
          aria-pressed={open && active}
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
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={6}>
        {label}
        {count > 0 && <span className="opacity-60 ml-1">({count})</span>}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Drag handle on the LEFT edge of the right-rail content panel.
 * Tracks horizontal mouse drag to resize the panel. The panel
 * is anchored to the right edge, so dragging left increases width,
 * dragging right decreases it. Clamped 200–400px.
 */
function RightRailResizeHandle({
  panelWidth,
  setPanelWidth,
}: {
  panelWidth: number
  setPanelWidth: (w: number) => void
}) {
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(panelWidth)

  useEffect(() => {
    startWidth.current = panelWidth
  }, [panelWidth])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      // Panel is right-aligned. Dragging left (dx < 0) → wider.
      const dx = startX.current - e.clientX
      setPanelWidth(startWidth.current + dx)
    }
    const onUp = () => {
      dragging.current = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    return () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
  }, [setPanelWidth])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={panelWidth}
      aria-valuemin={200}
      aria-valuemax={400}
      onMouseDown={(e) => {
        dragging.current = true
        startX.current = e.clientX
        startWidth.current = panelWidth
        document.body.style.cursor = "col-resize"
        document.body.style.userSelect = "none"
      }}
      className="absolute top-0 -left-2 w-4 h-full cursor-col-resize z-20
        after:absolute after:top-0 after:bottom-0 after:left-1/2 after:w-px after:-translate-x-px
        after:bg-[var(--border)] hover:after:bg-[var(--primary)]/40 after:transition-colors"
    />
  )
}
