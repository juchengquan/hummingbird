"use client"

import { useState, useEffect } from "react"
import dynamic from "next/dynamic"
import { Toaster } from "sonner"
import { AppSidebar } from "@/components/sidebars/application"
import { ChatPanel } from "@/components/panels/chat"
import { ResourcePanel } from "@/components/panels/sources"
import { WorkspacesPanel } from "@/components/panels/workspaces"
import { CommandPalette } from "@/components/command-palette"
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { useStore } from "@/lib/hooks/use-store"

// Plate.js + all its plugins are heavy (~200KB pre-minify). Defer the
// editor chunk until the user actually switches to the editor view so
// the initial chat-side bundle stays light.
const EditorPanel = dynamic(
  () => import("@/components/panels/editor").then((m) => m.EditorPanel),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full flex items-center justify-center text-sm text-[var(--muted-foreground)]">
        Loading editor…
      </div>
    ),
  }
)

function MainArea() {
  const activeView = useStore((state) => state.activeView)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null

  return (
    <SidebarInset className="h-full overflow-hidden">
      {activeView === "workspaces" && <WorkspacesPanel />}
      {activeView === "chat" && <ChatPanel />}
      {activeView === "resources" && <ResourcePanel />}
      {activeView === "editor" && <EditorPanel />}
    </SidebarInset>
  )
}

export default function Page() {
  return (
    <SidebarProvider
      style={{ height: "100svh", minHeight: 0, overflow: "hidden" }}
    >
      <AppSidebar />
      <MainArea />
      <CommandPalette />
      <Toaster />
    </SidebarProvider>
  )
}
