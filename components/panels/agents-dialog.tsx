"use client"

import { useEffect, useMemo, useState } from "react"
import { Plus, Trash2, UserCircle } from "lucide-react"

import { useStore } from "@/client/hooks/use-store"
import { SKILLS } from "@/shared/skills/registry"
import type { Agent } from "@/shared/types"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

/**
 * Manage-personas dialog. Opened from the `/personas` action command
 * (`PLAN-custom-agents.md`). Combines the list + the create/edit form
 * in a single dialog — simpler than the prompt-library's
 * sidebar-list + per-item dialog pattern, since personas are accessed
 * less often (a saved recipe, not a hot creative loop).
 *
 * Phase 1: name, system prompt, model, allowed skills. MCP allow-list
 * + share-by-URL land in Phase 2.
 */
interface AgentsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AgentsDialog({ open, onOpenChange }: AgentsDialogProps) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const allAgents = useStore((s) => s.agents)
  const agents = useMemo(
    () =>
      allAgents
        .filter((a) => a.workspaceId === activeWorkspaceId && !a.deletedAt)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [allAgents, activeWorkspaceId]
  )
  const createAgent = useStore((s) => s.createAgent)
  const updateAgent = useStore((s) => s.updateAgent)
  const deleteAgent = useStore((s) => s.deleteAgent)

  const [editing, setEditing] = useState<Agent | null>(null)
  const [showForm, setShowForm] = useState(false)

  // Reset internal state when the dialog closes.
  useEffect(() => {
    if (!open) {
      setEditing(null)
      setShowForm(false)
    }
  }, [open])

  const handleCreate = () => {
    setEditing(null)
    setShowForm(true)
  }
  const handleEdit = (a: Agent) => {
    setEditing(a)
    setShowForm(true)
  }
  const handleBack = () => {
    setEditing(null)
    setShowForm(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {showForm
              ? editing
                ? "Edit persona"
                : "New persona"
              : "Personas"}
          </DialogTitle>
          <DialogDescription>
            {showForm
              ? "A saved bundle of system prompt + model + allowed skills. Invoke via /<slug>."
              : "Saved AI personas — invoke any with /<slug> in the chat input."}
          </DialogDescription>
        </DialogHeader>

        {showForm ? (
          <AgentForm
            initial={editing}
            workspaceId={activeWorkspaceId}
            onSubmit={(payload) => {
              if (editing) {
                updateAgent(editing.id, payload)
              } else if (activeWorkspaceId) {
                createAgent({ workspaceId: activeWorkspaceId, ...payload })
              }
              handleBack()
            }}
            onCancel={handleBack}
            onDelete={
              editing
                ? () => {
                    deleteAgent(editing.id)
                    handleBack()
                  }
                : undefined
            }
          />
        ) : (
          <div className="space-y-2">
            {agents.length === 0 ? (
              <p className="text-[13px] text-[var(--muted-foreground)] italic py-4 text-center">
                No personas yet. Create one to invoke via{" "}
                <code className="font-mono">/&lt;slug&gt;</code>.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {agents.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-3 py-2 text-sm"
                  >
                    <UserCircle
                      size={16}
                      className="shrink-0 text-[var(--muted-foreground)]"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{a.name}</div>
                      <div className="font-mono text-[11px] text-[var(--muted-foreground)] truncate">
                        /{a.slug}
                      </div>
                    </div>
                    <Button size="xs" variant="ghost" onClick={() => handleEdit(a)}>
                      Edit
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={handleCreate}
              disabled={!activeWorkspaceId}
            >
              <Plus size={14} />
              New persona
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface AgentFormProps {
  initial: Agent | null
  workspaceId: string | null
  onSubmit: (payload: {
    name: string
    slug?: string
    systemPrompt?: string
    modelId?: string
    allowedSkillIds?: string[]
  }) => void
  onCancel: () => void
  onDelete?: () => void
}

function AgentForm({
  initial,
  workspaceId,
  onSubmit,
  onCancel,
  onDelete,
}: AgentFormProps) {
  const [name, setName] = useState(initial?.name ?? "")
  const [slug, setSlug] = useState(initial?.slug ?? "")
  const [systemPrompt, setSystemPrompt] = useState(
    initial?.systemPrompt ?? ""
  )
  const [modelId, setModelId] = useState(initial?.modelId ?? "")
  const [allowedSkillIds, setAllowedSkillIds] = useState<Set<string>>(
    () => new Set(initial?.allowedSkillIds ?? [])
  )

  const toggleSkill = (id: string) => {
    setAllowedSkillIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSubmit = () => {
    if (!name.trim() || !workspaceId) return
    onSubmit({
      name: name.trim(),
      slug: slug.trim() || undefined,
      systemPrompt: systemPrompt,
      modelId: modelId.trim() || undefined,
      allowedSkillIds: [...allowedSkillIds],
    })
  }

  return (
    <div className="space-y-3 text-sm">
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Code reviewer"
        />
      </Field>
      <Field
        label="Slug"
        hint="Invoke via /<slug>. Auto-derived from name if blank."
      >
        <Input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="code-reviewer"
          className="font-mono text-xs"
        />
      </Field>
      <Field label="System prompt">
        <Textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={5}
          placeholder="You review pull-request diffs and flag security bugs and style issues…"
        />
      </Field>
      <Field
        label="Model override"
        hint="Leave blank to inherit the workspace default."
      >
        <Input
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder="claude-sonnet-4-6"
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label="Allowed skills"
        hint="Force-enabled for this persona's turns; cascade is otherwise honoured."
      >
        <div className="flex flex-wrap gap-2">
          {SKILLS.map((s) => {
            const checked = allowedSkillIds.has(s.id)
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => toggleSkill(s.id)}
                className={
                  "px-2 py-1 rounded-md border text-[11px] transition-colors " +
                  (checked
                    ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
                    : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]")
                }
              >
                {s.name}
              </button>
            )
          })}
        </div>
      </Field>

      <div className="flex justify-between items-center pt-2">
        {onDelete ? (
          <Button size="sm" variant="ghost" onClick={onDelete}>
            <Trash2 size={14} />
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!name.trim()}>
            {initial ? "Save" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)] mb-1">
        {label}
      </label>
      {children}
      {hint ? (
        <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
