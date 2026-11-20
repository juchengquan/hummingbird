import { Marked, Renderer, type Tokens } from "marked"

import {
  isExternalHttpUrl,
  httpOriginOf,
  isSafeLinkUrl,
  markdownImagePolicy,
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
 *     page's tokenised URL doesn't leak through the Referer header;
 *   - remote images are click-to-load (`markdownImagePolicy`): a
 *     placeholder button naming the host, until the viewer loads it
 *     (`loadedRemoteImages`). The app's own Supabase storage, raster
 *     `data:`, `blob:` and relative images load immediately.
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
      const policy = markdownImagePolicy(token.href, renderContext.trustedOrigins)
      // Escaped alt text (as plain text: formatting dropped).
      const alt = () =>
        escapeText(
          token.tokens
            ? this.parser.parseInline(token.tokens, this.parser.textRenderer)
            : token.text
        )
      if (policy.kind === "blocked") {
        // Same fallback marked uses for an un-encodable URL: the alt
        // text, escaped, with no `<img>`.
        return alt()
      }
      if (policy.kind === "click" && !renderContext.loaded.has(token.href)) {
        return remoteImagePlaceholder(token.href, policy.host, alt())
      }
      const out = Renderer.prototype.image.call(this, token)
      if (policy.kind === "click" && out.startsWith("<img ")) {
        // Loaded on request: still don't hand the host our URL (a share
        // page's is tokenised) via Referer.
        return `<img referrerpolicy="no-referrer" ${out.slice(5)}`
      }
      return out
    },
  },
})

/** Strict attribute escape that round-trips through `dataset`. */
function escapeAttrStrict(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/** Data attribute carrying a click-to-load image's URL. The component
 *  (`MarkdownPreview`) handles the click by event delegation — no inline
 *  handler (CSP) — and re-renders with the URL in `loadedRemoteImages`. */
export const REMOTE_IMAGE_SRC_ATTR = "data-remote-image-src"

function remoteImagePlaceholder(href: string, host: string, altHtml: string): string {
  const label = altHtml ? `<span class="md-remote-image-alt">${altHtml}</span>` : ""
  return (
    `<button type="button" class="md-remote-image" ${REMOTE_IMAGE_SRC_ATTR}="${escapeAttrStrict(href)}"` +
    ` title="Load image from ${escapeAttrStrict(host)}">` +
    `${label}<span class="md-remote-image-host">${escapeText(host)}</span>` +
    `<span class="md-remote-image-action">Load image</span></button>`
  )
}

export interface MarkdownRenderOptions {
  /** Remote image URLs the viewer chose to load ("Load image" click). */
  loadedRemoteImages?: ReadonlySet<string>
  /** Origins whose images load without a click. Defaults to the app's
   *  Supabase origin (`NEXT_PUBLIC_SUPABASE_URL`) — its storage serves
   *  the app's own images. */
  trustedImageOrigins?: readonly string[]
}

const DEFAULT_TRUSTED_IMAGE_ORIGINS: readonly string[] = (() => {
  const supabase = httpOriginOf(process.env.NEXT_PUBLIC_SUPABASE_URL)
  return supabase ? [supabase] : []
})()

const NO_LOADED: ReadonlySet<string> = new Set()

/** Per-parse options, read by the renderer callbacks. `parse` is
 *  synchronous, so a module-level slot set around it is safe. */
let renderContext: { loaded: ReadonlySet<string>; trustedOrigins: readonly string[] } = {
  loaded: NO_LOADED,
  trustedOrigins: DEFAULT_TRUSTED_IMAGE_ORIGINS,
}

/** Render markdown to sanitized HTML. Returns "" on parser failure. */
export function renderMarkdownToHtml(
  content: string,
  opts: MarkdownRenderOptions = {}
): string {
  const prev = renderContext
  renderContext = {
    loaded: opts.loadedRemoteImages ?? NO_LOADED,
    trustedOrigins: opts.trustedImageOrigins ?? DEFAULT_TRUSTED_IMAGE_ORIGINS,
  }
  try {
    const out = markdown.parse(content, { async: false })
    return typeof out === "string" ? out : ""
  } finally {
    renderContext = prev
  }
}
