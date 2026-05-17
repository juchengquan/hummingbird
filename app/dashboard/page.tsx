"use client"

import { useState, useEffect } from "react"
import { Toaster } from "sonner"
import { AppSidebar } from "@/components/sidebars/application"
import { ChatPanel } from "@/components/panels/chat"
import { ResourcePanel } from "@/components/panels/sources"
import { EditorPanel } from "@/components/panels/editor"
import { WorkspacesPanel } from "@/components/panels/workspaces"
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { useStore } from "@/lib/hooks/use-store"

function MainArea() {
  const activeView = useStore((state) => state.activeView)
  const editorContent = useStore((state) => state.editorContent)
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
      {activeView === "editor" && <EditorPanel initialContent={editorContent} />}
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
      <Toaster />
    </SidebarProvider>
  )
}
