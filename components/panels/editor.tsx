"use client"

import { useEffect } from "react"
import { Plate, usePlateEditor } from "platejs/react"
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

// Helper function to convert markdown string to Plate value
function convertMarkdownToPlateValue(markdown: string, editor: MyEditor): Value {
  if (!markdown) return defaultValue
  try {
    return editor.api.markdown.deserialize(markdown) as Value
  } catch {
    return [
      {
        type: "p",
        children: [{ text: markdown }],
      },
    ]
  }
}

interface EditorPanelProps {
  initialContent?: string
}

export function EditorPanel({ initialContent }: EditorPanelProps) {
  const editor = usePlateEditor({
    plugins: EditorKit,
    value: defaultValue,
  })

  // When initialContent changes, deserialize and set the value
  useEffect(() => {
    if (!editor || !initialContent) return

    const newValue = convertMarkdownToPlateValue(initialContent, editor)
    editor.tf.setValue(newValue)
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
