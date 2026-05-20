"use client"

import { useEffect, useRef, useCallback, useState } from "react"
import { Plate, usePlateEditor } from "platejs/react"
import type { Value } from "platejs"
import { serializeMd } from "@platejs/markdown"
import { toast } from "sonner"
import { Check, Copy, Download, Loader2, Plus } from "lucide-react"
import type { MyEditor } from "@/components/editor/editor-kit"

import { EditorKit } from "@/components/editor/editor-kit"
import { Editor, EditorContainer } from "@/components/ui/editor"
import { Button } from "@/components/ui/button"
import { copyText, downloadAsFile, safeFilename } from "@/client/export"
import { useStore, useActiveDocument } from "@/client/hooks/use-store"
import { cn } from "@/shared/utils"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ResourcesSidebar } from "@/components/sidebars/resources"

const emptyValue: Value = [
  {
    type: "p",
    children: [{ text: "" }],
  },
]

function loadMarkdown(editor: MyEditor, markdown: string) {
  if (!markdown) {
    editor.tf.setValue(emptyValue)
    return
  }
  const nodes = editor.api.markdown.deserialize(markdown) as Value
  editor.tf.setValue(nodes.length > 0 ? nodes : emptyValue)
}

const SAVE_DEBOUNCE_MS = 500

function SaveIndicator({ state }: { state: "idle" | "pending" | "saved" }) {
  if (state === "idle") return null
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] text-[var(--muted-foreground)] transition-opacity",
        state === "saved" && "text-[var(--primary)]"
      )}
      aria-live="polite"
    >
      {state === "pending" ? (
        <>
          <Loader2 size={11} className="animate-spin" />
          Saving…
        </>
      ) : (
        <>
          <Check size={11} />
          Saved
        </>
      )}
    </span>
  )
}

export function EditorPanel() {
  const editor = usePlateEditor({
    plugins: EditorKit,
    value: emptyValue,
  })

  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const activeDocument = useActiveDocument()
  const createDocument = useStore((s) => s.createDocument)
  const setActiveDocument = useStore((s) => s.setActiveDocument)
  const setDocumentContent = useStore((s) => s.setDocumentContent)
  const renameDocument = useStore((s) => s.renameDocument)
  const editorReloadToken = useStore((s) => s.editorReloadToken)

  // Inline title-rename: click the title to edit. Enter / blur commits;
  // Esc cancels. Mirrors the conversation-rename UX in chat-header.
  const [titleDraft, setTitleDraft] = useState("")
  const [renamingTitle, setRenamingTitle] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (renamingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [renamingTitle])

  // Track which doc's content is currently loaded so we only reset the
  // editor when the user switches docs or an explicit reload is requested
  // (e.g. via "Send to editor").
  const loadedDocRef = useRef<string | null>(null)
  const loadedTokenRef = useRef<number>(-1)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipNextChangeRef = useRef(false)
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saved">("idle")
  const savedHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeDocId = activeDocument?.id ?? null
  const activeDocContent = activeDocument?.content ?? ""

  useEffect(() => {
    if (!editor) return
    if (
      loadedDocRef.current === activeDocId &&
      loadedTokenRef.current === editorReloadToken
    ) {
      return
    }

    // Cancel any pending save from the previous doc. We accept losing up
    // to SAVE_DEBOUNCE_MS of trailing edits rather than misattributing them.
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (savedHideTimerRef.current) {
      clearTimeout(savedHideTimerRef.current)
      savedHideTimerRef.current = null
    }
    setSaveState("idle")

    skipNextChangeRef.current = true
    loadedDocRef.current = activeDocId
    loadedTokenRef.current = editorReloadToken
    loadMarkdown(editor, activeDocContent)
  }, [editor, activeDocId, editorReloadToken, activeDocContent])

  const handleEditorChange = useCallback(() => {
    if (skipNextChangeRef.current) {
      skipNextChangeRef.current = false
      return
    }
    if (!activeDocId) return
    const targetDocId = activeDocId
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (savedHideTimerRef.current) clearTimeout(savedHideTimerRef.current)
    setSaveState("pending")
    saveTimerRef.current = setTimeout(() => {
      const md = serializeMd(editor)
      setDocumentContent(targetDocId, md)
      setSaveState("saved")
      savedHideTimerRef.current = setTimeout(() => setSaveState("idle"), 1500)
    }, SAVE_DEBOUNCE_MS)
  }, [editor, activeDocId, setDocumentContent])

  const handleExportMarkdown = () => {
    if (!activeDocument) return
    const md = serializeMd(editor)
    downloadAsFile(`${safeFilename(activeDocument.title || "document")}.md`, md)
    toast.success("Document exported")
  }

  const handleCopyMarkdown = async () => {
    try {
      await copyText(serializeMd(editor))
      toast.success("Copied as Markdown")
    } catch {
      toast.error("Failed to copy to clipboard")
    }
  }

  const handleCreateDocument = () => {
    if (!activeWorkspaceId) return
    const doc = createDocument(activeWorkspaceId)
    setActiveDocument(doc.id)
  }

  const startTitleRename = () => {
    if (!activeDocument) return
    setTitleDraft(activeDocument.title)
    setRenamingTitle(true)
  }
  const commitTitleRename = () => {
    if (!activeDocument) return
    const trimmed = titleDraft.trim()
    if (trimmed && trimmed !== activeDocument.title) {
      renameDocument(activeDocument.id, trimmed)
    }
    setRenamingTitle(false)
  }
  const cancelTitleRename = () => {
    if (activeDocument) setTitleDraft(activeDocument.title)
    setRenamingTitle(false)
  }
  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      commitTitleRename()
    } else if (e.key === "Escape") {
      e.preventDefault()
      cancelTitleRename()
    }
  }

  if (!activeWorkspaceId) {
    return (
      <div className="h-full w-full flex items-center justify-center text-sm text-[var(--muted-foreground)]">
        Select a workspace to open its documents.
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {/* Header bar — always visible. Shows the active doc's title
            (click to rename) plus actions. Switching between docs lives
            in the left sidebar's Documents section, not here. */}
        <div className="shrink-0 h-11 flex items-center gap-2 px-4 border-b border-[var(--border)]">
          <div className="md:hidden">
            <SidebarTrigger />
          </div>
          {activeDocument ? (
            renamingTitle ? (
              <input
                ref={titleInputRef}
                type="text"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={handleTitleKeyDown}
                onBlur={commitTitleRename}
                className="flex-1 min-w-0 max-w-xs px-2 py-1 text-sm font-medium bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Document title"
              />
            ) : (
              <button
                type="button"
                onClick={startTitleRename}
                className="font-medium text-sm truncate text-[var(--foreground)] hover:text-[var(--foreground)]/80 transition-colors text-left"
                title="Click to rename"
              >
                {activeDocument.title || "Untitled"}
              </button>
            )
          ) : (
            <span className="text-sm text-[var(--muted-foreground)]">No document</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <SaveIndicator state={saveState} />
            {activeDocument && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCopyMarkdown}
                  className="gap-2"
                  aria-label="Copy as Markdown"
                >
                  <Copy size={14} />
                  <span className="hidden sm:inline">Copy</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleExportMarkdown}
                  className="gap-2"
                  aria-label="Export as Markdown"
                >
                  <Download size={14} />
                  <span className="hidden sm:inline">Export</span>
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Body — editor when a doc is active, otherwise an empty CTA. */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {activeDocument ? (
            <div className="max-w-5xl mx-auto h-full">
              <Plate editor={editor} onChange={handleEditorChange}>
                <EditorContainer variant="default" className="h-full">
                  <Editor />
                </EditorContainer>
              </Plate>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-3">
              <p className="text-sm text-[var(--muted-foreground)]">
                No documents in this workspace yet.
              </p>
              <Button
                variant="default"
                size="sm"
                onClick={handleCreateDocument}
                className="gap-2"
              >
                <Plus size={14} />
                New document
              </Button>
            </div>
          )}
        </div>
      </div>
      <ResourcesSidebar />
    </div>
  )
}
