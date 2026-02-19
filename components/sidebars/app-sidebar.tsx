import * as React from "react"
import { FolderOpen, Plus, ChevronRight, ChevronDown, Pin, MessageSquare, PencilLine, Files } from "lucide-react"
// import { SearchForm } from "@/components/search-form"
// import { VersionSwitcher } from "@/components/version-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
// import { ConversationItem } from "@/components/panels/chat-sessions-panel"
import { useStore } from "@/lib/hooks/use-store"
import { ConversationItem } from "@/layout/conversation-item"

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {

  const {
    createConversation,
    conversations,
    activeConversationId,
    setActiveConversation,
    deleteConversation,
    renameConversation,
    togglePin,
    toggleResourcesPanel,
    openPanel,
    editorPanelOpen,
    chatPanelOpen,
    resourcesNewPanelOpen,
  } = useStore()

  const { state } = useSidebar()

  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const sidebarCollapsed = state === "collapsed"
  const [sessionsExpanded, setSessionsExpanded] = React.useState(true)

  if (!mounted) {
    return null
  }

  return (
    <Sidebar collapsible="icon" {...props} className="z-100">
      <SidebarHeader>
        <div className="flex items-center w-full">
          <SidebarTrigger className="ml-auto" />
        </div>

        <SidebarMenu>
          {/* New Session button */}
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={createConversation}
              tooltip="New Session"
            >
              <Plus className="text-[var(--foreground)]" />
              <span className="group-data-[collapsible=icon]:hidden">New Session</span>
            </SidebarMenuButton>
          </SidebarMenuItem>

          {/* Resources button */}
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Resources" onClick={toggleResourcesPanel}>
              <FolderOpen className="text-[var(--foreground)]" />
              <span className="group-data-[collapsible=icon]:hidden">Resources</span>
            </SidebarMenuButton>
          </SidebarMenuItem>

          {/* Resources New button */}
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Resources New"
              onClick={() => openPanel("resourcesNewPanelOpen")}
              isActive={resourcesNewPanelOpen}
              className={resourcesNewPanelOpen ? "bg-primary/100" : ""}
            >
              <Files className={resourcesNewPanelOpen ? "text-primary" : "text-[var(--foreground)]"} />
              <span className="group-data-[collapsible=icon]:hidden">Resources New</span>
            </SidebarMenuButton>
          </SidebarMenuItem>

          {/* Editor button */}
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Editor"
              onClick={() => openPanel("editorPanelOpen")}
              isActive={editorPanelOpen}
              className={editorPanelOpen ? "bg-primary/100" : ""}
            >
              <PencilLine className={editorPanelOpen ? "text-primary" : "text-[var(--foreground)]"} />
              <span className="group-data-[collapsible=icon]:hidden">Editor</span>
            </SidebarMenuButton>
          </SidebarMenuItem>

          {/* Chat button */}
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Chat"
              onClick={() => openPanel("chatPanelOpen")}
              isActive={chatPanelOpen}
              className={chatPanelOpen ? "bg-primary/100" : ""}
            >
              <MessageSquare className={chatPanelOpen ? "text-primary" : "text-[var(--foreground)]"} />
              <span className="group-data-[collapsible=icon]:hidden">Chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

      </SidebarHeader>
      
      <SidebarContent>
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarMenu>
            {/* Sessions section - collapsible */}
            {sidebarCollapsed ? (
              /* Collapsed view - show icons only */
              [...conversations].sort((a, b) => {
                if (a.pinned && !b.pinned) return -1
                if (!a.pinned && b.pinned) return 1
                return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
              }).map((conv) => (
                <SidebarMenuItem key={conv.id}>
                  <SidebarMenuButton
                    tooltip={conv.title}
                    isActive={activeConversationId === conv.id}
                    onClick={() => setActiveConversation(conv.id)}
                  >
                    {conv.pinned ? (
                      <Pin size={16} className="text-amber-500" />
                    ) : (
                      <MessageSquare size={16} />
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))
            ) : (
              /* Expanded view - show full list */
              <SidebarMenuItem>
                <Collapsible
                  open={sessionsExpanded}
                  onOpenChange={setSessionsExpanded}
                  defaultOpen
                  className="group/collapsible"
                >
                  <SidebarGroup>
                    <SidebarGroupLabel
                      asChild
                      className="group/label text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-sm"
                    >
                      <CollapsibleTrigger>
                        {"Sessions"}
                        <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                      </CollapsibleTrigger>
                    </SidebarGroupLabel>
                  </SidebarGroup>
                  <CollapsibleContent>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {[...conversations].sort((a, b) => {
                          if (a.pinned && !b.pinned) return -1
                          if (!a.pinned && b.pinned) return 1
                          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
                        }).map((conv) => (
                          <SidebarMenuItem key={conv.id}>
                            <ConversationItem
                              conversation={conv}
                              isActive={activeConversationId === conv.id}
                              onSelect={() => setActiveConversation(conv.id)}
                              onDelete={() => deleteConversation(conv.id)}
                              onRename={(title: string) => renameConversation(conv.id, title)}
                              onPin={() => togglePin(conv.id)}
                            />
                          </SidebarMenuItem>
                        ))}
                        {conversations.length === 0 && (
                          <div className="px-2 py-1 text-xs text-[var(--muted-foreground)]">
                            No sessions yet
                          </div>
                        )}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </CollapsibleContent>
                </Collapsible>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroup>

      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
