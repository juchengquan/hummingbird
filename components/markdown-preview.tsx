"use client"

import { useCallback, useMemo, useRef } from "react"
import { marked } from "marked"
import { cn } from "@/lib/utils"
import { usePdfViewer } from "@/components/pdf-viewer/types"
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
  /**
   * When set, `[p.N]` markers in the rendered text become clickable
   * buttons that open the PDF viewer for this file at page N.
   * Resolved by the caller from the message's attached files.
   */
  pdfCitationFileId?: string
}

const CITATION_RE = /\[p\.(\d+)\]/g

function decorateCitations(html: string, fileId: string): string {
  return html.replace(
    CITATION_RE,
    (_, page) =>
      `<button type="button" class="pdf-citation" data-citation-file="${escapeAttr(fileId)}" data-citation-page="${page}">[p.${page}]</button>`
  )
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;")
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

export function MarkdownPreview({ content, className, pdfCitationFileId }: MarkdownPreviewProps) {
  const openPdfViewer = usePdfViewer((s) => s.open)
  const containerRef = useRef<HTMLDivElement>(null)

  const html = useMemo(() => {
    try {
      const out = marked.parse(content, { async: false })
      const raw = typeof out === "string" ? out : ""
      return pdfCitationFileId ? decorateCitations(raw, pdfCitationFileId) : raw
    } catch {
      return ""
    }
  }, [content, pdfCitationFileId])

  // Event-delegated click handler for citation buttons. Lives on the
  // container so it stays attached across re-renders without React owning
  // each citation as its own element.
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("button.pdf-citation")
      if (!target) return
      const fileId = target.dataset.citationFile
      const page = Number(target.dataset.citationPage)
      if (!fileId || !Number.isFinite(page)) return
      e.preventDefault()
      e.stopPropagation()
      openPdfViewer({ fileId, page })
    },
    [openPdfViewer]
  )

  if (!html) {
    return (
      <pre className={cn("text-xs p-3 whitespace-pre-wrap break-words font-mono", className)}>
        {content}
      </pre>
    )
  }

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      className={cn("markdown-preview text-sm p-3 overflow-auto", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
