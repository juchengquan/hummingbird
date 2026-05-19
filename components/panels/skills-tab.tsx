"use client"

import { Info } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  useActiveConversation,
  useActiveWorkspace,
  useStore,
} from "@/lib/hooks/use-store"
import { SKILLS } from "@/lib/skills/registry"
import { resolveSkill, type SkillDescriptor } from "@/lib/skills/types"

/**
 * "Skills" tab in the right activity bar.
 *
 * Each row exposes a three-state segmented control:
 *   - Off                              → conversation override = false
 *   - On for this chat                 → conversation override = true
 *   - On by default in this workspace  → conversation override cleared,
 *                                        workspace default set to true
 *
 * The fourth implicit state ("inherit, workspace default off") shows
 * with no segment active and an explanatory line.
 */
export function SkillsTab() {
  const workspace = useActiveWorkspace()
  const conversation = useActiveConversation()
  const setWorkspaceSkillPref = useStore((s) => s.setWorkspaceSkillPref)
  const setConversationSkillPref = useStore((s) => s.setConversationSkillPref)

  if (!conversation || !workspace) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-sm text-[var(--muted-foreground)]">
        Open a conversation to manage skills.
      </div>
    )
  }

  const activeSkillsCount = SKILLS.filter((skill) =>
    resolveSkill(skill, workspace.skillPrefs, conversation.skillPrefs)
  ).length

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 h-11 px-3 border-b border-[var(--border)] flex items-center">
        <p className="text-[11px] text-[var(--muted-foreground)]">
          {activeSkillsCount === 0
            ? `No skills active · ${SKILLS.length} available`
            : `${activeSkillsCount} active · ${SKILLS.length} available`}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {SKILLS.map((skill) => (
          <SkillRow
            key={skill.id}
            skill={skill}
            workspacePref={workspace.skillPrefs?.[skill.id]}
            conversationPref={conversation.skillPrefs?.[skill.id]}
            effective={resolveSkill(skill, workspace.skillPrefs, conversation.skillPrefs)}
            onSetOff={() => setConversationSkillPref(conversation.id, skill.id, false)}
            onSetOnForChat={() => setConversationSkillPref(conversation.id, skill.id, true)}
            onSetWorkspaceDefault={() => {
              // Clearing the conversation override lets the workspace default
              // take over. Setting the workspace default to true makes this
              // the new floor.
              setConversationSkillPref(conversation.id, skill.id, null)
              setWorkspaceSkillPref(workspace.id, skill.id, true)
            }}
          />
        ))}
      </div>
    </div>
  )
}

interface SkillRowProps {
  skill: SkillDescriptor
  workspacePref: boolean | undefined
  conversationPref: boolean | undefined
  effective: boolean
  onSetOff: () => void
  onSetOnForChat: () => void
  onSetWorkspaceDefault: () => void
}

function SkillRow({
  skill,
  workspacePref,
  conversationPref,
  effective,
  onSetOff,
  onSetOnForChat,
  onSetWorkspaceDefault,
}: SkillRowProps) {
  const Icon = skill.icon
  const segment: "off" | "chat" | "workspace" =
    conversationPref === false
      ? "off"
      : conversationPref === true
        ? "chat"
        : workspacePref === true
          ? "workspace"
          : "off"
  const inheritsFromWorkspace = conversationPref === undefined && workspacePref !== undefined

  return (
    <div className="rounded-md border border-[var(--border)] p-3 space-y-2">
      <div className="flex items-start gap-2">
        <Icon size={16} className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{skill.name}</p>
          <p className="text-[11px] text-[var(--muted-foreground)] leading-snug">
            {skill.description}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-0 rounded-md border border-[var(--border)] overflow-hidden">
        <Segment active={segment === "off"} onClick={onSetOff}>
          Off
        </Segment>
        <Segment active={segment === "chat"} onClick={onSetOnForChat}>
          On for chat
        </Segment>
        <Segment active={segment === "workspace"} onClick={onSetWorkspaceDefault}>
          Workspace
        </Segment>
      </div>

      {inheritsFromWorkspace && (
        <p className="text-[10px] text-[var(--muted-foreground)] inline-flex items-center gap-1">
          <Info size={10} />
          {workspacePref ? "Inherits ON from workspace default." : "Inherits OFF from workspace default."}
        </p>
      )}

      {skill.requiresEnv && effective && (
        <p className="text-[10px] text-amber-600 dark:text-amber-500 inline-flex items-center gap-1">
          <Info size={10} />
          Requires server configuration. The model is told if the API key isn't
          set; the toggle still records your intent.
        </p>
      )}
    </div>
  )
}

function Segment({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 rounded-none text-[10px] px-1 border-r border-[var(--border)] last:border-r-0",
        active
          ? "bg-[var(--primary)]/10 text-[var(--primary)] hover:bg-[var(--primary)]/15"
          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      )}
    >
      {children}
    </Button>
  )
}
