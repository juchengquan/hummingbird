import * as React from "react"
import { FolderOpen, Folder, Plus, ChevronRight, Pin, MessageSquare, MessagesSquare, PencilLine, Files } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
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
import { useStore } from "@/lib/hooks/use-store"
import { useWorkspaceConversations } from "@/lib/hooks/use-store"
import { ConversationItem } from "@/components/sidebars/conversation-item"

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const {
    createConversation,
    activeConversationId,
    setActiveConversation,
    deleteConversation,
    renameConversation,
    togglePin,
    activeView,
    setActiveView,
  } = useStore()

  const workspaceConversations = useWorkspaceConversations()
  const { state } = useSidebar()
  const sidebarCollapsed = state === "collapsed"

  const [mounted, setMounted] = React.useState(false)
  const [resourcesExpanded, setResourcesExpanded] = React.useState(true)
  const [sessionsExpanded, setSessionsExpanded] = React.useState(true)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const handleSelectConversation = (id: string) => {
    setActiveConversation(id)
    setActiveView("chat")
  }

  const handleNewChat = () => {
    createConversation()
    setActiveView("chat")
  }

  if (!mounted) {
    return null
  }

  return (
    <Sidebar collapsible="icon" {...props} className="z-100">
      <SidebarHeader>
        <div className="flex items-center w-full">
          <SidebarTrigger className="ml-auto" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* 1. Workspaces + Editor (top-level tabs) */}
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Workspaces"
                onClick={() => setActiveView("workspaces")}
                isActive={activeView === "workspaces"}
              >
                <FolderOpen />
                <span className="group-data-[collapsible=icon]:hidden">Workspaces</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Editor"
                onClick={() => setActiveView("editor")}
                isActive={activeView === "editor"}
              >
                <PencilLine />
                <span className="group-data-[collapsible=icon]:hidden">Editor</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {/* 2. Resources (with Files as sub) — hidden when sidebar is icon-collapsed */}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarMenu>
            <SidebarMenuItem>
              <Collapsible
                open={resourcesExpanded}
                onOpenChange={setResourcesExpanded}
                className="group/collapsible"
              >
                <SidebarGroup className="p-0">
                  <SidebarGroupLabel
                    asChild
                    className="group/label text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-sm"
                  >
                    <CollapsibleTrigger>
                      <Folder size={14} className="mr-2 shrink-0" />
                      {"Resources"}
                      <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                    </CollapsibleTrigger>
                  </SidebarGroupLabel>
                </SidebarGroup>
                <CollapsibleContent>
                  <SidebarGroupContent>
                    <SidebarMenu className="gap-0.5">
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          tooltip="Files"
                          onClick={() => setActiveView("resources")}
                          isActive={activeView === "resources"}
                          className="h-7"
                        >
                          <Files />
                          <span className="group-data-[collapsible=icon]:hidden">Files</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroupContent>
                </CollapsibleContent>
              </Collapsible>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {/* 3. Chats */}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarMenu>
            {sidebarCollapsed ? (
              [...workspaceConversations].sort((a, b) => {
                if (a.pinned && !b.pinned) return -1
                if (!a.pinned && b.pinned) return 1
                return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
              }).map((conv) => (
                <SidebarMenuItem key={conv.id}>
                  <SidebarMenuButton
                    tooltip={conv.title}
                    isActive={activeConversationId === conv.id && activeView === "chat"}
                    onClick={() => handleSelectConversation(conv.id)}
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
              <SidebarMenuItem>
                <Collapsible
                  open={sessionsExpanded}
                  onOpenChange={setSessionsExpanded}
                  className="group/collapsible"
                >
                  <SidebarGroup className="p-0">
                    <SidebarGroupLabel
                      asChild
                      className="group/label text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-sm"
                    >
                      <CollapsibleTrigger>
                        <MessagesSquare size={14} className="mr-2 shrink-0" />
                        {"Chats"}
                        <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                      </CollapsibleTrigger>
                    </SidebarGroupLabel>
                    <SidebarGroupAction
                      title="New chat"
                      aria-label="New chat"
                      onClick={handleNewChat}
                      className="right-8"
                    >
                      <Plus />
                    </SidebarGroupAction>
                  </SidebarGroup>
                  <CollapsibleContent>
                    <SidebarGroupContent>
                      <SidebarMenu className="gap-0.5">
                        {[...workspaceConversations].sort((a, b) => {
                          if (a.pinned && !b.pinned) return -1
                          if (!a.pinned && b.pinned) return 1
                          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
                        }).map((conv) => (
                          <SidebarMenuItem key={conv.id}>
                            <ConversationItem
                              conversation={conv}
                              isActive={activeConversationId === conv.id && activeView === "chat"}
                              onSelect={() => handleSelectConversation(conv.id)}
                              onDelete={() => deleteConversation(conv.id)}
                              onRename={(title: string) => renameConversation(conv.id, title)}
                              onPin={() => togglePin(conv.id)}
                            />
                          </SidebarMenuItem>
                        ))}
                        {workspaceConversations.length === 0 && (
                          <div className="px-2 py-1 text-xs text-[var(--muted-foreground)]">
                            No chats yet
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
