/**
 * The list of skills the app knows about. Adding a new skill is two
 * lines here plus the skill's own implementation file (e.g.
 * `lib/skills/web-search.ts`); the Skills panel, the chips row above
 * the chat input, and the chat route all read from this registry.
 *
 * Keep the list short and human-meaningful — surface real distinctions,
 * not implementation details.
 */

import { FileSearch, Globe, ImagePlus, Link2 } from "lucide-react"

import type { SkillDescriptor } from "./types"

export const SKILLS: SkillDescriptor[] = [
  {
    id: "webFetch",
    name: "Web fetch",
    description:
      "Let the model fetch a specific URL and read its contents. Pairs naturally with Web search — search finds the page, fetch reads it in full. Per-turn cap keeps it from going wild.",
    icon: Link2,
    default: false,
    // Uses node's built-in fetch — no API key required.
    requiresEnv: false,
    slashTriggers: ["fetch", "f"],
  },
  {
    id: "webSearch",
    name: "Web search",
    description:
      "Look up current information on the web. Picks from Tavily and Brave under the hood — toggle providers and tune their settings in this skill's panel.",
    icon: Globe,
    default: false,
    requiresEnv: true,
    slashTriggers: ["search", "s"],
  },
  {
    id: "imageGen",
    name: "Image generation",
    description:
      "Let the model generate images via Minimax (text-to-image, or image-to-image when you provide a reference URL). Tight per-turn cap because each generation costs ~1–3¢.",
    icon: ImagePlus,
    default: false,
    // Requires MINIMAX_CN_API_KEY (same key as the Minimax-CN chat
    // bypass — the image endpoint accepts the same auth).
    requiresEnv: true,
    slashTriggers: ["image", "img"],
  },
  {
    id: "searchFiles",
    name: "File search",
    description:
      "Let the model pull additional sections from your attached files when their inline view was truncated. Uses Postgres full-text search over each file's full extracted text. Sign-in required — file full text is stored in Supabase.",
    icon: FileSearch,
    default: false,
    // Requires Supabase sign-in: full text is stored in `files.full_text`
    // and the searchFiles tool RPC reads it via the user's RLS context.
    requiresEnv: true,
    slashTriggers: ["files", "file"],
  },
]

export function getSkill(id: string): SkillDescriptor | undefined {
  return SKILLS.find((s) => s.id === id)
}
