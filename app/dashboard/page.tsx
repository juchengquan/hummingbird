"use client"

import { useState, useEffect, useRef } from "react"
import { AppSidebar } from "@/components/sidebars/app-sidebar"
import { ChatSidebar } from "@/components/sidebars/chat-sidebar"
import { EditorSidebar } from "@/components/sidebars/editor-sidebar"
import { ResourcesNewSidebar } from "@/components/sidebars/resources-new-sidebar"
import { ResourcePanel } from "@/components/panels/resource"
import { ChatPanel } from "@/components/panels/chat"
import { EditorPanel } from "@/components/panels/editor"
import {
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar"
import { ResizablePanelGroup } from "@/components/ui/custom/resizable"
import { useStore } from "@/lib/hooks/use-store"

// Sidebar width constants (from @/components/ui/sidebar.tsx)
// SIDEBAR_WIDTH = "16rem" = 256px
// SIDEBAR_WIDTH_ICON = "3rem" = 48px
const SIDEBAR_EXPANDED_WIDTH = 256
const SIDEBAR_COLLAPSED_WIDTH = 48

function DashboardContent() {
  const { resourcesPanelOpen, editorContent } = useStore()
  const { state: sidebarState } = useSidebar()
  const containerRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  const [sidebarOffset, setSidebarOffset] = useState(0)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Calculate sidebar offset based on sidebar state and container width
  useEffect(() => {
    if (!mounted || !containerRef.current) return

    const containerWidth = containerRef.current.offsetWidth
    if (containerWidth === 0) return

    // Use sidebar width constants based on state
    const sidebarWidth = sidebarState === "expanded" ? SIDEBAR_EXPANDED_WIDTH : SIDEBAR_COLLAPSED_WIDTH
    const offsetPercent = (sidebarWidth / containerWidth) * 100
    setSidebarOffset(offsetPercent)
  }, [sidebarState, mounted])

  // Use stable default on server, then sync with store after mount
  // This prevents hydration mismatch from persisted store state
  const showFirstPanel = mounted ? resourcesPanelOpen : true

  return (
    <div ref={containerRef} className="h-full w-full">
      <ResizablePanelGroup
        showFirstPanel={showFirstPanel}
        defaultFirstWidth={15}
        defaultSecondWidth={35}
        minFirstWidth={15}
        minSecondWidth={20}
        maxFirstWidth={25}
        maxSecondWidth={50}
        offset={sidebarOffset}
        firstPanel={<ResourcePanel />}
        secondPanel={<ChatPanel />}
        thirdPanel={<EditorPanel initialContent={editorContent} />}
      />
    </div>
  )
}

export default function Page() {
  return (
    <div className="h-screen overflow-hidden">
      <SidebarProvider>
        <AppSidebar />


        
        <SidebarInset className="h-full">
          <DashboardContent />
        </SidebarInset>
        
        <ResourcesNewSidebar />
        <ChatSidebar />
        <EditorSidebar />
      </SidebarProvider>
    </div>
  )
}
