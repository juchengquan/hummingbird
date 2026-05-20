import * as React from "react"
import { LayoutDashboard, Plus, ChevronRight, Pin, MessageSquare, MessagesSquare, FileText, Search, X } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
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
import { useStore } from "@/client/hooks/use-store"
import {
  useWorkspaceConversations,
  useWorkspaceDocuments,
} from "@/client/hooks/use-store"
import { ConversationItem } from "@/components/sidebars/conversation-item"
import { DocumentItem } from "@/components/sidebars/document-item"
import { AccountMenu } from "@/components/auth/account-menu"
import { ThemeToggle } from "@/components/theme-toggle"
import { HelpPopover } from "@/components/help-popover"

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
    activeWorkspaceId,
    activeDocumentId,
    setActiveDocument,
    createDocument,
    renameDocument,
    deleteDocument,
  } = useStore()

  const workspaceConversations = useWorkspaceConversations()
  const workspaceDocuments = useWorkspaceDocuments()
  const { state } = useSidebar()
  const sidebarCollapsed = state === "collapsed"

  const [mounted, setMounted] = React.useState(false)
  const [sessionsExpanded, setSessionsExpanded] = React.useState(true)
  const [docsExpanded, setDocsExpanded] = React.useState(true)
  const [chatQuery, setChatQuery] = React.useState("")
  const [docQuery, setDocQuery] = React.useState("")

  const filteredConversations = React.useMemo(() => {
    const q = chatQuery.trim().toLowerCase()
    if (!q) return workspaceConversations
    return workspaceConversations.filter((c) => {
      if (c.title.toLowerCase().includes(q)) return true
      return c.messages.some((m) => m.content.toLowerCase().includes(q))
    })
  }, [workspaceConversations, chatQuery])

  const filteredDocuments = React.useMemo(() => {
    const q = docQuery.trim().toLowerCase()
    if (!q) return workspaceDocuments
    return workspaceDocuments.filter((d) => {
      if (d.title.toLowerCase().includes(q)) return true
      return d.content.toLowerCase().includes(q)
    })
  }, [workspaceDocuments, docQuery])

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

  const handleSelectDocument = (id: string) => {
    setActiveDocument(id)
    setActiveView("editor")
  }

  const handleNewDocument = () => {
    if (!activeWorkspaceId) return
    const doc = createDocument(activeWorkspaceId)
    setActiveDocument(doc.id)
    setActiveView("editor")
  }

  if (!mounted) {
    return null
  }

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <div className="flex items-center w-full">
          <SidebarTrigger className="ml-auto shrink-0" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* 1. Workspaces (top-level tab). Editor moved to the right activity
            bar in ResourcesSidebar so workflow tools live alongside the
            context tabs (Files / Notes / Artifacts / Skills). */}
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Workspaces"
                onClick={() => setActiveView("workspaces")}
                isActive={activeView === "workspaces"}
              >
                <LayoutDashboard />
                <span className="group-data-[collapsible=icon]:hidden">Workspaces</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {/* 2. Chats — file management moved to the right rail (`<ResourcesSidebar/>`),
            which mounts in both `chat` and `workspaces` views. The left
            sidebar no longer carries a Resources entry. */}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarMenu>
            {sidebarCollapsed ? (
              [...filteredConversations].sort((a, b) => {
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
                      className="right-8 top-1.5"
                    >
                      <Plus />
                    </SidebarGroupAction>
                  </SidebarGroup>
                  <CollapsibleContent>
                    <SidebarGroupContent>
                      <div className="relative px-2 pb-1.5 pt-1">
                        <Search
                          size={12}
                          className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] pointer-events-none"
                        />
                        <SidebarInput
                          placeholder="Search chats…"
                          value={chatQuery}
                          onChange={(e) => setChatQuery(e.target.value)}
                          className="pl-7 pr-7 h-7 text-xs"
                          aria-label="Search conversations"
                        />
                        {chatQuery && (
                          <button
                            type="button"
                            onClick={() => setChatQuery("")}
                            aria-label="Clear search"
                            className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                      <SidebarMenu className="gap-0.5">
                        {[...filteredConversations].sort((a, b) => {
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
                        {filteredConversations.length === 0 && (
                          <div className="px-2 py-1 text-xs text-[var(--muted-foreground)]">
                            {chatQuery ? "No matches" : "No chats yet"}
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

        {/* 3. Documents — workspace-scoped editor docs. Mirrors the Chats
            section: collapsed icon-mode shows one row per doc; expanded
            mode shows a search + list with hover-revealed actions. */}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarMenu>
            {sidebarCollapsed ? (
              filteredDocuments.map((doc) => (
                <SidebarMenuItem key={doc.id}>
                  <SidebarMenuButton
                    tooltip={doc.title || "Untitled"}
                    isActive={activeDocumentId === doc.id && activeView === "editor"}
                    onClick={() => handleSelectDocument(doc.id)}
                  >
                    <FileText size={16} />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))
            ) : (
              <SidebarMenuItem>
                <Collapsible
                  open={docsExpanded}
                  onOpenChange={setDocsExpanded}
                  className="group/collapsible"
                >
                  <SidebarGroup className="p-0">
                    <SidebarGroupLabel
                      asChild
                      className="group/label text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-sm"
                    >
                      <CollapsibleTrigger>
                        <FileText size={14} className="mr-2 shrink-0" />
                        {"Documents"}
                        <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                      </CollapsibleTrigger>
                    </SidebarGroupLabel>
                    <SidebarGroupAction
                      title="New document"
                      aria-label="New document"
                      onClick={handleNewDocument}
                      className="right-8 top-1.5"
                    >
                      <Plus />
                    </SidebarGroupAction>
                  </SidebarGroup>
                  <CollapsibleContent>
                    <SidebarGroupContent>
                      <div className="relative px-2 pb-1.5 pt-1">
                        <Search
                          size={12}
                          className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] pointer-events-none"
                        />
                        <SidebarInput
                          placeholder="Search documents…"
                          value={docQuery}
                          onChange={(e) => setDocQuery(e.target.value)}
                          className="pl-7 pr-7 h-7 text-xs"
                          aria-label="Search documents"
                        />
                        {docQuery && (
                          <button
                            type="button"
                            onClick={() => setDocQuery("")}
                            aria-label="Clear search"
                            className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                      <SidebarMenu className="gap-0.5">
                        {filteredDocuments.map((doc) => (
                          <SidebarMenuItem key={doc.id}>
                            <DocumentItem
                              document={doc}
                              isActive={activeDocumentId === doc.id && activeView === "editor"}
                              onSelect={() => handleSelectDocument(doc.id)}
                              onRename={(title: string) => renameDocument(doc.id, title)}
                              onDelete={() => deleteDocument(doc.id)}
                            />
                          </SidebarMenuItem>
                        ))}
                        {filteredDocuments.length === 0 && (
                          <div className="px-2 py-1 text-xs text-[var(--muted-foreground)]">
                            {docQuery ? "No matches" : "No documents yet"}
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

      <SidebarFooter>
        <div className="flex items-center w-full gap-1">
          <div className="flex-1 min-w-0">
            <AccountMenu />
          </div>
          {/* Help + Theme toggle are extra utilities — hide them in
              icon-collapsed mode so only the account icon remains. */}
          <div className="flex items-center gap-1 shrink-0 group-data-[collapsible=icon]:hidden">
            <HelpPopover />
            <ThemeToggle />
          </div>
        </div>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
