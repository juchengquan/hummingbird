"use client"

import { useEffect } from "react"
import { Plate, PlateView, usePlateEditor } from "platejs/react"
import type { Value } from "platejs"
import type { MyEditor } from "@/components/third-party/plate/editor/editor-kit"

import { EditorKit } from "@/components/third-party/plate/editor/editor-kit"
import { Editor, EditorContainer } from "@/components/third-party/plate/ui/editor"

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

// Helper to update editor content efficiently
function updateEditorContent(editor: MyEditor, content: string) {
  if (!content) return

  // Directly deserialize and set the complete content in one operation
  const nodes = editor.api.markdown.deserialize(content) as Value
  editor.tf.setValue(nodes)
}

interface EditorPanelProps {
  initialContent?: string
}

export function EditorPanel({ initialContent }: EditorPanelProps) {
  const editor = usePlateEditor({
    plugins: EditorKit,
    value: defaultValue,
  })

  // When initialContent changes, update the editor content
  useEffect(() => {
    if (!editor || !initialContent) return

    updateEditorContent(editor, initialContent)
  }, [editor, initialContent])

  return (
    <div className="h-full w-full">
      <div className="h-full border-r-2">
        {/* mr-12 */}
        <Plate editor={editor}>
          <EditorContainer variant="default" className="h-[100vh]">
            <Editor />
          </EditorContainer>
        </Plate>
      </div>
    </div>
  )
}
