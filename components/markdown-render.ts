import { Marked, Renderer, type Tokens } from "marked"

import {
  isExternalHttpUrl,
  isSafeImageUrl,
  isSafeLinkUrl,
} from "@/shared/safe-url"

/**
 * Markdown -> HTML for `<MarkdownPreview/>`. The output is injected via
 * `dangerouslySetInnerHTML`, so this is the XSS boundary for every
 * surface that renders model/user markdown (chat, pins, artifacts, and
 * the public share pages):
 *
 *   - raw HTML passthrough is escaped, so `<script>` renders as text;
 *   - link hrefs and image srcs must pass the `@/shared/safe-url`
 *     allowlist. `[x](javascript:...)` (inline, reference-style, or
 *     `<javascript:...>` autolink) renders as its plain text, and an
 *     unsafe image renders as its escaped alt text;
 *   - absolute http(s) links get `rel="noopener noreferrer"` so a share
 *     page's tokenised URL doesn't leak through the Referer header.
 *
 * A private `Marked` instance keeps this config from leaking into (or
 * being changed by) any other `marked` consumer.
 */
/** Escape for HTML text, leaving already-encoded entities alone (as marked does). */
function escapeText(s: string): string {
  return s
    .replace(/&(?!#?\w+;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const markdown = new Marked({
  // `gfm: true` enables tables and fenced code. `breaks: false` keeps
  // line breaks meaningful only when the source uses real markdown
  // line breaks.
  gfm: true,
  breaks: false,
  renderer: {
    // Don't pass through raw HTML -- escape it.
    html({ text }) {
      return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
    },
    link(token: Tokens.Link) {
      if (!isSafeLinkUrl(token.href)) {
        return this.parser.parseInline(token.tokens)
      }
      const out = Renderer.prototype.link.call(this, token)
      if (isExternalHttpUrl(token.href) && out.startsWith("<a ")) {
        return `<a rel="noopener noreferrer" ${out.slice(3)}`
      }
      return out
    },
    image(token: Tokens.Image) {
      if (!isSafeImageUrl(token.href)) {
        // Same fallback marked uses for an un-encodable URL: the alt
        // text, escaped, with no `<img>`.
        const alt = token.tokens
          ? this.parser.parseInline(token.tokens, this.parser.textRenderer)
          : token.text
        return escapeText(alt)
      }
      // Safe -> marked's default image renderer.
      return false
    },
  },
})

/** Render markdown to sanitized HTML. Returns "" on parser failure. */
export function renderMarkdownToHtml(content: string): string {
  const out = markdown.parse(content, { async: false })
  return typeof out === "string" ? out : ""
}
