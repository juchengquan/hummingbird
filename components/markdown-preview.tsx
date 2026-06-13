"use client"

import { useCallback, useMemo, useRef } from "react"
import { marked } from "marked"
import { cn } from "@/shared/utils"
import { openPdf } from "@/components/right-panel-slot"
import {
  decorateWebCitations,
  escapeAttr,
} from "@/components/panels/citation-marker"
import { mark as perfMark, count as perfCount } from "@/client/perf-chat-stream"
import type { CitationMarkerMark } from "@/shared/verify"
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
  /**
   * Number of web-search sources attached to this message. When > 0,
   * `[N]` markers (with N ≤ sourceCount) in the rendered text become
   * clickable buttons that call `onSourceClick(N)` — typically wired to
   * scroll the matching card in the Sources strip into view.
   */
  sourceCount?: number
  onSourceClick?: (index: number) => void
  /**
   * Per-`[N]` verification marks from the post-run citation pass
   * (`markerMarksFor(verification.checks)`). When a marker's claim was
   * flagged, its rendered button gets a tone class + tooltip. Optional —
   * messages without a verification render the plain clickable markers.
   */
  citationMarks?: Map<string, CitationMarkerMark>
  /**
   * When true, all `<img>` tags emitted by the markdown renderer are
   * dropped. Used by the chat bubble when the message already renders
   * its own `GeneratedImagesGallery` so the model can't double-show
   * the image by embedding a `![](url)` reference in its prose. The
   * surrounding text + caption survive; only the `<img>` is stripped.
   */
  suppressImages?: boolean
}

const PDF_CITATION_RE = /\[p\.(\d+)\]/g

function decoratePdfCitations(html: string, fileId: string): string {
  return html.replace(
    PDF_CITATION_RE,
    (_, page) =>
      `<button type="button" class="pdf-citation" data-citation-file="${escapeAttr(fileId)}" data-citation-page="${page}">[p.${page}]</button>`
  )
}

/**
 * Strip every `<img …>` tag the markdown renderer emitted. Used when
 * the chat bubble already shows a `GeneratedImagesGallery` for this
 * message — without this, models that helpfully embed `![](url)` in
 * their prose end up double-rendering the same image. We deliberately
 * leave surrounding text + captions intact; just the `<img>` goes.
 *
 * Self-closing (`<img … />`) and unclosed (`<img …>`) forms both
 * match. Tag bodies can't contain a `>` because `marked`'s HTML output
 * URI-encodes any embedded `>` inside attribute values, so a simple
 * non-greedy match is safe.
 */
const IMG_TAG_RE = /<img\b[^>]*\/?>/gi
function stripImageTags(html: string): string {
  return html.replace(IMG_TAG_RE, "")
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

export function MarkdownPreview({
  content,
  className,
  pdfCitationFileId,
  sourceCount,
  onSourceClick,
  citationMarks,
  suppressImages,
}: MarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const html = useMemo(() => {
    perfMark("humm/chat/markdown-parse:start")
    perfCount("chat.markdown.parse")
    try {
      const out = marked.parse(content, { async: false })
      let raw = typeof out === "string" ? out : ""
      if (pdfCitationFileId) raw = decoratePdfCitations(raw, pdfCitationFileId)
      if (sourceCount && sourceCount > 0)
        raw = decorateWebCitations(raw, sourceCount, citationMarks)
      if (suppressImages) raw = stripImageTags(raw)
      return raw
    } catch {
      return ""
    } finally {
      perfMark("humm/chat/markdown-parse:end")
    }
  }, [content, pdfCitationFileId, sourceCount, citationMarks, suppressImages])

  // Event-delegated click handler for citation buttons. Lives on the
  // container so it stays attached across re-renders without React owning
  // each citation as its own element.
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>(
        "button.pdf-citation, button.web-citation"
      )
      if (!target) return
      e.preventDefault()
      e.stopPropagation()
      if (target.classList.contains("pdf-citation")) {
        const fileId = target.dataset.citationFile
        const page = Number(target.dataset.citationPage)
        if (!fileId || !Number.isFinite(page)) return
        openPdf({ fileId, page })
      } else if (target.classList.contains("web-citation")) {
        const idx = Number(target.dataset.citationIndex)
        if (!Number.isFinite(idx)) return
        onSourceClick?.(idx)
      }
    },
    [onSourceClick]
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
