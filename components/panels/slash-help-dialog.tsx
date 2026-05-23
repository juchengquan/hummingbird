"use client"

import "client-only"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { COMMANDS } from "@/shared/commands/registry"
import { listSlashTriggers } from "@/shared/skills/slash-parser"
import { useStore } from "@/client/hooks/use-store"

/**
 * Cheat-sheet for the chat input's typed triggers, opened by `/help`
 * (or `/?`). Lists the three surfaces: `/` commands, `/` skills, and
 * `@` prompt mentions. Read-only; closes on overlay click / Esc.
 */
export function SlashHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const prompts = useStore((s) => s.prompts.filter((p) => !p.deletedAt))
  const skills = listSlashTriggers()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Chat input shortcuts</DialogTitle>
          <DialogDescription>
            Type these at the start of the message box.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 text-sm">
          <Section title="/ Commands — run now, nothing is sent">
            {COMMANDS.map((c) => (
              <Row
                key={c.id}
                token={`/${c.trigger}${c.argHint ? ` ${c.argHint}` : ""}`}
                desc={c.description}
              />
            ))}
          </Section>

          <Section title="/ Skills — force a capability for this message">
            {skills.map((s) => (
              <Row
                key={s.skillId}
                token={`/${s.trigger} …`}
                desc={s.skill.name}
              />
            ))}
          </Section>

          <Section title="@ Prompts — insert a saved template">
            {prompts.length === 0 ? (
              <p className="text-[13px] text-[var(--muted-foreground)] italic">
                No saved prompts yet. Create one from the Prompts group in
                the sidebar.
              </p>
            ) : (
              prompts.map((p) => (
                <Row key={p.id} token={`@${p.slug}`} desc={p.name} />
              ))
            )}
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)] mb-2">
        {title}
      </h3>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Row({ token, desc }: { token: string; desc: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <code className="font-mono text-[13px] text-[var(--foreground)] shrink-0 min-w-[120px]">
        {token}
      </code>
      <span className="text-[13px] text-[var(--muted-foreground)] truncate">
        {desc}
      </span>
    </div>
  )
}
