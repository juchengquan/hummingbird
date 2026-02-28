"use client"

import { ChevronsLeft } from "lucide-react"
import { useStore } from "@/lib/hooks/use-store"
import { SlidingSidebar } from "./sliding-sidebar"
import { EditorPanel } from "../panels/editor"
import MarkdownDemo from "../panels/markdown-to-slate-demo"

export function EditorSidebar() {
  const { editorPanelOpen, toggleEditorPanel, editorContent } = useStore()

  return (
    <SlidingSidebar
      isOpen={editorPanelOpen}
      onClose={toggleEditorPanel}
      closeButtonIcon={<ChevronsLeft size={20} className="text-[var(--foreground)]" />}
      closeButtonLabel="Close editor"
    >
      <EditorPanel />
    </SlidingSidebar>
  )
}
