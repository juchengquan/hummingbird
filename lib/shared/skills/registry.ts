/**
 * The list of skills the app knows about. Adding a new skill is two
 * lines here plus the skill's own implementation file (e.g.
 * `lib/skills/web-search.ts`); the Skills panel, the chips row above
 * the chat input, and the chat route all read from this registry.
 *
 * Keep the list short and human-meaningful — surface real distinctions,
 * not implementation details.
 */

import { Globe } from "lucide-react"

import type { SkillDescriptor } from "./types"

export const SKILLS: SkillDescriptor[] = [
  {
    id: "webSearch",
    name: "Web search",
    description:
      "Look up current information on the web when the model needs facts it might not have.",
    icon: Globe,
    default: false,
    requiresEnv: true,
  },
]

export function getSkill(id: string): SkillDescriptor | undefined {
  return SKILLS.find((s) => s.id === id)
}
