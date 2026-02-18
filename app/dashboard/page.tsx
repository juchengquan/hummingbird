"use client"

import { useState, useEffect } from "react"
import { AppSidebar } from "@/components/sidebars/app-sidebar"
import { ResourcePanel } from "@/components/panels/resource"
import { ChatPanel } from "@/components/panels/chat"
import { EditorPanel } from "@/components/panels/editor"
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { ResizablePanelGroup } from "@/components/ui/custom/resizable"
import { useStore } from "@/lib/hooks/use-store"

function DashboardContent() {
  const { resourcesPanelOpen } = useStore()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

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
        thirdPanel={<EditorPanel />}
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
      </SidebarProvider>
    </div>
  )
}
