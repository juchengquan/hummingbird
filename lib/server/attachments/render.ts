import "server-only"

import type { FileSummary } from "@/shared/attachments"
import { formatBytes } from "@/shared/utils"

/**
 * System-prompt renderer for source attachments. `ResolvedAttachment`
 * is the post-resolution shape: files and URL bookmarks pass through
 * from the wire shape, MCP resources arrive after
 * `resolveAttachedMcpResources` has fetched content via `readResource`.
 *
 * Ordering inside the prompt — files → MCP → URL bookmarks — reflects
 * information density: files are typically the primary content the
 * user wants the model to look at, MCP resources are explicitly
 * attached references, bookmarks are background context. All kinds
 * share one character budget so a single oversized file can't drown
 * out everything else.
 */

export type ResolvedAttachment =
  | { kind: "file"; summary: FileSummary }
  | {
      kind: "mcp_resource"
      serverName: string
      resourceName: string
      text?: string
      error?: string
    }
  | {
      kind: "url_bookmark"
      title: string
      url: string
      content: string
      truncated: boolean
      fetchedAt?: string
    }

const SECTION_ORDER: ResolvedAttachment["kind"][] = [
  "file",
  "mcp_resource",
  "url_bookmark",
]

/**
 * Render the unified attachment block. Returns the joined fragment
 * or `null` when there's nothing to render. Budget is consumed
 * top-down; later sections see whatever's left.
 *
 * Per-attachment truncation marker matches the file path the chat
 * route used to write inline. Overflow attachments (no budget left)
 * render as an omitted-list footer per section.
 */
export function renderAttachmentsPrompt(
  attachments: ResolvedAttachment[],
  totalBudget: number
): string | null {
  if (attachments.length === 0) return null

  const grouped = groupByKind(attachments)
  if (grouped.size === 0) return null

  const sections: string[] = []
  let used = 0

  for (const kind of SECTION_ORDER) {
    const items = grouped.get(kind) ?? []
    if (items.length === 0) continue
    const remaining = Math.max(0, totalBudget - used)
    const rendered = renderSection(kind, items, remaining)
    if (rendered.fragment) {
      sections.push(rendered.fragment)
      used += rendered.used
    }
  }

  return sections.length === 0 ? null : sections.join("\n\n")
}

function groupByKind(
  attachments: ResolvedAttachment[]
): Map<ResolvedAttachment["kind"], ResolvedAttachment[]> {
  const out = new Map<ResolvedAttachment["kind"], ResolvedAttachment[]>()
  for (const a of attachments) {
    const list = out.get(a.kind) ?? []
    list.push(a)
    out.set(a.kind, list)
  }
  return out
}

function renderSection(
  kind: ResolvedAttachment["kind"],
  items: ResolvedAttachment[],
  budget: number
): { fragment: string | null; used: number } {
  if (items.length === 0) return { fragment: null, used: 0 }

  // Skip the section entirely when nothing inside can render — e.g. a file
  // section where every file is meta-only (no extracted text). Without
  // this, the intro lies ("their extracted text follows") even though the
  // loop below would emit zero body blocks.
  const anyRenderable = items.some(
    (item) => itemErrorMarker(item) !== null || itemBody(item) !== null
  )
  if (!anyRenderable) return { fragment: null, used: 0 }

  const intro = sectionIntro(kind, items)
  if (budget <= intro.length) {
    return { fragment: null, used: 0 }
  }

  const parts: string[] = [intro]
  let used = intro.length
  const omitted: string[] = []

  for (const item of items) {
    const header = itemHeader(item)
    const body = itemBody(item)
    const inlineMarker = itemErrorMarker(item)

    if (inlineMarker) {
      // Error placeholder — short, always render in full so the
      // model knows the user tried to attach something.
      const block = `\n\n${header}\n${inlineMarker}`
      if (used + block.length > budget) {
        omitted.push(itemLabel(item))
        continue
      }
      parts.push(block)
      used += block.length
      continue
    }

    if (body === null) continue

    const remaining = budget - used - header.length - 4 // 4 = "\n\n" + "\n"
    if (remaining <= 0) {
      omitted.push(itemLabel(item))
      continue
    }
    const trimmed = body.slice(0, remaining)
    const overflow = body.length > trimmed.length
    parts.push(
      `\n\n${header}\n` + trimmed + (overflow ? "\n[truncated to fit overall budget]" : "")
    )
    used += header.length + trimmed.length + 4
  }

  if (omitted.length > 0) {
    parts.push(
      `\n\n[Additional ${pluralLabel(kind)} omitted to fit budget: ${omitted.join(", ")}]`
    )
  }

  return { fragment: parts.join(""), used }
}

function sectionIntro(
  kind: ResolvedAttachment["kind"],
  items: ResolvedAttachment[]
): string {
  switch (kind) {
    case "file": {
      const fileItems = items.filter(
        (i): i is Extract<ResolvedAttachment, { kind: "file" }> => i.kind === "file"
      )
      const pdfNames = fileItems
        .filter((f) => f.summary.kind === "pdf")
        .map((f) => f.summary.name)
      let intro =
        "The user has attached these files. Their extracted text follows. " +
        "Treat them as authoritative context for any question that references them."
      if (pdfNames.length > 0) {
        intro +=
          ' When you reference content from a PDF, cite the page number inline using the marker `[p.N]` ' +
          '(e.g. "the discount applies after 30 days [p.4]"). The user can click these markers to open ' +
          `the PDF at that page. PDFs attached: ${pdfNames.map((n) => `"${n}"`).join(", ")}.`
      }
      return intro
    }
    case "mcp_resource":
      return (
        "The user has attached these MCP resources. Their content follows. " +
        "Treat them as authoritative context."
      )
    case "url_bookmark":
      return (
        "The user has saved these web pages as bookmarks. Their cached text " +
        "follows; if a fact appears outdated, the user may need to refresh the bookmark."
      )
  }
}

function itemHeader(item: ResolvedAttachment): string {
  switch (item.kind) {
    case "file": {
      const kindNote = item.summary.kind ? ` (${item.summary.kind})` : ""
      const truncNote = item.summary.truncated ? " (per-file truncated at extraction)" : ""
      return `--- ${item.summary.name}${kindNote}${truncNote} ---`
    }
    case "mcp_resource":
      return `--- ${item.serverName}: ${item.resourceName} ---`
    case "url_bookmark": {
      const fetched = item.fetchedAt ? ` · fetched ${item.fetchedAt}` : ""
      return `--- ${item.title} (${item.url})${fetched} ---`
    }
  }
}

function itemBody(item: ResolvedAttachment): string | null {
  switch (item.kind) {
    case "file":
      return item.summary.text && item.summary.text.trim().length > 0
        ? item.summary.text
        : null
    case "mcp_resource":
      return item.text && item.text.length > 0 ? item.text : null
    case "url_bookmark":
      return item.content
  }
}

function itemErrorMarker(item: ResolvedAttachment): string | null {
  if (item.kind === "mcp_resource" && item.error) {
    return `[MCP resource "${item.resourceName}" unavailable — ${item.error}]`
  }
  return null
}

function itemLabel(item: ResolvedAttachment): string {
  switch (item.kind) {
    case "file":
      return item.summary.name
    case "mcp_resource":
      return item.resourceName
    case "url_bookmark":
      return item.title
  }
}

function pluralLabel(kind: ResolvedAttachment["kind"]): string {
  switch (kind) {
    case "file":
      return "files"
    case "mcp_resource":
      return "MCP resources"
    case "url_bookmark":
      return "bookmarks"
  }
}

/**
 * Render a "meta-only" footer for files whose extraction didn't
 * yield text (PDFs that failed parsing, images without OCR, etc.).
 * The chat route had this as a separate block in the old
 * `buildSystemPrompt`; preserve it as a tiny helper called
 * alongside the main renderer.
 */
export function renderMetaOnlyFilesPrompt(
  files: FileSummary[]
): string | null {
  const metaOnly = files.filter((f) => !f.text || f.text.trim().length === 0)
  if (metaOnly.length === 0) return null
  const list = metaOnly
    .map((f) => `- ${f.name} (${f.type || "unknown"}, ${formatBytes(f.size)})`)
    .join("\n")
  return (
    "The user has also attached these files which we could not extract text from " +
    "(filename + metadata only). Ask the user to paste any relevant portion if a " +
    `question requires their content:\n\n${list}`
  )
}

