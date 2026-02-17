import * as React from "react"
import { FolderOpen, Plus, ChevronRight, ChevronDown, Pin, MessageSquare } from "lucide-react"
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

// This is sample data.
const data = {
  versions: ["1.0.1", "1.1.0-alpha", "2.0.0-beta1"],
  navMain: [
    {
      title: "Getting Started",
      url: "#",
      items: [
        {
          title: "Installation",
          url: "#",
        },
        {
          title: "Project Structure",
          url: "#",
        },
      ],
    },
    {
      title: "Build Your Application",
      url: "#",
      items: [
        {
          title: "Routing",
          url: "#",
        },
        {
          title: "Data Fetching",
          url: "#",
          isActive: true,
        },
        {
          title: "Rendering",
          url: "#",
        },
        {
          title: "Caching",
          url: "#",
        },
        {
          title: "Styling",
          url: "#",
        },
        {
          title: "Optimizing",
          url: "#",
        },
        {
          title: "Configuring",
          url: "#",
        },
        {
          title: "Testing",
          url: "#",
        },
        {
          title: "Authentication",
          url: "#",
        },
        {
          title: "Deploying",
          url: "#",
        },
        {
          title: "Upgrading",
          url: "#",
        },
        {
          title: "Examples",
          url: "#",
        },
      ],
    },
    {
      title: "API Reference",
      url: "#",
      items: [
        {
          title: "Components",
          url: "#",
        },
        {
          title: "File Conventions",
          url: "#",
        },
        {
          title: "Functions",
          url: "#",
        },
        {
          title: "next.config.js Options",
          url: "#",
        },
        {
          title: "CLI",
          url: "#",
        },
        {
          title: "Edge Runtime",
          url: "#",
        },
      ],
    },
    {
      title: "Architecture",
      url: "#",
      items: [
        {
          title: "Accessibility",
          url: "#",
        },
        {
          title: "Fast Refresh",
          url: "#",
        },
        {
          title: "Next.js Compiler",
          url: "#",
        },
        {
          title: "Supported Browsers",
          url: "#",
        },
        {
          title: "Turbopack",
          url: "#",
        },
      ],
    },
  ],
}

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
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <div className="flex items-center w-full">
          <SidebarTrigger className="ml-auto" />
        </div>
        {/* <VersionSwitcher
          versions={data.versions}
          defaultVersion={data.versions[0]}
        />
        <SearchForm /> */}

          <SidebarMenu>
            {/* New Session button */}
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={createConversation}
                tooltip="New Session"
              >
                <Plus size={14} className="text-[var(--foreground)]" />
                <span className="group-data-[collapsible=icon]:hidden">New Session</span>
              </SidebarMenuButton>
            </SidebarMenuItem>

            {/* Resources button */}
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Resources" onClick={toggleResourcesPanel}>
                <FolderOpen size={14} className="text-[var(--foreground)]" />
                <span className="group-data-[collapsible=icon]:hidden">Resources</span>
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
