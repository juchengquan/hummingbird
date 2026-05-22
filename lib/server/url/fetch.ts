import "server-only"

import { createHash } from "node:crypto"

import { validateOutboundUrl, type ValidationError } from "@/server/url/validate"

/**
 * Server-side URL fetcher + extractor. Hands the chat-route plumbing
 * a single function that turns a raw URL into the cached-bookmark
 * shape: { title, content, contentTruncated, contentHash, description,
 * faviconUrl }.
 *
 * Caps:
 *   - 10s timeout (AbortController)
 *   - 5 redirects max (each one re-validated)
 *   - 5 MB response body cap (refused if exceeded)
 *   - 200 KB extracted text per bookmark (truncation marker set)
 *
 * Errors come back structured so the route can map them to clean HTTP
 * status codes; nothing here returns a 500 by surprise.
 */

const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 5
const MAX_BODY_BYTES = 5 * 1024 * 1024
const EXTRACTED_TEXT_BUDGET = 200 * 1024

export interface BookmarkSnapshot {
  url: string
  title: string
  content: string
  contentTruncated: boolean
  contentHash: string
  description?: string
  faviconUrl?: string
}

export type FetchError =
  | { code: "validation"; message: string; validation: ValidationError }
  | { code: "timeout"; message: string }
  | { code: "too_many_redirects"; message: string }
  | { code: "body_too_large"; message: string }
  | { code: "http_error"; status: number; message: string }
  | { code: "unsupported_content_type"; message: string }
  | { code: "network"; message: string }

/**
 * Fetch and extract a single URL. Returns a `BookmarkSnapshot` on
 * success or a structured `FetchError` on any failure mode.
 *
 * `options.signal` propagates upstream abort (e.g. the chat-route
 * `req.signal` when the client tab closes mid-stream). It's combined
 * with the internal 10s timer via `AbortSignal.any`, so the fetch
 * aborts on whichever fires first.
 */
export async function fetchUrlBookmark(
  rawUrl: string,
  options: { signal?: AbortSignal } = {}
): Promise<
  | { ok: true; snapshot: BookmarkSnapshot }
  | { ok: false; error: FetchError }
> {
  let currentUrl = rawUrl
  let redirectsRemaining = MAX_REDIRECTS

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  // Combined signal: caller's upstream signal (e.g. tab closed) OR
  // our internal 10s timeout — whichever fires first cancels the
  // outbound fetch. Stops zombie work after a client disconnect.
  const requestSignal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal

  try {
    while (true) {
      const validation = await validateOutboundUrl(currentUrl)
      if (!validation.ok) {
        return {
          ok: false,
          error: {
            code: "validation",
            message: validation.error.message,
            validation: validation.error,
          },
        }
      }

      let res: Response
      try {
        res = await fetch(validation.url.toString(), {
          method: "GET",
          // We handle redirects manually so we can re-validate each hop.
          redirect: "manual",
          signal: requestSignal,
          headers: {
            "User-Agent":
              "Hummingbird-Bookmark/1.0 (+https://github.com/juchengquan/hummingbird)",
            Accept:
              "text/html, application/json, text/plain;q=0.9, text/markdown;q=0.9, */*;q=0.5",
          },
        })
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            ok: false,
            error: {
              code: "timeout",
              message: `Fetch timed out after ${FETCH_TIMEOUT_MS}ms`,
            },
          }
        }
        return {
          ok: false,
          error: {
            code: "network",
            message: err instanceof Error ? err.message : String(err),
          },
        }
      }

      // Handle redirects manually so we re-run validation on each
      // target — protects against a redirect to a private IP.
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location")
        if (!location) {
          return {
            ok: false,
            error: {
              code: "http_error",
              status: res.status,
              message: `Redirect (${res.status}) with no Location header`,
            },
          }
        }
        if (redirectsRemaining-- <= 0) {
          return {
            ok: false,
            error: {
              code: "too_many_redirects",
              message: `Exceeded ${MAX_REDIRECTS} redirects`,
            },
          }
        }
        // Resolve relative redirects against the current URL.
        currentUrl = new URL(location, validation.url).toString()
        continue
      }

      if (!res.ok) {
        return {
          ok: false,
          error: {
            code: "http_error",
            status: res.status,
            message: `Upstream returned ${res.status} ${res.statusText}`,
          },
        }
      }

      const contentType = (res.headers.get("content-type") ?? "").toLowerCase()
      const isHtml = contentType.includes("text/html")
      const isJson = contentType.includes("application/json")
      const isText =
        contentType.startsWith("text/") || contentType.includes("xml")

      if (!isHtml && !isJson && !isText) {
        return {
          ok: false,
          error: {
            code: "unsupported_content_type",
            message: `Cannot extract text from ${contentType || "unknown content type"}`,
          },
        }
      }

      // Stream the body with a cap. `arrayBuffer()` would read the whole
      // thing; we want to fail early on a 100 MB page.
      const reader = res.body?.getReader()
      if (!reader) {
        return {
          ok: false,
          error: { code: "network", message: "Empty response body" },
        }
      }
      const chunks: Uint8Array[] = []
      let totalBytes = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          totalBytes += value.byteLength
          if (totalBytes > MAX_BODY_BYTES) {
            await reader.cancel().catch(() => undefined)
            return {
              ok: false,
              error: {
                code: "body_too_large",
                message: `Response body exceeded ${MAX_BODY_BYTES / (1024 * 1024)} MB`,
              },
            }
          }
          chunks.push(value)
        }
      }
      const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)))
      const text = buffer.toString("utf8")

      const extracted = isHtml
        ? await extractHtml(text, validation.url)
        : extractPlain(text, validation.url)

      const finalText = extracted.content.slice(0, EXTRACTED_TEXT_BUDGET)
      const truncated = extracted.content.length > finalText.length
      const contentHash = createHash("sha256")
        .update(finalText)
        .digest("hex")
        .slice(0, 16) // short prefix is plenty for change detection

      return {
        ok: true,
        snapshot: {
          url: validation.url.toString(),
          title: extracted.title,
          content: finalText,
          contentTruncated: truncated,
          contentHash,
          description: extracted.description,
          faviconUrl: extracted.faviconUrl,
        },
      }
    }
  } finally {
    clearTimeout(timeout)
  }
}

interface ExtractedPage {
  title: string
  content: string
  description?: string
  faviconUrl?: string
}

async function extractHtml(html: string, baseUrl: URL): Promise<ExtractedPage> {
  const { parse } = await import("node-html-parser")
  const root = parse(html, {
    comment: false,
    blockTextElements: { script: false, noscript: false, style: false, pre: true },
  })

  // Title precedence: <title>, then og:title, then hostname.
  let title = root.querySelector("title")?.text.trim() ?? ""
  if (!title) {
    title =
      root
        .querySelector('meta[property="og:title"]')
        ?.getAttribute("content")
        ?.trim() ?? ""
  }
  if (!title) title = baseUrl.hostname

  // Description: <meta name="description"> or og:description.
  const description =
    root
      .querySelector('meta[name="description"]')
      ?.getAttribute("content")
      ?.trim() ||
    root
      .querySelector('meta[property="og:description"]')
      ?.getAttribute("content")
      ?.trim() ||
    undefined

  // Favicon — first <link rel="...icon">, fallback to /favicon.ico.
  let faviconUrl: string | undefined
  const iconLink = root.querySelectorAll('link[rel*="icon"]')[0]
  const iconHref = iconLink?.getAttribute("href")
  if (iconHref) {
    try {
      faviconUrl = new URL(iconHref, baseUrl).toString()
    } catch {
      // ignore bad href
    }
  }
  if (!faviconUrl) {
    faviconUrl = new URL("/favicon.ico", baseUrl).toString()
  }

  // Content: prefer <main>, then <article>, then <body>. Strip noise
  // before extracting text.
  const container =
    root.querySelector("main") ??
    root.querySelector("article") ??
    root.querySelector("body") ??
    root
  for (const sel of ["nav", "footer", "aside", "script", "style", "noscript", "svg"]) {
    for (const el of container.querySelectorAll(sel)) {
      el.remove()
    }
  }
  const content = container.text.replace(/\s+/g, " ").trim()

  return { title, content, description, faviconUrl }
}

function extractPlain(text: string, baseUrl: URL): ExtractedPage {
  return {
    title: baseUrl.hostname + baseUrl.pathname,
    content: text,
  }
}
