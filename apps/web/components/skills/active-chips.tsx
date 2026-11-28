"use client"

import { X, Plus } from "lucide-react"

import { useStore, useActiveConversation, useActiveWorkspace } from "@/client/hooks/use-store"
import { SKILLS } from "@/shared/skills/registry"
import { resolveSkill, type SkillId } from "@/shared/skills/types"
import { cn } from "@/shared/utils"

interface ActiveSkillsChipsProps {
  className?: string
  /**
   * Per-message override — skills the user toggled off for the next send
   * only. Used to render the chip as a muted "tap to re-enable" state.
   * Cleared by the parent on message send.
   */
  mutedForNext?: Set<SkillId>
  onToggleMuted?: (skillId: SkillId) => void
}

/**
 * One chip per effectively-enabled skill, rendered above the chat input.
 *
 * Two interactions:
 *   - Click the chip body → opens the Skills tab in the right sidebar
 *     (full toggle UI, conversation/workspace scope).
 *   - Click the × → mutes this skill for the *next* message only. The
 *     chip stays in the row, greyed, with a + to re-enable. Send clears
 *     the mute. Lives in component state — never persists.
 */
export function ActiveSkillsChips({
  className,
  mutedForNext,
  onToggleMuted,
}: ActiveSkillsChipsProps) {
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
        const muted = mutedForNext?.has(skill.id) ?? false
        return (
          <span
            key={skill.id}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border pl-2 pr-1 py-0.5 text-[10px] transition-colors",
              muted
                ? "border-[var(--border)] bg-[var(--muted)]/40 text-[var(--muted-foreground)] line-through"
                : "border-[var(--primary)]/40 bg-[var(--primary)]/10 text-[var(--primary)]"
            )}
          >
            <button
              type="button"
              onClick={openSkillsTab}
              title={
                muted
                  ? `${skill.name} is paused for the next message only. Manage in the Skills tab.`
                  : `${skill.name} is on. Click to manage.`
              }
              className={cn(
                "inline-flex items-center gap-1 no-underline",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] rounded-full"
              )}
            >
              <Icon size={10} />
              {skill.name}
            </button>
            {onToggleMuted && (
              <button
                type="button"
                onClick={() => onToggleMuted(skill.id)}
                aria-label={muted ? `Re-enable ${skill.name} for next message` : `Pause ${skill.name} for next message`}
                title={
                  muted
                    ? "Re-enable for the next message"
                    : "Pause for the next message only"
                }
                className={cn(
                  "inline-flex items-center justify-center w-3.5 h-3.5 rounded-full transition-colors",
                  "hover:bg-current/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
                )}
              >
                {muted ? <Plus size={9} /> : <X size={9} />}
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}
