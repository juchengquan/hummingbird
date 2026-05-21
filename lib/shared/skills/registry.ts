/**
 * The list of skills the app knows about. Adding a new skill is two
 * lines here plus the skill's own implementation file (e.g.
 * `lib/skills/web-search.ts`); the Skills panel, the chips row above
 * the chat input, and the chat route all read from this registry.
 *
 * Keep the list short and human-meaningful — surface real distinctions,
 * not implementation details.
 */

import { Globe, Link2 } from "lucide-react"

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
  },
  {
    id: "webSearch",
    name: "Web search",
    description:
      "Look up current information on the web. Picks from Tavily and Brave under the hood — toggle providers and tune their settings in this skill's panel.",
    icon: Globe,
    default: false,
    requiresEnv: true,
  },
]

export function getSkill(id: string): SkillDescriptor | undefined {
  return SKILLS.find((s) => s.id === id)
}
