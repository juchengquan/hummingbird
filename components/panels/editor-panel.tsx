"use client"

import { Plate, usePlateEditor } from "platejs/react"

import { EditorKit } from "@/components/third-party/plate/editor/editor-kit"
import { Editor, EditorContainer } from "@/components/third-party/plate/ui/editor"

const initialValue = [
  {
    type: "h1",
    children: [{ text: "Chat Assistant Development Prompt" }],
  },
  {
    type: "h2",
    children: [{ text: "Project Overview" }],
  },
  {
    type: "p",
    children: [{ text: "I want you to build a general-purpose chat assistant (chat agent) application that allows users to upload files and interact with AI in two distinct modes: conversational chat and research/writing mode. The application should provide a seamless user experience with modern UI design and robust functionality." }],
  },
  {
    type: "h2",
    children: [{ text: "Core Features Requirements" }],
  },
  {
    type: "h3",
    children: [{ text: "1. Chat Mode" }],
  },
  {
    type: "ul",
    children: [
      { type: "li", children: [{ type: "lic", children: [{ text: "Conversational UI with message history" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Real-time message streaming" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Support for text, images, and file attachments" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Message editing and deletion" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Conversation history management (save, load, delete conversations)" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Keyboard shortcuts for common actions" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Responsive design for all device sizes" }] }] },
    ],
  },
  {
    type: "h3",
    children: [{ text: "2. Research (Write) Mode" }],
  },
  {
    type: "ul",
    children: [
      { type: "li", children: [{ type: "lic", children: [{ text: "File upload support (PDF, DOCX, TXT, CSV, JSON)" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Web search integration" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Content analysis and summarization" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Report generation with structured formatting" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Citation management" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Export functionality (PDF, DOCX, Markdown)" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Collaborative editing features" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Version history for generated reports" }] }] },
    ],
  },
  {
    type: "h3",
    children: [{ text: "3. File Management" }],
  },
  {
    type: "ul",
    children: [
      { type: "li", children: [{ type: "lic", children: [{ text: "File upload and storage" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "File preview functionality" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "File organization (folders, tags)" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "File search and filtering" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "File sharing capabilities" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "File access permissions" }] }] },
    ],
  },
  {
    type: "h2",
    children: [{ text: "Technical Stack Requirements" }],
  },
  {
    type: "h3",
    children: [{ text: "Core Technologies" }],
  },
  {
    type: "ul",
    children: [
      { type: "li", children: [{ type: "lic", children: [{ text: "Runtime: Bun" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Framework: Next.js 14+ with App Router" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "Language: TypeScript" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "UI Library: React 18+" }] }] },
    ],
  },
  {
    type: "h3",
    children: [{ text: "UI Components" }],
  },
  {
    type: "ul",
    children: [
      { type: "li", children: [{ type: "lic", children: [{ text: "Radix UI: For accessible, unstyled components" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "chadcn/ui: For styled components and design system" }] }] },
      { type: "li", children: [{ type: "lic", children: [{ text: "platejs: For rich text editing functionality" }] }] },
    ],
  },
  {
    type: "p",
    children: [{ text: "(注：文档部分内容可能由 AI 生成）" }],
  },
]

export function EditorPanel() {
  const editor = usePlateEditor({
    plugins: EditorKit,
    value: initialValue,
  })

  return (
    <div className="h-full w-full">
      <div className="h-full mr-12 border-r-2">
        <Plate editor={editor}>
          <EditorContainer variant="demo">
            <Editor />
          </EditorContainer>
        </Plate>
      </div>
    </div>
  )
}
