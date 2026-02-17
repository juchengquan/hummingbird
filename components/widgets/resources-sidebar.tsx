"use client"

import * as React from "react"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenuButton,
} from "@/components/ui/sidebar"
import { ResourcePanel } from "@/components/panels/resource-panel"
import { useStore } from "@/lib/hooks/use-store"

export function ResourcesSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { resourcesPanelOpen } = useStore()
  const [isVisible, setIsVisible] = React.useState(false)
  const [isAnimating, setIsAnimating] = React.useState(false)

  React.useEffect(() => {
    if (resourcesPanelOpen) {
      setIsVisible(true)
      // Start animation after mount
      requestAnimationFrame(() => {
        setIsAnimating(true)
      })
    } else {
      setIsAnimating(false)
      const timer = setTimeout(() => setIsVisible(false), 300)
      return () => clearTimeout(timer)
    }
  }, [resourcesPanelOpen])

  if (!isVisible) {
    return null
  }

  return (
    <Sidebar
      side="left"
      collapsible="none"
      {...props}
      className={`
        ${isAnimating ? "animate-sidebar-in" : "animate-sidebar-out"}
      `}
    >
      <SidebarContent className="bg-[var(--background)]">
        {/* <SidebarGroup className="h-10 flex items-center px-3 border-b border-[var(--border)]">
          <SidebarMenuButton
            onClick={toggleResourcesPanel}
            tooltip="Close Resources"
            className="w-full justify-start"
          >
            <ChevronLeft size={14} className="text-[var(--foreground)]" />
            <span className="ml-2">Resources WTF</span>
          </SidebarMenuButton>
        </SidebarGroup> */}
        <div className="flex-1 overflow-hidden">
          <ResourcePanel />
        </div>
      </SidebarContent>
    </Sidebar>
  )
}
