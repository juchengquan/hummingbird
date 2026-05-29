"use client"

import "client-only"

import { useCallback, useEffect, useState } from "react"
import { CalendarClock, Pause, Pencil, Play, Plus, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { apiClient } from "@/client/api-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/shared/utils"
import type {
  ScheduleCreateInput,
  ScheduleResponse,
} from "@/shared/api-schemas"

/**
 * Workspace-scoped section for managing scheduled task runs ("run every
 * morning"). Sits inside the WorkspaceDetailSheet under the existing
 * MCP section. Step 7 of `PLAN-agent-task-queue.md`.
 *
 * Scope of v1: a flat list with a tiny inline editor. No skill picker
 * / model override UI yet — those fields exist server-side and can be
 * driven via the API today; the visual editor is a Phase 5-style
 * follow-up. Filling the gaps would mostly be a couple of `<Select>`s.
 */
export function ScheduleSection({ workspaceId }: { workspaceId: string }) {
  const [schedules, setSchedules] = useState<ScheduleResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ScheduleResponse | "new" | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const all = await apiClient.tasks.schedules.list()
      setSchedules(all.filter((s) => s.workspaceId === workspaceId))
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          <CalendarClock className="inline-block mr-1 -mt-0.5" size={12} />
          Schedules
        </h3>
        {editing === null && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setEditing("new")}
            className="text-xs"
          >
            <Plus />
            Add
          </Button>
        )}
      </div>

      {editing === "new" ? (
        <ScheduleEditor
          workspaceId={workspaceId}
          schedule={null}
          onClose={() => {
            setEditing(null)
            void refresh()
          }}
        />
      ) : editing ? (
        <ScheduleEditor
          workspaceId={workspaceId}
          schedule={editing}
          onClose={() => {
            setEditing(null)
            void refresh()
          }}
        />
      ) : (
        <div className="mt-2 space-y-1.5">
          {loading ? (
            <p className="text-[11px] text-[var(--muted-foreground)]">Loading…</p>
          ) : schedules.length === 0 ? (
            <p className="text-[11px] text-[var(--muted-foreground)]">
              No schedules yet. Add one to run a saved prompt on a cron.
            </p>
          ) : (
            schedules.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                onEdit={() => setEditing(s)}
                onRefresh={refresh}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function ScheduleRow({
  schedule,
  onEdit,
  onRefresh,
}: {
  schedule: ScheduleResponse
  onEdit: () => void
  onRefresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    setBusy(true)
    try {
      const res = await apiClient.tasks.schedules.update(schedule.id, {
        enabled: !schedule.enabled,
      })
      if (!res.ok) toast.error(res.error.message ?? "Couldn't update schedule.")
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!confirm(`Delete schedule "${schedule.name}"?`)) return
    setBusy(true)
    try {
      const res = await apiClient.tasks.schedules.delete(schedule.id)
      if (!res.ok) toast.error(res.error?.message ?? "Couldn't delete schedule.")
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 rounded-md border border-[var(--border)]",
        !schedule.enabled && "opacity-60"
      )}
    >
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{schedule.name}</p>
        <p className="text-[10px] text-[var(--muted-foreground)] font-mono">
          {schedule.cron}{" "}
          <span className="text-[var(--muted-foreground)]/70">
            ({schedule.timezone})
          </span>
        </p>
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={toggle}
        disabled={busy}
        title={schedule.enabled ? "Pause" : "Resume"}
        aria-label={schedule.enabled ? "Pause schedule" : "Resume schedule"}
      >
        {schedule.enabled ? <Pause size={12} /> : <Play size={12} />}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={onEdit}
        disabled={busy}
        title="Edit"
        aria-label="Edit schedule"
      >
        <Pencil size={12} />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={remove}
        disabled={busy}
        title="Delete"
        aria-label="Delete schedule"
        className="text-[var(--destructive)]"
      >
        <Trash2 size={12} />
      </Button>
    </div>
  )
}

function ScheduleEditor({
  workspaceId,
  schedule,
  onClose,
}: {
  workspaceId: string
  schedule: ScheduleResponse | null
  onClose: () => void
}) {
  const [name, setName] = useState(schedule?.name ?? "")
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "")
  const [cron, setCron] = useState(schedule?.cron ?? "0 8 * * *")
  const [timezone, setTimezone] = useState(
    schedule?.timezone ?? guessLocalTimezone()
  )
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!name.trim() || !prompt.trim() || !cron.trim()) {
      toast.error("Name, prompt, and cron are required.")
      return
    }
    setBusy(true)
    try {
      const body: ScheduleCreateInput = {
        workspaceId,
        name: name.trim(),
        prompt: prompt.trim(),
        cron: cron.trim(),
        timezone: timezone.trim() || "UTC",
        // skills / model / systemPrompt / maxSteps inherit from
        // workspace defaults until the editor exposes them.
        skills: undefined,
      }
      const res = schedule
        ? await apiClient.tasks.schedules.update(schedule.id, body)
        : await apiClient.tasks.schedules.create(body)
      if (!res.ok) {
        toast.error(res.error.message ?? "Couldn't save schedule.")
        return
      }
      toast.success(schedule ? "Schedule updated." : "Schedule created.")
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-[var(--border)] p-2 bg-[var(--card)]">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium">
          {schedule ? "Edit schedule" : "New schedule"}
        </p>
        <Button size="icon-xs" variant="ghost" onClick={onClose} aria-label="Cancel">
          <X size={12} />
        </Button>
      </div>
      <div>
        <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
          Name
        </label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Morning briefing"
          className="mt-0.5 text-xs"
        />
      </div>
      <div>
        <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
          Prompt
        </label>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Summarise yesterday's commits and pin three priorities."
          className="mt-0.5 text-xs resize-y min-h-[60px]"
          rows={3}
        />
      </div>
      <div className="grid grid-cols-[1fr_1fr] gap-2">
        <div>
          <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
            Cron
          </label>
          <Input
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 8 * * *"
            className="mt-0.5 text-xs font-mono"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
            Timezone
          </label>
          <Input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="America/Los_Angeles"
            className="mt-0.5 text-xs"
          />
        </div>
      </div>
      <p className="text-[10px] text-[var(--muted-foreground)]">
        Five-field cron, e.g. <code>0 8 * * *</code> = every day at 08:00 in the given timezone.
      </p>
      <div className="flex items-center gap-2 pt-1">
        <Button size="xs" onClick={submit} disabled={busy}>
          {schedule ? "Save" : "Create"}
        </Button>
        <Button size="xs" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/** Best-effort guess at the user's IANA timezone from the browser. */
function guessLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}
