import "client-only"

import { findSegmentMatches, type FindSegment } from "@/shared/find/match"

/** In-conversation find (⌘F): turns the visible message text under a root
 *  into DOM Ranges and paints them with the CSS Custom Highlight API. The
 *  API styles ranges without touching the DOM, so rendered markdown and
 *  citation buttons stay exactly as they are. The `::highlight(...)` rules
 *  live in `app/globals.css`. */

const ALL = "hb-find-all"
const CURRENT = "hb-find-current"

/** Attribute on the element that holds one message's content. Only text
 *  inside such a region is searched, so action buttons, suggestion chips and
 *  hover-only timestamps never count as matches. */
export const FIND_REGION_ATTR = "data-find-region"

const SKIP_SELECTOR = "button, [aria-hidden='true'], [data-find-skip]"
const BLOCK_SELECTOR =
  "p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, td, th, dt, dd, figcaption, summary, div"

export function supportsHighlightApi(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
}

function isVisible(el: Element): boolean {
  // checkVisibility catches display:none, closed <details>, content-visibility.
  // Browsers without it (old ones) treat everything in the DOM as visible.
  return typeof el.checkVisibility === "function" ? el.checkVisibility() : true
}

interface Collected {
  nodes: Text[]
  segments: FindSegment[]
}

function collectSegments(root: HTMLElement): Collected {
  const nodes: Text[] = []
  const segments: FindSegment[] = []
  // A text node's nearest block and region: a change in either is a break.
  let prevBlock: Element | null = null
  let prevRegion: Element | null = null
  const visibleCache = new Map<Element, boolean>()

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || !(node as Text).data) return NodeFilter.FILTER_REJECT
      if (!parent.closest(`[${FIND_REGION_ATTR}]`)) return NodeFilter.FILTER_REJECT
      if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT
      let visible = visibleCache.get(parent)
      if (visible === undefined) {
        visible = isVisible(parent)
        visibleCache.set(parent, visible)
      }
      return visible ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })

  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text
    const parent = text.parentElement as Element
    const region = parent.closest(`[${FIND_REGION_ATTR}]`)
    const block = parent.closest(BLOCK_SELECTOR)
    segments.push({ text: text.data, breakBefore: region !== prevRegion || block !== prevBlock })
    nodes.push(text)
    prevRegion = region
    prevBlock = block
  }
  return { nodes, segments }
}

/** Build a Range per case-insensitive occurrence of `query` in the visible
 *  message text under `root`, paint them all with the "find-all" highlight,
 *  and return them in document order. Clears any earlier highlights first.
 *  Returns [] when the API is missing, the query is blank, or nothing matches. */
export function computeFindRanges(root: HTMLElement, query: string): Range[] {
  clearFindHighlights()
  if (!supportsHighlightApi() || query.trim() === "") return []

  const { nodes, segments } = collectSegments(root)
  const ranges: Range[] = []
  for (const m of findSegmentMatches(segments, query)) {
    const r = document.createRange()
    r.setStart(nodes[m.start.segment], m.start.offset)
    r.setEnd(nodes[m.end.segment], m.end.offset)
    ranges.push(r)
  }
  if (ranges.length > 0) CSS.highlights.set(ALL, new Highlight(...ranges))
  return ranges
}

export function setCurrentFindRange(range: Range | null): void {
  if (!supportsHighlightApi()) return
  if (range) CSS.highlights.set(CURRENT, new Highlight(range))
  else CSS.highlights.delete(CURRENT)
}

export function clearFindHighlights(): void {
  if (!supportsHighlightApi()) return
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

/** The current text selection, if it lies inside `root`, flattened to one
 *  line (the find input is single-line) and capped. Read it before the find
 *  input takes focus, which collapses the selection. */
export function selectionTextWithin(root: HTMLElement | null): string | undefined {
  if (!root || typeof window === "undefined") return undefined
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return undefined
  if (!root.contains(sel.getRangeAt(0).commonAncestorContainer)) return undefined
  const text = sel.toString().replace(/\s+/g, " ").trim().slice(0, 200)
  return text || undefined
}

/** Scroll `viewport` so `rect` sits about a third of the way down, unless
 *  it is already comfortably in view. Scrolls the viewport directly:
 *  `scrollIntoView` can scroll unintended ancestors (see use-chat-scroll). */
export function scrollRectIntoViewport(viewport: HTMLElement, rect: DOMRect): void {
  const vr = viewport.getBoundingClientRect()
  // The find bar floats over the top of the viewport; the input pill and its
  // gradient cover the bottom.
  const topCover = 64
  const bottomCover = Math.min(200, vr.height / 3)
  if (rect.top >= vr.top + topCover && rect.bottom <= vr.bottom - bottomCover) return
  const top = viewport.scrollTop + (rect.top - vr.top) - vr.height / 3
  viewport.scrollTo({ top: Math.max(0, top), behavior: "smooth" })
}
