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

type AttachmentKind = ResolvedAttachment["kind"]

/**
 * Per-kind rendering config. Every kind-specific decision lives in one
 * record entry — adding a fourth kind only requires extending this
 * shape, not chasing six switch statements. Inputs are typed as the
 * union; each callback narrows internally via the `kind` discriminant
 * because the caller filters into per-kind buckets before invoking.
 */
interface KindRenderer {
  /** Section intro paragraph. Receives all items of this kind so it
   *  can vary based on collection-level info (e.g. naming PDFs for
   *  the citation-style instruction). */
  intro(items: ResolvedAttachment[]): string
  /** `--- … ---` header line for a single item. */
  header(item: ResolvedAttachment): string
  /** Body text to render under the header, or null when there's no
   *  body (e.g. file with no extracted text — `renderSection` then
   *  drops the item silently). */
  body(item: ResolvedAttachment): string | null
  /** Optional one-line marker shown instead of the body when the item
   *  failed to resolve (today only MCP uses this). Returning null —
   *  or omitting the function — means "no error marker, render the
   *  body normally". */
  errorMarker?(item: ResolvedAttachment): string | null
  /** Short identifier shown in the "[Additional X omitted …]" footer
   *  when budget runs out. */
  label(item: ResolvedAttachment): string
  /** Pluralized kind name used in the omitted-list footer. */
  plural: string
}

const RENDERERS: Record<AttachmentKind, KindRenderer> = {
  file: {
    intro(items) {
      const pdfNames = items
        .filter(
          (i): i is Extract<ResolvedAttachment, { kind: "file" }> =>
            i.kind === "file" && i.summary.kind === "pdf"
        )
        .map((i) => i.summary.name)
      let s =
        "The user has attached these files. Their extracted text follows. " +
        "Treat them as authoritative context for any question that references them."
      if (pdfNames.length > 0) {
        s +=
          ' When you reference content from a PDF, cite the page number inline using the marker `[p.N]` ' +
          '(e.g. "the discount applies after 30 days [p.4]"). The user can click these markers to open ' +
          `the PDF at that page. PDFs attached: ${pdfNames.map((n) => `"${n}"`).join(", ")}.`
      }
      return s
    },
    header(item) {
      if (item.kind !== "file") return ""
      const kindNote = item.summary.kind ? ` (${item.summary.kind})` : ""
      const truncNote = item.summary.truncated ? " (per-file truncated at extraction)" : ""
      return `--- ${item.summary.name}${kindNote}${truncNote} ---`
    },
    body(item) {
      if (item.kind !== "file") return null
      return item.summary.text && item.summary.text.trim().length > 0
        ? item.summary.text
        : null
    },
    label(item) {
      return item.kind === "file" ? item.summary.name : ""
    },
    plural: "files",
  },

  mcp_resource: {
    intro() {
      return (
        "The user has attached these MCP resources. Their content follows. " +
        "Treat them as authoritative context."
      )
    },
    header(item) {
      return item.kind === "mcp_resource"
        ? `--- ${item.serverName}: ${item.resourceName} ---`
        : ""
    },
    body(item) {
      if (item.kind !== "mcp_resource") return null
      return item.text && item.text.length > 0 ? item.text : null
    },
    errorMarker(item) {
      if (item.kind !== "mcp_resource" || !item.error) return null
      return `[MCP resource "${item.resourceName}" unavailable — ${item.error}]`
    },
    label(item) {
      return item.kind === "mcp_resource" ? item.resourceName : ""
    },
    plural: "MCP resources",
  },

  url_bookmark: {
    intro() {
      return (
        "The user has saved these web pages as bookmarks. Their cached text " +
        "follows; if a fact appears outdated, the user may need to refresh the bookmark."
      )
    },
    header(item) {
      if (item.kind !== "url_bookmark") return ""
      const fetched = item.fetchedAt ? ` · fetched ${item.fetchedAt}` : ""
      return `--- ${item.title} (${item.url})${fetched} ---`
    },
    body(item) {
      return item.kind === "url_bookmark" ? item.content : null
    },
    label(item) {
      return item.kind === "url_bookmark" ? item.title : ""
    },
    plural: "bookmarks",
  },
}

const SECTION_ORDER: AttachmentKind[] = ["file", "mcp_resource", "url_bookmark"]

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
): Map<AttachmentKind, ResolvedAttachment[]> {
  const out = new Map<AttachmentKind, ResolvedAttachment[]>()
  for (const a of attachments) {
    const list = out.get(a.kind) ?? []
    list.push(a)
    out.set(a.kind, list)
  }
  return out
}

function renderSection(
  kind: AttachmentKind,
  items: ResolvedAttachment[],
  budget: number
): { fragment: string | null; used: number } {
  if (items.length === 0) return { fragment: null, used: 0 }
  const renderer = RENDERERS[kind]

  // Skip the section entirely when nothing inside can render — e.g. a file
  // section where every file is meta-only (no extracted text). Without
  // this, the intro lies ("their extracted text follows") even though the
  // loop below would emit zero body blocks.
  const anyRenderable = items.some(
    (item) => renderer.errorMarker?.(item) != null || renderer.body(item) !== null
  )
  if (!anyRenderable) return { fragment: null, used: 0 }

  const intro = renderer.intro(items)
  if (budget <= intro.length) {
    return { fragment: null, used: 0 }
  }

  const parts: string[] = [intro]
  let used = intro.length
  const omitted: string[] = []

  for (const item of items) {
    const header = renderer.header(item)
    const body = renderer.body(item)
    const inlineMarker = renderer.errorMarker?.(item) ?? null

    if (inlineMarker) {
      // Error placeholder — short, always render in full so the
      // model knows the user tried to attach something.
      const block = `\n\n${header}\n${inlineMarker}`
      if (used + block.length > budget) {
        omitted.push(renderer.label(item))
        continue
      }
      parts.push(block)
      used += block.length
      continue
    }

    if (body === null) continue

    const remaining = budget - used - header.length - 4 // 4 = "\n\n" + "\n"
    if (remaining <= 0) {
      omitted.push(renderer.label(item))
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
      `\n\n[Additional ${renderer.plural} omitted to fit budget: ${omitted.join(", ")}]`
    )
  }

  return { fragment: parts.join(""), used }
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
