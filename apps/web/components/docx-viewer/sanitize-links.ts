import { isExternalHttpUrl, isSafeLinkUrl } from "@/shared/safe-url"

/** The slice of the DOM `Element` API this helper touches. */
interface AnchorLike {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

interface AnchorRoot {
  querySelectorAll(selector: string): ArrayLike<AnchorLike> & Iterable<AnchorLike>
}

/**
 * Neutralize hyperlinks in HTML rendered from an untrusted document.
 *
 * `docx-preview` copies a hyperlink's external relationship target
 * straight into `a.href`, so a `.docx` with a `javascript:` hyperlink
 * would otherwise be a live script URL on the app origin. Every
 * `a[href]` that fails the `@/shared/safe-url` link allowlist loses its
 * href (the text stays, it's just no longer a link). Surviving absolute
 * http(s) links get `rel="noopener noreferrer"`.
 *
 * Returns how many links were neutralized.
 */
export function sanitizeRenderedLinks(root: AnchorRoot): number {
  let removed = 0
  for (const a of Array.from(root.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? ""
    if (!isSafeLinkUrl(href)) {
      a.removeAttribute("href")
      a.removeAttribute("target")
      removed++
    } else if (isExternalHttpUrl(href)) {
      a.setAttribute("rel", "noopener noreferrer")
    }
  }
  return removed
}
