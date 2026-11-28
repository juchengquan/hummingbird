"use client"

import { FolderOpen, StickyNote, Archive, Sparkles, Pin, Plug, Globe, KanbanSquare } from "lucide-react"
import { cn } from "@/shared/utils"
import { SKILLS } from "@/shared/skills/registry"
import { resolveSkill } from "@/shared/skills/types"
import { useActiveConversation, useActiveWorkspace } from "@/client/hooks/use-store"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  useStore,
  useWorkspaceResources,
  useConversationNotes,
  useConversationArtifacts,
  useConversationPinnedExplanations,
  useWorkspaceMcpResources,
  useConversationPrivateMcpResources,
  useWorkspaceUrlBookmarks,
  useConversationPrivateUrlBookmarks,
  useWorkspaceProjectTasks,
} from "@/client/hooks/use-store"
import { ChatResourcesPanel } from "@/components/panels/chat-resources-panel"

/**
 * Mobile counterpart to <ResourcesSidebar/>. Desktop renders the
 * activity-bar layout (hidden lg:flex); below `lg` users get a slide-in
 * Sheet triggered from the chat header.
 *
 * Tab selection comes from the same store key (`resourcesSidebarTab`),
 * so picking a tab on desktop and shrinking to mobile lands you on the
 * same content. Open/close state is local to the trigger — drawers
 * shouldn't persist open across reloads, that's modal behaviour.
 */

interface ResourcesMobileDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const TABS = [
  { id: "files" as const, label: "Files", Icon: FolderOpen },
  { id: "links" as const, label: "Links", Icon: Globe },
  { id: "notes" as const, label: "Notes", Icon: StickyNote },
  { id: "artifacts" as const, label: "Artifacts", Icon: Archive },
  { id: "mcp" as const, label: "MCP", Icon: Plug },
  { id: "pins" as const, label: "Pins", Icon: Pin },
  { id: "skills" as const, label: "Skills", Icon: Sparkles },
]

const PROJECT_TAB = { id: "project" as const, label: "Tasks", Icon: KanbanSquare }

export function ResourcesMobileDrawer({
  open,
  onOpenChange,
}: ResourcesMobileDrawerProps) {
  const tab = useStore((s) => s.resourcesSidebarTab)
  const setTab = useStore((s) => s.setResourcesSidebarTab)
  const filesCount = useWorkspaceResources().length
  const notesCount = useConversationNotes().length
  const artifactsCount = useConversationArtifacts().length
  const pinsCount = useConversationPinnedExplanations().length
  const mcpCount =
    useWorkspaceMcpResources().length + useConversationPrivateMcpResources().length
  const linksCount =
    useWorkspaceUrlBookmarks().length + useConversationPrivateUrlBookmarks().length
  const projectTasksCount = useWorkspaceProjectTasks().length
  const workspace = useActiveWorkspace()
  const conversation = useActiveConversation()
  const skillsActive = SKILLS.filter((s) =>
    resolveSkill(s, workspace?.skillPrefs, conversation?.skillPrefs)
  ).length

  const tabs = workspace?.isProject ? [PROJECT_TAB, ...TABS] : TABS

  const counts: Record<typeof tab, number> = {
    files: filesCount,
    links: linksCount,
    notes: notesCount,
    artifacts: artifactsCount,
    mcp: mcpCount,
    pins: pinsCount,
    skills: skillsActive,
    project: projectTasksCount,
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[88%] sm:max-w-sm p-0 gap-0">
        <SheetHeader className="px-3 py-2 border-b border-[var(--border)]">
          <SheetTitle className="text-sm font-medium">Resources</SheetTitle>
        </SheetHeader>

        {/* Tab strip — only used by the mobile drawer. The desktop sidebar
            uses the activity bar in <ResourcesSidebar/>. */}
        <div className="shrink-0 flex border-b border-[var(--border)]">
          {tabs.map(({ id, label, Icon }) => {
            const active = tab === id
            const count = counts[id]
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  "flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors",
                  active
                    ? "text-[var(--foreground)] border-b-2 border-[var(--primary)] -mb-px"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                )}
              >
                <Icon size={13} />
                {label}
                {count > 0 && (
                  <span className="text-[10px] text-[var(--muted-foreground)]">
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          <ChatResourcesPanel />
        </div>
      </SheetContent>
    </Sheet>
  )
}
