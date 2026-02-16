"use client"

import * as React from "react"
import { FolderOpen, ChevronLeft } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { ResourcePanel } from "@/components/panels/resource-panel"
import { useStore } from "@/lib/hooks/use-store"

export function ResourcesSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { resourcesPanelOpen, toggleResourcesPanel } = useStore()
  const [isVisible, setIsVisible] = React.useState(false)

  React.useEffect(() => {
    if (resourcesPanelOpen) {
      setIsVisible(true)
    } else {
      const timer = setTimeout(() => setIsVisible(false), 300)
      return () => clearTimeout(timer)
    }
  }, [resourcesPanelOpen])

  if (!isVisible) {
    return null
  }

  return (
    <Sidebar
      collapsible="none"
      {...props}
      className={resourcesPanelOpen
        ? "animate-in slide-in-from-left duration-300 h-screen"
        : "animate-out slide-out-to-left duration-300 h-screen"
      }
    >
      <SidebarContent className="h-full">
        <SidebarGroup className="h-10">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={toggleResourcesPanel}
                tooltip="Close Resources"
                className="w-full justify-start"
              >
                <ChevronLeft size={14} className="text-[var(--foreground)]" />
                <span className="ml-2">Resources</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <div className="h-[calc(100%-40px)] animate-in fade-in duration-500 delay-100">
          <ResourcePanel />
        </div>
      </SidebarContent>
    </Sidebar>
  )
}
