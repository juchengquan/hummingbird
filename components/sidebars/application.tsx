import * as React from "react"
import { BookOpen, LayoutDashboard, LayoutGrid, Package, Plus, ChevronRight, Pin, MessageSquare, MessagesSquare, FileText, Search, X } from "lucide-react"
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
  useWorkspacePrompts,
} from "@/client/hooks/use-store"
import { ConversationItem } from "@/components/sidebars/conversation-item"
import { DocumentItem } from "@/components/sidebars/document-item"
import { PromptItem } from "@/components/sidebars/prompt-item"
import { PromptDialog } from "@/components/panels/prompt-dialog"
import { PromptVariableFill } from "@/components/panels/prompt-variable-fill"
import { AccountMenu } from "@/components/auth/account-menu"
import type { Prompt } from "@/shared/types"

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
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)

  const workspaceConversations = useWorkspaceConversations()
  const workspaceDocuments = useWorkspaceDocuments()
  const workspacePrompts = useWorkspacePrompts()
  const { state } = useSidebar()
  const sidebarCollapsed = state === "collapsed"

  const [mounted, setMounted] = React.useState(false)
  const [sessionsExpanded, setSessionsExpanded] = React.useState(true)
  const [docsExpanded, setDocsExpanded] = React.useState(true)
  const [promptsExpanded, setPromptsExpanded] = React.useState(true)
  const [chatQuery, setChatQuery] = React.useState("")
  const [docQuery, setDocQuery] = React.useState("")
  const [promptQuery, setPromptQuery] = React.useState("")

  // Prompt dialog state. `editingPrompt === null` with `dialogOpen === true`
  // means create mode (new-prompt button); a non-null prompt means edit.
  // `varFillPrompt` carries the prompt currently in the variable-fill modal.
  const [editingPrompt, setEditingPrompt] = React.useState<Prompt | null>(null)
  const [promptDialogOpen, setPromptDialogOpen] = React.useState(false)
  const [varFillPrompt, setVarFillPrompt] = React.useState<Prompt | null>(null)

  const deletePromptAction = useStore((s) => s.deletePrompt)
  const setPendingChatInput = useStore((s) => s.setPendingChatInput)

  // Visible prompts = workspace-scoped, non-deleted, sorted by updatedAt desc,
  // optionally filtered by search query (name match only in v1).
  const filteredPrompts = React.useMemo(() => {
    const q = promptQuery.trim().toLowerCase()
    if (!q) return workspacePrompts
    return workspacePrompts.filter((p) => p.name.toLowerCase().includes(q))
  }, [workspacePrompts, promptQuery])

  const handleSelectPrompt = (prompt: Prompt) => {
    // Click-to-insert. If the prompt has no variables, the template
    // drops straight into the chat input. Otherwise the variable-fill
    // modal opens; on submit it calls setPendingChatInput itself.
    if (prompt.variables.length === 0) {
      setPendingChatInput(prompt.template)
      return
    }
    setVarFillPrompt(prompt)
  }

  const handleNewPrompt = () => {
    setEditingPrompt(null)
    setPromptDialogOpen(true)
  }

  const handleEditPrompt = (prompt: Prompt) => {
    setEditingPrompt(prompt)
    setPromptDialogOpen(true)
  }

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

      <SidebarContent className="gap-1">
        {/* 1. Workspaces (top-level tab). Editor moved to the right activity
            bar in ResourcesSidebar so workflow tools live alongside the
            context tabs (Files / Notes / Artifacts / Skills). */}
        <SidebarGroup className="mb-0">
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
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Canvas"
                onClick={() => setActiveView("canvas")}
                isActive={activeView === "canvas"}
              >
                <LayoutGrid />
                <span className="group-data-[collapsible=icon]:hidden">Canvas</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Library"
                onClick={() => setActiveView("library")}
                isActive={activeView === "library"}
              >
                <Package />
                <span className="group-data-[collapsible=icon]:hidden">Library</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {/* 2. Chats — file management moved to the right rail (`<ResourcesSidebar/>`),
            which mounts in both `chat` and `workspaces` views. The left
            sidebar no longer carries a Resources entry. */}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden py-0">
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
                      <SidebarMenu className="gap-0 max-h-56 overflow-y-auto">
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

        {/* 3. Editor — workspace-scoped editor docs. Mirrors the Chats
            section: collapsed icon-mode shows one row per doc; expanded
            mode shows a search + list with hover-revealed actions. */}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden py-0">
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
                        {"Editors"}
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
                          placeholder="Search editors…"
                          value={docQuery}
                          onChange={(e) => setDocQuery(e.target.value)}
                          className="pl-7 pr-7 h-7 text-xs"
                          aria-label="Search editors"
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
                      <SidebarMenu className="gap-0 max-h-56 overflow-y-auto">
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

        {/* 4. Prompts — user-scoped saved templates. Click a row to
            insert the prompt into the current chat input; templates
            with {variable} markers fire the variable-fill modal
            first. Mirrors the Editor section structure. Phase 1
            local-only; Phase 2 will add cross-device sync. See
            docs/_done/PLAN-prompt-library.md. */}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden py-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <Collapsible
                open={promptsExpanded}
                onOpenChange={setPromptsExpanded}
                className="group/collapsible"
              >
                <SidebarGroup className="p-0">
                  <SidebarGroupLabel
                    asChild
                    className="group/label text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-sm"
                  >
                    <CollapsibleTrigger>
                      <BookOpen size={14} className="mr-2 shrink-0" />
                      {"Prompts"}
                      <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                    </CollapsibleTrigger>
                  </SidebarGroupLabel>
                  <SidebarGroupAction
                    title="New prompt"
                    aria-label="New prompt"
                    onClick={handleNewPrompt}
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
                        placeholder="Search prompts…"
                        value={promptQuery}
                        onChange={(e) => setPromptQuery(e.target.value)}
                        className="pl-7 pr-7 h-7 text-xs"
                        aria-label="Search prompts"
                      />
                      {promptQuery && (
                        <button
                          type="button"
                          onClick={() => setPromptQuery("")}
                          aria-label="Clear search"
                          className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                    <SidebarMenu className="gap-0 max-h-56 overflow-y-auto">
                      {filteredPrompts.map((p) => (
                        <SidebarMenuItem key={p.id}>
                          <PromptItem
                            prompt={p}
                            isActive={
                              promptDialogOpen && editingPrompt?.id === p.id
                            }
                            onSelect={() => handleSelectPrompt(p)}
                            onEdit={() => handleEditPrompt(p)}
                            onDelete={() => deletePromptAction(p.id)}
                          />
                        </SidebarMenuItem>
                      ))}
                      {filteredPrompts.length === 0 && (
                        <div className="px-2 py-1 text-xs text-[var(--muted-foreground)]">
                          {promptQuery ? "No matches" : "No prompts yet"}
                        </div>
                      )}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </CollapsibleContent>
              </Collapsible>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      {/* Modal mounts — keep them inside the Sidebar tree so unmounting
          the sidebar (e.g. mobile collapse) also closes any open
          dialog state. */}
      <PromptDialog
        open={promptDialogOpen}
        onOpenChange={(open) => {
          setPromptDialogOpen(open)
          if (!open) setEditingPrompt(null)
        }}
        prompt={editingPrompt}
      />
      <PromptVariableFill
        open={varFillPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setVarFillPrompt(null)
        }}
        prompt={varFillPrompt}
        onInsert={(expanded) => {
          setPendingChatInput(expanded)
        }}
      />

      <SidebarFooter>
        <AccountMenu />
      </SidebarFooter>

      <SidebarRail />
      {!sidebarCollapsed && (
        <SidebarResizeHandle
          sidebarWidth={sidebarWidth}
          setSidebarWidth={setSidebarWidth}
        />
      )}
    </Sidebar>
  )
}

/**
 * Thin drag handle on the right edge of the left sidebar. Tracks
 * horizontal mouse drag to resize. Clamped 172–480px.
 */
function SidebarResizeHandle({
  sidebarWidth,
  setSidebarWidth,
}: {
  sidebarWidth: number
  setSidebarWidth: (w: number) => void
}) {
  const dragging = React.useRef(false)

  React.useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      setSidebarWidth(e.clientX)
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
  }, [setSidebarWidth])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={sidebarWidth}
      aria-valuemin={172}
      aria-valuemax={480}
      onMouseDown={() => {
        dragging.current = true
        document.body.style.cursor = "col-resize"
        document.body.style.userSelect = "none"
      }}
      className="absolute top-0 -right-2 w-4 h-full cursor-col-resize z-20
        after:absolute after:top-0 after:bottom-0 after:left-1/2 after:w-px after:-translate-x-px
        after:bg-[var(--border)] hover:after:bg-[var(--primary)]/40 after:transition-colors"
    />
  )
}
