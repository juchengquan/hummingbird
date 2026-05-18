"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import "highlight.js/styles/github-dark.css"

interface CodeHighlightProps {
  code: string
  language?: string | null
  className?: string
}

/**
 * Read-only syntax-highlighted code renderer used by the artifacts preview.
 * Loads `highlight.js/lib/common` (≈36 languages) lazily on first render so
 * the panel itself stays light. Falls back to a plain `<pre>` if the dynamic
 * import fails or no highlighter result is available yet.
 */
export function CodeHighlight({ code, language, className }: CodeHighlightProps) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setHtml(null)
    import("highlight.js/lib/common").then((mod) => {
      if (!active) return
      const hljs = (mod as unknown as { default: typeof import("highlight.js/lib/common").default }).default ?? mod
      try {
        const result =
          language && hljs.getLanguage(language)
            ? hljs.highlight(code, { language, ignoreIllegals: true })
            : hljs.highlightAuto(code)
        setHtml(result.value)
      } catch {
        setHtml(null)
      }
    }).catch(() => {
      if (active) setHtml(null)
    })
    return () => {
      active = false
    }
  }, [code, language])

  return (
    <pre className={cn("text-xs p-3 overflow-auto", className)}>
      {html === null ? (
        <code className="font-mono whitespace-pre-wrap break-words">{code}</code>
      ) : (
        <code
          className="hljs font-mono whitespace-pre-wrap break-words"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </pre>
  )
}

/**
 * Pretty-prints JSON before highlighting. Falls back to raw input if the
 * payload isn't valid JSON.
 */
export function JsonHighlight({ content, className }: { content: string; className?: string }) {
  let pretty = content
  try {
    pretty = JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    /* leave raw */
  }
  return <CodeHighlight code={pretty} language="json" className={className} />
}
