/**
 * Detect whether a code artifact (or fenced chat code block) can be
 * rendered live in the iframe surface, and which shell template to
 * use. Pure function — easy to unit-test the rules.
 *
 * The detector is intentionally generous on the "looks like HTML" /
 * "looks like SVG" sniffs because models often forget the fence
 * language. False positives are recoverable (the iframe renders the
 * code as HTML and the user sees whatever it produces); false
 * negatives just keep the existing syntax-highlighted view.
 */

export type ShellKind = "html" | "tsx" | "svg" | "mermaid"

export interface DetectInput {
  /** Fenced language (`html`, `tsx`, etc.) when known, or null. */
  language: string | null
  content: string
}

export interface DetectResult {
  renderable: boolean
  /** Which iframe-shell template to use. Null when not renderable. */
  shell: ShellKind | null
}

/** Char-count cap below which we render inline in the chat bubble
 *  instead of forcing a side-panel escalation. Tuned by feel — short
 *  TSX buttons sit comfortably inline; full landing pages don't. */
export const INLINE_RENDER_MAX_CONTENT_CHARS = 1500

const TSX_LANGS = new Set(["tsx", "jsx", "react"])
const HTML_LANGS = new Set(["html", "htm"])
const SVG_LANGS = new Set(["svg"])
const MERMAID_LANGS = new Set(["mermaid", "mmd"])

function leadingTrimmed(content: string): string {
  // Strip leading whitespace + UTF-8 BOM. Sniff checks below look at
  // the first non-blank line.
  return content.replace(/^﻿/, "").trimStart()
}

export function detectArtifactShell(input: DetectInput): DetectResult {
  const lang = input.language?.toLowerCase().trim() ?? null
  const head = leadingTrimmed(input.content)

  if (lang && TSX_LANGS.has(lang)) return { renderable: true, shell: "tsx" }
  if (lang && HTML_LANGS.has(lang)) return { renderable: true, shell: "html" }
  if (lang && SVG_LANGS.has(lang)) return { renderable: true, shell: "svg" }
  if (lang && MERMAID_LANGS.has(lang)) return { renderable: true, shell: "mermaid" }

  // Content sniffs — only run when language is missing or unknown.
  // Don't second-guess an explicit non-renderable language like
  // `python` even if the content happens to contain `<svg>`.
  if (lang && lang.length > 0 && !UNKNOWN_LANGS_OK_TO_SNIFF.has(lang)) {
    return { renderable: false, shell: null }
  }

  if (/^<!doctype\s+html/i.test(head)) return { renderable: true, shell: "html" }
  // `<svg ` / `<svg>` / `<svg/>` all valid — accept whitespace, `>`, or `/`.
  if (/^<svg[\s>/]/i.test(head)) return { renderable: true, shell: "svg" }
  if (/^<html[\s>]/i.test(head)) return { renderable: true, shell: "html" }

  return { renderable: false, shell: null }
}

/** Languages we allow content-sniffing for when the language is set
 *  but unknown. `text`, `plain`, and empty all qualify; everything
 *  else (`python`, `bash`, `sql`, `json`, …) is explicitly opted out
 *  because misclassifying them as HTML would be worse than missing
 *  an occasional unfenced doc. */
const UNKNOWN_LANGS_OK_TO_SNIFF = new Set(["text", "plain", "txt", "markup"])

export function isSmallEnoughForInline(content: string): boolean {
  return content.length <= INLINE_RENDER_MAX_CONTENT_CHARS
}
