"use client"

import { useEffect } from "react"
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

const defaultValue: Value = [
  {
    type: "h1",
    children: [{ text: "Chat Assistant Development Prompt" }],
  },
  {
    type: "p",
    children: [{ text: "Start a conversation in the chat panel to see messages appear here." }],
  },
]

function updateEditorContent(editor: MyEditor, content: string) {
  if (!content) return

  const nodes = editor.api.markdown.deserialize(content) as Value
  editor.tf.setValue(nodes)
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

interface EditorPanelProps {
  initialContent?: string
}

export function EditorPanel({ initialContent }: EditorPanelProps) {
  const editor = usePlateEditor({
    plugins: EditorKit,
    value: defaultValue,
  })

  useEffect(() => {
    if (!editor || !initialContent) return

    updateEditorContent(editor, initialContent)
  }, [editor, initialContent])

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
        <Plate editor={editor}>
          <EditorContainer variant="default" className="h-[100vh]">
            <Editor />
          </EditorContainer>
        </Plate>
      </div>
    </div>
  )
}
