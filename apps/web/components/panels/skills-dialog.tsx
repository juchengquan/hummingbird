"use client"

import { useEffect, useMemo, useState } from "react"
import { Download, Link2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { useStore } from "@/client/hooks/use-store"
import { parseSkillMd, toSkillMd } from "@/shared/skills/skill-md"
import {
  encodeSkillShareToken,
  toShareableUserSkill,
} from "@/shared/skills/user-skill-share"
import type { UserSkill } from "@/shared/skills/user-skill-types"

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
 * Manage-skills dialog. Opened from the `/skills` action command
 * (`PLAN-portable-skills.md`). Combines list + create/edit form in one
 * dialog, mirroring `AgentsDialog`. A user skill is portable, data-not-
 * code instructions (SKILL.md): when enabled, its body folds into this
 * workspace's system prompt. Authoring lands here on top of the engine
 * (#187) — slice mutators + parse/share helpers already exist.
 */
interface SkillsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SkillsDialog({ open, onOpenChange }: SkillsDialogProps) {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const allSkills = useStore((s) => s.userSkills)
  const skills = useMemo(
    () =>
      allSkills
        .filter((s) => s.workspaceId === activeWorkspaceId && !s.deletedAt)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [allSkills, activeWorkspaceId]
  )
  const createUserSkill = useStore((s) => s.createUserSkill)
  const updateUserSkill = useStore((s) => s.updateUserSkill)
  const deleteUserSkill = useStore((s) => s.deleteUserSkill)
  const setUserSkillEnabled = useStore((s) => s.setUserSkillEnabled)

  const [editing, setEditing] = useState<UserSkill | null>(null)
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    if (!open) {
      setEditing(null)
      setShowForm(false)
    }
  }, [open])

  const handleBack = () => {
    setEditing(null)
    setShowForm(false)
  }

  const copyShareUrl = (s: UserSkill) => {
    try {
      const token = encodeSkillShareToken(toShareableUserSkill(s))
      const origin =
        typeof window !== "undefined" ? window.location.origin : ""
      void navigator.clipboard.writeText(`${origin}/?import-skill=${token}`)
      toast.success("Share URL copied to clipboard")
    } catch {
      toast.error("Couldn't generate share URL")
    }
  }

  const copySkillMd = (s: UserSkill) => {
    try {
      void navigator.clipboard.writeText(toSkillMd(toShareableUserSkill(s)))
      toast.success("SKILL.md copied to clipboard")
    } catch {
      toast.error("Couldn't export SKILL.md")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {showForm ? (editing ? "Edit skill" : "New skill") : "Skills"}
          </DialogTitle>
          <DialogDescription>
            {showForm
              ? "Standing instructions (SKILL.md). When enabled, the body is added to this workspace's chats."
              : "Portable skills for this workspace. Enable one to fold its instructions into every chat here."}
          </DialogDescription>
        </DialogHeader>

        {showForm ? (
          <SkillForm
            initial={editing}
            onSubmit={(payload) => {
              if (editing) {
                updateUserSkill(editing.id, payload)
              } else if (activeWorkspaceId) {
                createUserSkill({ workspaceId: activeWorkspaceId, ...payload })
              }
              handleBack()
            }}
            onCancel={handleBack}
            onDelete={
              editing
                ? () => {
                    deleteUserSkill(editing.id)
                    handleBack()
                  }
                : undefined
            }
          />
        ) : (
          <div className="space-y-2">
            {skills.length === 0 ? (
              <p className="text-[13px] text-[var(--muted-foreground)] italic py-4 text-center">
                No skills yet. Create one, or import a shared SKILL.md URL.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {skills.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 py-2 text-sm">
                    <button
                      type="button"
                      onClick={() => setUserSkillEnabled(s.id, !s.enabled)}
                      title={s.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
                      className={
                        "shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors " +
                        (s.enabled
                          ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
                          : "border-[var(--border)] text-[var(--muted-foreground)]")
                      }
                    >
                      {s.enabled ? "On" : "Off"}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{s.name}</div>
                      {s.description ? (
                        <div className="text-[11px] text-[var(--muted-foreground)] truncate">
                          {s.description}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => copyShareUrl(s)}
                      title="Copy a share URL — recipients import this skill into their workspace."
                    >
                      <Link2 size={12} />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => copySkillMd(s)}
                      title="Copy this skill as SKILL.md text."
                    >
                      <Download size={12} />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        setEditing(s)
                        setShowForm(true)
                      }}
                    >
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
              onClick={() => {
                setEditing(null)
                setShowForm(true)
              }}
              disabled={!activeWorkspaceId}
            >
              <Plus size={14} />
              New skill
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface SkillFormProps {
  initial: UserSkill | null
  onSubmit: (payload: {
    name: string
    description?: string
    whenToUse?: string
    body?: string
  }) => void
  onCancel: () => void
  onDelete?: () => void
}

function SkillForm({ initial, onSubmit, onCancel, onDelete }: SkillFormProps) {
  const [name, setName] = useState(initial?.name ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [whenToUse, setWhenToUse] = useState(initial?.whenToUse ?? "")
  const [body, setBody] = useState(initial?.body ?? "")
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasted, setPasted] = useState("")

  const applyPaste = () => {
    const parsed = parseSkillMd(pasted)
    if ("error" in parsed) {
      toast.error(parsed.error)
      return
    }
    setName(parsed.name)
    setDescription(parsed.description)
    setWhenToUse(parsed.whenToUse)
    setBody(parsed.body)
    setPasteOpen(false)
    setPasted("")
    toast.success("Parsed SKILL.md into the form")
  }

  const handleSubmit = () => {
    if (!name.trim()) return
    onSubmit({ name: name.trim(), description, whenToUse, body })
  }

  return (
    <div className="space-y-3 text-sm">
      {/* Paste-a-SKILL.md shortcut — fills the fields from a pasted file. */}
      {!initial && (
        <div>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setPasteOpen((v) => !v)}
            className="text-[11px]"
          >
            {pasteOpen ? "Hide paste" : "Paste a SKILL.md instead"}
          </Button>
          {pasteOpen && (
            <div className="mt-1 space-y-1">
              <Textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={5}
                placeholder={"---\nname: Code Reviewer\ndescription: Reviews diffs\n---\nYou are a meticulous reviewer…"}
                className="font-mono text-xs"
              />
              <Button size="xs" onClick={applyPaste} disabled={!pasted.trim()}>
                Parse into fields
              </Button>
            </div>
          )}
        </div>
      )}
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Code reviewer"
        />
      </Field>
      <Field label="Description" hint="One-line summary of what this skill does.">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Reviews diffs for bugs and clarity"
        />
      </Field>
      <Field label="When to use" hint="Informational hint for now.">
        <Input
          value={whenToUse}
          onChange={(e) => setWhenToUse(e.target.value)}
          placeholder="When the user shares a diff or asks for a review"
        />
      </Field>
      <Field
        label="Instructions"
        hint="Added to the system prompt while this skill is enabled."
      >
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="You are a meticulous code reviewer. Flag security bugs first, then clarity…"
        />
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
        <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{hint}</p>
      ) : null}
    </div>
  )
}
