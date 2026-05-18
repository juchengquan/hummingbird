"use client"

import { useMemo } from "react"
import { marked } from "marked"
import { cn } from "@/lib/utils"
import "./markdown-preview.css"

/**
 * Read-only markdown renderer for the artifacts preview. Strips raw HTML
 * passthrough so an assistant response with `<script>` (or anything else
 * surprising) renders as escaped text instead of executing. Keeps tables,
 * lists, headings, code fences, blockquotes, and links.
 *
 * Code blocks here are rendered as plain `<pre>` — the rich
 * syntax-highlighted view lives on the `code` / `json` artifact kinds, not
 * inline in a markdown artifact. If you want fancier code rendering inside a
 * markdown artifact, save the code block as its own artifact via the
 * multi-block picker.
 */

interface MarkdownPreviewProps {
  content: string
  className?: string
}

// Configure once, module-level. Setting `gfm: true` enables tables and
// fenced code. `breaks: false` keeps line breaks meaningful only when the
// source uses real markdown line breaks.
marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    // Don't pass through raw HTML — escape it.
    html({ text }) {
      const escape = (s: string) =>
        s
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
      return escape(text)
    },
  },
})

export function MarkdownPreview({ content, className }: MarkdownPreviewProps) {
  const html = useMemo(() => {
    try {
      const out = marked.parse(content, { async: false })
      return typeof out === "string" ? out : ""
    } catch {
      return ""
    }
  }, [content])

  if (!html) {
    return (
      <pre className={cn("text-xs p-3 whitespace-pre-wrap break-words font-mono", className)}>
        {content}
      </pre>
    )
  }

  return (
    <div
      className={cn("markdown-preview text-sm p-3 overflow-auto", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
