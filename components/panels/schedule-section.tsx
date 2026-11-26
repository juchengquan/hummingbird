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
import { CHAT_MODELS } from "@/shared/models"
import {
  modelsForBackend,
  TASK_FALLBACK_MODEL,
  TASK_MODEL_BACKEND,
} from "@/shared/backend-models"
import { useServedModels } from "@/client/hooks/use-served-models"
import type {
  ScheduleCreateInput,
  ScheduleResponse,
} from "@/shared/api-schemas"

/**
 * Workspace-scoped section for managing scheduled task runs ("run every
 * morning"). Sits inside the WorkspaceDetailSheet under the existing
 * MCP section. Step 7 of `PLAN-agent-task-queue.md`.
 *
 * A flat list with a tiny inline editor. The editor shows the model a
 * schedule runs on and offers the models tasks can run (Q73): Haiku by
 * default (Q67), as the server gives a schedule saved without one.
 * Schedules that had no model were paused by migration 0047; the list
 * says so, and resuming one gives it Haiku (Q80). No skill picker yet.
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
              No schedules yet. Each run is a task: its result goes into a
              new conversation and shows in the Tasks panel.
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
      else if (!schedule.enabled && !schedule.model) {
        // Q80: resuming a model-less schedule gives it the default.
        toast.success(
          `Resumed. It runs on ${modelLabel(res.schedule.model ?? TASK_FALLBACK_MODEL)}.`
        )
      }
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
        <p className="text-[10px] text-[var(--muted-foreground)]">
          {schedule.model ? modelLabel(schedule.model) : "No model"}
          {schedule.enabled ? null : " · Paused"}
        </p>
        {!schedule.enabled && !schedule.model ? <PausedNoModelNote /> : null}
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
  // A model-less schedule is shown — and saved — with the default.
  const [model, setModel] = useState(schedule?.model ?? TASK_FALLBACK_MODEL)
  useServedModels() // re-render when agent-py's task models arrive (Q119)
  const taskModels = modelsForBackend(TASK_MODEL_BACKEND.kind)
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
        model,
        // skills / systemPrompt / maxSteps: the server's defaults until
        // the editor exposes them.
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
      <div>
        <label
          htmlFor={`schedule-model-${schedule?.id ?? "new"}`}
          className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]"
        >
          Model
        </label>
        <select
          id={`schedule-model-${schedule?.id ?? "new"}`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="mt-0.5 block w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-xs"
        >
          {/* A saved model tasks can no longer run is kept visible, not swapped silently. */}
          {taskModels.some((m) => m.id === model) ? null : (
            <option value={model}>{modelLabel(model)}</option>
          )}
          {taskModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {schedule && !schedule.model ? (
        <p className="text-[10px] leading-snug text-amber-600 dark:text-amber-500">
          This schedule had no model{schedule.enabled ? "" : " and is paused"}. Saving
          gives it {modelLabel(model)}
          {schedule.enabled ? "" : "; resume it from the list to run it again"}.
        </p>
      ) : null}
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

/** Q73/Q80: migration 0047 paused schedules without a model. */
function PausedNoModelNote() {
  return (
    <p className="text-[10px] leading-snug text-amber-600 dark:text-amber-500">
      Paused because it had no model. Resume it to run it on {modelLabel(TASK_FALLBACK_MODEL)}.
    </p>
  )
}

function modelLabel(id: string): string {
  return CHAT_MODELS.find((m) => m.id === id)?.label ?? id
}

/** Best-effort guess at the user's IANA timezone from the browser. */
function guessLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}
