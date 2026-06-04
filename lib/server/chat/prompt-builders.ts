import "server-only"

/**
 * System-prompt builders for `/api/chat`. Composes:
 *
 *   workspace prompt
 *   ├── base "you are a chat assistant" line
 *   ├── enabled-skills note (per-skill `promptFragment(entry)`)
 *   ├── MCP-server note ("you have N tools from server X")
 *   ├── i2i remix-reference note (when the user pinned a reference image)
 *   └── attachment blocks (files + bookmarks + MCP resource content)
 *
 * Each piece is independently testable; the route just stitches them.
 */

import type { ModelMessage } from "ai"

import {
  SERVER_SKILLS,
  type SkillRequestEntry,
} from "@/server/skills/registry"
import type { SkillId } from "@/shared/skills/types"
import {
  renderAttachmentsPrompt,
  renderMetaOnlyFilesPrompt,
  type ResolvedAttachment,
} from "@/server/attachments/render"

/** Soft cap on combined inline text across all attachments, to keep
 *  prompts inside reasonable token budgets. Per-file truncation already
 *  happens at extraction time (100 KB / file, 128 KB for code); this
 *  is a second pass across the whole attachment set. Sized to fit ~3
 *  medium docs in full before round-robin trimming kicks in. */
export const TOTAL_ATTACHMENT_BUDGET = 300 * 1024

export interface BuildSystemPromptOptions {
  workspaceSystemPrompt?: string
  /** Skill ids the user has effectively enabled for this turn. */
  enabledSkillIds: SkillId[]
  /** The per-skill `body.skills[*]` entries (request-time config the
   *  client included). Each registered ServerSkill picks its own
   *  typed sub-object out via `skill.promptFragment(entry)`. */
  skillRequestEntries: SkillRequestEntry[]
  /** MCP server summaries — only used to mention available tooling.
   *  Tool definitions themselves are surfaced via the AI SDK's
   *  `tools` parameter, so we don't have to enumerate them in prose. */
  mcpServers?: { name: string; toolCount: number }[]
  /** Resolved attachments — files + bookmarks pass through verbatim,
   *  MCP resources arrive post-`readResource`. Single ordered list;
   *  `renderAttachmentsPrompt` groups by kind for readable section
   *  headers and shares the character budget across all of them. */
  attachments: ResolvedAttachment[]
  /** I2I reference image the user pinned via the gallery's "Remix"
   *  action. When set we add a system note nudging the model to call
   *  `generateImage` with `referenceImageUrl`. The tool's SSRF gate
   *  still validates the URL before forwarding to Minimax. */
  referenceImage?: { url: string }
}

export function buildSystemPrompt(opts: BuildSystemPromptOptions): string {
  const trimmedWorkspace = opts.workspaceSystemPrompt?.trim()
  const skillsLine = buildSkillsNote(
    opts.enabledSkillIds,
    opts.skillRequestEntries,
  )
  const mcpLine = buildMcpNote(opts.mcpServers ?? [])
  const remixLine = buildRemixNote(opts.referenceImage, opts.enabledSkillIds)
  // Workspace prompt goes first so user-set persona/style instructions take
  // precedence over our generic guidance. The base instructions then nudge the
  // model toward Markdown formatting (which the chat bubble now renders).
  const base = [
    trimmedWorkspace,
    "You are a helpful chat assistant inside the Hummingbird app. " +
      "Answer concisely and use Markdown formatting when useful.",
    skillsLine,
    mcpLine,
    remixLine,
  ]
    .filter(Boolean)
    .join("\n\n")

  if (opts.attachments.length === 0) return base

  const attachmentBlock = renderAttachmentsPrompt(
    opts.attachments,
    TOTAL_ATTACHMENT_BUDGET,
  )

  // Meta-only files (filename + metadata, no extracted text) get a
  // separate "we couldn't extract this" footer. Files with text are
  // already in the main attachments block.
  const metaOnlyFiles = opts.attachments
    .filter(
      (a): a is Extract<ResolvedAttachment, { kind: "file" }> => a.kind === "file",
    )
    .map((a) => a.summary)
  const metaBlock = renderMetaOnlyFilesPrompt(metaOnlyFiles)

  return [base, attachmentBlock, metaBlock].filter(Boolean).join("\n\n")
}

export function buildSkillsNote(
  enabledSkillIds: SkillId[],
  skillRequestEntries: SkillRequestEntry[],
): string | null {
  if (enabledSkillIds.length === 0) return null
  const enabled = new Set<SkillId>(enabledSkillIds)
  const entryById = new Map<string, SkillRequestEntry>(
    skillRequestEntries.map((s) => [s.id, s]),
  )
  // Iterate the server registry so the next skill (webShell, etc.)
  // only needs to add a `ServerSkill` to `SERVER_SKILLS` — no new
  // branch here.
  const notes: string[] = []
  for (const skill of SERVER_SKILLS) {
    if (!enabled.has(skill.id)) continue
    const fragment = skill.promptFragment(entryById.get(skill.id))
    if (fragment) notes.push(fragment)
  }
  if (notes.length === 0) return null
  return `Available capabilities:\n${notes.map((n) => `- ${n}`).join("\n")}`
}

export function buildRemixNote(
  ref: { url: string } | undefined,
  enabledSkillIds: SkillId[],
): string | null {
  if (!ref) return null
  if (!enabledSkillIds.includes("imageGen" as SkillId)) return null
  return (
    `The user attached a reference image for image-to-image generation. ` +
    `When they ask for an image variation, edit, or remix, call ` +
    `\`generateImage\` with \`referenceImageUrl: "${ref.url}"\` (i2i mode). ` +
    `If they ask for an unrelated new image instead, ignore the reference.`
  )
}

export function buildMcpNote(
  servers: { name: string; toolCount: number }[],
): string | null {
  const active = servers.filter((s) => s.toolCount > 0)
  if (active.length === 0) return null
  const list = active
    .map(
      (s) => `- "${s.name}" (${s.toolCount} ${s.toolCount === 1 ? "tool" : "tools"})`,
    )
    .join("\n")
  return (
    `You have access to tools from MCP (Model Context Protocol) servers ` +
    `the user has connected. Tool names are prefixed with ` +
    `\`mcp__<serverId>__<toolName>\`; their descriptions and input schemas ` +
    `are attached. Call them when relevant to the user's request. ` +
    `MCP servers connected:\n${list}`
  )
}

/** Pull the last `user`-role message's text. Multimodal content
 *  arrays are searched for the first `type: 'text'` part. Returns
 *  empty string when no user message has text content. */
export function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "user") continue
    if (typeof m.content === "string") return m.content
    if (Array.isArray(m.content)) {
      const textPart = m.content.find(
        (p): p is { type: "text"; text: string } =>
          typeof p === "object" &&
          p !== null &&
          (p as { type?: string }).type === "text",
      )
      if (textPart) return textPart.text
    }
    return ""
  }
  return ""
}
