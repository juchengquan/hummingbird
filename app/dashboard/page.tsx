"use client"

import dynamic from "next/dynamic"
import { Toaster } from "sonner"
import { AppSidebar } from "@/components/sidebars/application"
import { ChatPanel } from "@/components/panels/chat"
import { LibraryPanel } from "@/components/panels/library"
import { ResourcePanel } from "@/components/panels/sources"
import { WorkspacesPanel } from "@/components/panels/workspaces"
import { CommandPalette } from "@/components/command-palette"
import { PdfViewerHost } from "@/components/pdf-viewer/pdf-viewer"
import { UrlPreviewHost } from "@/components/url-viewer/url-viewer"
import { LiveArtifactHost } from "@/components/live-artifact/live-artifact-panel"
import { ImageViewerHost } from "@/components/image-viewer/image-viewer"
import { DocxViewerHost } from "@/components/docx-viewer/docx-viewer"
import { TextViewerHost } from "@/components/text-viewer/text-viewer"
import { CsvViewerHost } from "@/components/csv-viewer/csv-viewer"
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { useHydrated, useStore } from "@/client/hooks/use-store"
import { useSync } from "@/client/hooks/use-sync"
import { useReconcile } from "@/client/hooks/use-reconcile"
import { ReconcileDialog } from "@/components/auth/reconcile-dialog"
import { TaskRunProvider } from "@/client/agent/task-run-context"
import { AgentImportListener } from "@/components/agent-import-listener"
import { SkillImportListener } from "@/components/skill-import-listener"

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

// React Flow (~50KB) + the canvas node renderers only load when the user
// switches to the Canvas view — keeps it off the initial chat bundle, same
// rationale as the editor split above.
const CanvasPanel = dynamic(
  () => import("@/components/panels/canvas").then((m) => m.CanvasPanel),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full flex items-center justify-center text-sm text-[var(--muted-foreground)]">
        Loading canvas…
      </div>
    ),
  }
)

function MainArea() {
  const activeView = useStore((state) => state.activeView)
  // Wait for the persist middleware to finish loading from localStorage
  // before painting any view. Keeps SSR markup (no activeView yet) and
  // the first client paint consistent — avoids hydration mismatch on
  // `activeView` and skips a wasteful render of the default panel before
  // the persisted `activeView` lands.
  const hydrated = useHydrated()
  if (!hydrated) return null

  return (
    <SidebarInset className="h-full overflow-hidden">
      {activeView === "workspaces" && <WorkspacesPanel />}
      {activeView === "chat" && <ChatPanel />}
      {activeView === "resources" && <ResourcePanel />}
      {activeView === "editor" && <EditorPanel />}
      {activeView === "canvas" && <CanvasPanel />}
      {activeView === "library" && <LibraryPanel />}
    </SidebarInset>
  )
}

function SyncMount() {
  useSync()
  return null
}

function ReconcileMount() {
  const recon = useReconcile()
  // Two primitive selectors, NOT one object selector — Zustand v5 has no
  // default shallow comparison, so returning a fresh object would re-fire
  // every render → infinite loop.
  const workspaceCount = useStore((s) => s.workspaces.length)
  const conversationCount = useStore((s) => s.conversations.length)
  return (
    <ReconcileDialog
      open={recon.status === "prompt"}
      cloudCounts={{
        workspaces: recon.cloud?.workspaces.length ?? 0,
        conversations: recon.cloud?.conversations.length ?? 0,
      }}
      localCounts={{ workspaces: workspaceCount, conversations: conversationCount }}
      onChoose={recon.decide}
    />
  )
}

function DashboardShell() {
  const sidebarWidth = useStore((state) => state.sidebarWidth)
  const sidebarCollapsed = useStore((state) => state.sidebarCollapsed)

  return (
    <SidebarProvider
      style={{
        height: "100svh",
        minHeight: 0,
        overflow: "hidden",
        ...(!sidebarCollapsed ? { "--sidebar-width": `${sidebarWidth}px` } : {}),
      } as React.CSSProperties}
    >
      <SyncMount />
      <ReconcileMount />
      <AppSidebar />
      <AgentImportListener />
      <SkillImportListener />
      <TaskRunProvider>
        <MainArea />
      </TaskRunProvider>
      <CommandPalette />
      <PdfViewerHost />
      <UrlPreviewHost />
      <LiveArtifactHost />
      <ImageViewerHost />
      <DocxViewerHost />
      <TextViewerHost />
      <CsvViewerHost />
      <Toaster closeButton />
    </SidebarProvider>
  )
}

export default function Page() {
  return <DashboardShell />
}
