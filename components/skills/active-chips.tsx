"use client"

import { useStore, useActiveConversation, useActiveWorkspace } from "@/lib/hooks/use-store"
import { SKILLS } from "@/lib/skills/registry"
import { resolveSkill } from "@/lib/skills/types"
import { cn } from "@/lib/utils"

/**
 * Renders one small chip per effectively-enabled skill above the chat input.
 * Returns null when no skills are active so the chat input stays as before.
 *
 * Clicking a chip opens the Skills tab in the right sidebar so the user
 * can flip the toggle in two clicks.
 */
export function ActiveSkillsChips({ className }: { className?: string }) {
  const workspace = useActiveWorkspace()
  const conversation = useActiveConversation()
  const setResourcesSidebarOpen = useStore((s) => s.setResourcesSidebarOpen)
  const setResourcesSidebarTab = useStore((s) => s.setResourcesSidebarTab)

  const active = SKILLS.filter((s) =>
    resolveSkill(s, workspace?.skillPrefs, conversation?.skillPrefs)
  )
  if (active.length === 0) return null

  const openSkillsTab = () => {
    setResourcesSidebarTab("skills")
    setResourcesSidebarOpen(true)
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {active.map((skill) => {
        const Icon = skill.icon
        return (
          <button
            key={skill.id}
            type="button"
            onClick={openSkillsTab}
            title={`${skill.name} is on. Click to manage.`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors",
              "border-[var(--primary)]/40 bg-[var(--primary)]/10 text-[var(--primary)]",
              "hover:bg-[var(--primary)]/15 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
            )}
          >
            <Icon size={10} />
            {skill.name}
          </button>
        )
      })}
    </div>
  )
}
