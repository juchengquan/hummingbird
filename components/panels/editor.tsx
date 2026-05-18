"use client"

import { useEffect, useRef, useCallback } from "react"
import { Plate, usePlateEditor } from "platejs/react"
import type { Value } from "platejs"
import { serializeMd } from "@platejs/markdown"
import { toast } from "sonner"
import { Download, Copy } from "lucide-react"
import type { MyEditor } from "@/components/editor/editor-kit"

import { EditorKit } from "@/components/editor/editor-kit"
import { Editor, EditorContainer } from "@/components/ui/editor"
import { Button } from "@/components/ui/button"
import { copyText, downloadAsFile, safeFilename } from "@/lib/export"
import { useStore, useActiveConversationDocument } from "@/lib/hooks/use-store"

const emptyValue: Value = [
  {
    type: "p",
    children: [{ text: "" }],
  },
]

const placeholderValue: Value = [
  {
    type: "h1",
    children: [{ text: "Conversation document" }],
  },
  {
    type: "p",
    children: [
      {
        text: "Anything you write here is saved on this conversation. Switch conversations to see their own documents.",
      },
    ],
  },
]

function loadMarkdown(editor: MyEditor, markdown: string) {
  if (!markdown) {
    editor.tf.setValue(placeholderValue)
    return
  }
  const nodes = editor.api.markdown.deserialize(markdown) as Value
  editor.tf.setValue(nodes.length > 0 ? nodes : emptyValue)
}

function getEditorTitle(editor: MyEditor): string {
  const first = editor.children[0] as { children?: { text?: string }[] } | undefined
  if (!first) return "document"
  const text = (first.children ?? [])
    .map((c) => c.text ?? "")
    .join("")
    .trim()
  return text || "document"
}

const SAVE_DEBOUNCE_MS = 500

export function EditorPanel() {
  const editor = usePlateEditor({
    plugins: EditorKit,
    value: placeholderValue,
  })

  const activeConversationId = useStore((s) => s.activeConversationId)
  const documentContent = useActiveConversationDocument()
  const setConversationDocument = useStore((s) => s.setConversationDocument)
  const editorReloadToken = useStore((s) => s.editorReloadToken)

  // Track which conversation's content is currently loaded so we only reset
  // the editor when the user actually switches conversations or an explicit
  // reload is requested (e.g. via "Send to editor").
  const loadedConversationRef = useRef<string | null>(null)
  const loadedTokenRef = useRef<number>(-1)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipNextChangeRef = useRef(false)

  useEffect(() => {
    if (!editor) return
    if (
      loadedConversationRef.current === activeConversationId &&
      loadedTokenRef.current === editorReloadToken
    ) {
      return
    }

    // Cancel any pending save from the previous conversation. We accept losing
    // up to SAVE_DEBOUNCE_MS of trailing edits rather than misattributing them.
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    skipNextChangeRef.current = true
    loadedConversationRef.current = activeConversationId
    loadedTokenRef.current = editorReloadToken
    loadMarkdown(editor, documentContent)
  }, [editor, activeConversationId, editorReloadToken, documentContent])

  const handleEditorChange = useCallback(() => {
    if (skipNextChangeRef.current) {
      skipNextChangeRef.current = false
      return
    }
    if (!activeConversationId) return
    const targetConversationId = activeConversationId
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const md = serializeMd(editor)
      setConversationDocument(targetConversationId, md)
    }, SAVE_DEBOUNCE_MS)
  }, [editor, activeConversationId, setConversationDocument])

  const handleExportMarkdown = () => {
    const md = serializeMd(editor)
    downloadAsFile(`${safeFilename(getEditorTitle(editor))}.md`, md)
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

  if (!activeConversationId) {
    return (
      <div className="h-full w-full flex items-center justify-center text-sm text-[var(--muted-foreground)]">
        Select a conversation to open its document.
      </div>
    )
  }

  return (
    <div className="h-full w-full">
      <div className="h-full border-r-2 relative">
        <div className="absolute top-2 right-4 z-10 flex gap-1">
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
        </div>
        <Plate editor={editor} onChange={handleEditorChange}>
          <EditorContainer variant="default" className="h-[100vh]">
            <Editor />
          </EditorContainer>
        </Plate>
      </div>
    </div>
  )
}
