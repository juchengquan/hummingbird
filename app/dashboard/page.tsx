"use client"

import { AppSidebar } from "@/components/widgets/app-sidebar"
import { ChatPanel } from "@/components/panels/chat-panel"
import { ResourcePanel } from "@/components/panels/resource-panel"
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { ResizablePanelGroup } from "@/components/ui/custom-resizable"
import { useStore } from "@/lib/hooks/use-store"

export default function Page() {
  const { resourcesPanelOpen } = useStore()

  return (
    <div className="h-screen overflow-hidden">
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="h-full">
          <ResizablePanelGroup
            showFirstPanel={resourcesPanelOpen}
            defaultFirstWidth={20}
            defaultSecondWidth={40}
            minFirstWidth={15}
            minSecondWidth={20}
            maxFirstWidth={35}
            maxSecondWidth={50}
            firstPanel={<ResourcePanel />}
            secondPanel={<ChatPanel />}
            thirdPanel={
              <div className="h-full border-l flex items-center justify-center bg-[var(--secondary)]/30">
                <p className="text-sm text-[var(--muted-foreground)]">
                  Editor panel coming soon
                </p>
              </div>
            }
          />
        </SidebarInset>
      </SidebarProvider>

    </div>
  )
}
