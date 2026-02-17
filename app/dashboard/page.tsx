"use client"

import { AppSidebar } from "@/components/widgets/app-sidebar"
import { ResourcesSidebar } from "@/components/widgets/resources-sidebar"
import { ChatPanel } from "@/components/panels/chat-panel"
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable"

export default function Page() {
  return (
    <div className="h-screen overflow-hidden">
      <SidebarProvider>
        <AppSidebar />
        <ResourcesSidebar side="left" />
        <SidebarInset className="h-full">
          <ResizablePanelGroup
            orientation="horizontal"
            className="h-full"
          >
            {/* Chat Panel */}
            <ResizablePanel
              defaultSize="40%"
              minSize="20%"
              maxSize="60%"
              className="h-full"
            >
              <ChatPanel />
            </ResizablePanel>

            <ResizableHandle withHandle />

            {/* Future Editor Panel */}
            <ResizablePanel
              defaultSize="60%"
              minSize="20%"
              maxSize="60%"
              className="h-full"
            >
              <div className="h-full border-l flex items-center justify-center bg-[var(--secondary)]/30">
                <p className="text-sm text-[var(--muted-foreground)]">
                  Editor panel coming soon
                </p>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </SidebarInset>
      </SidebarProvider>

    </div>
  )
}
