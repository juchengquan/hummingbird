"use client"

import { useEffect, useState } from "react"

import {
  Ban,
  CheckCircle2,
  Circle,
  CircleDot,
  FileText,
  Loader2,
  Pause,
  X,
  XCircle,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { MarkdownPreview } from "@/components/markdown-preview"
import {
  ToolCallStrip,
  type LiveToolCall,
} from "@/components/skills/tool-call-strip"
import { apiClient } from "@/client/api-client"
import { isTerminalStatus, type RunStatus } from "@/shared/agent/events"
import type { PlanItem } from "@/shared/agent/events"
import type { ChildRunRef, PendingInput, TaskRunView } from "@/shared/agent/project"
import type { RespondRequestInput } from "@/shared/api-schemas"
import {
  questionFromPendingInput,
  respondBodyForCardAnswer,
  type CardAnswer,
} from "@/shared/agent/answer-cards"
import { cn } from "@/shared/utils"

import { openChildRunViewer } from "@/client/agent/child-run-viewer/types"

import { AnswerCard } from "./interrupt-cards/answer-cards"
import { subagentPillLabel } from "./subagent-pill-label"

interface TaskStripProps {
  view: TaskRunView
  /** True while the client stream is open. */
  isRunning: boolean
  /** The id of the active run — used to poll child subagent statuses.
   *  Passed from `TasksSidebar` (which holds it from `useTaskRunContext`). */
  runId?: string | null
  /** Transport-level error (network / HTTP), shown alongside the run's
   *  own `view.fatalError`. */
  error?: string | null
  onCancel?: () => void
  /** Called when the human answers a `view.pendingInput`. The caller
   *  is responsible for hitting the respond endpoint. */
  onRespond?: (body: RespondRequestInput) => void | Promise<void>
  /** Optional "Open in editor" affordance for settled tasks whose
   *  output is a document (research mode — `PLAN-deep-research.md`).
   *  Rendered only when the run settles `done` AND a `resultText`
   *  exists. The caller is responsible for the hand-off (append to
   *  active doc, etc.). */
  onOpenInEditor?: () => void
  /** Label for the open-in-editor button. Defaults to "Open in editor". */
  openInEditorLabel?: string
  className?: string
}

/**
 * The in-flight surface for a long-running task — distinct from the
 * settled chat bubble. Renders the live `TaskRunView`: status + step
 * counter, the plan/todo list, tool pills, and streaming text. When the
 * run settles it collapses to a one-line badge (the result lands as a
 * normal assistant message, the durable record, handled by the caller).
 */
export function TaskStrip({
  view,
  isRunning,
  runId,
  error,
  onCancel,
  onRespond,
  onOpenInEditor,
  openInEditorLabel = "Open in editor",
  className,
}: TaskStripProps) {
  const [childStatuses, setChildStatuses] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!isRunning || !runId || view.childRuns.length === 0) return
    let active = true
    const load = async () => {
      const rows = await apiClient.tasks.listTaskChildren(runId)
      if (!active) return
      setChildStatuses(Object.fromEntries(rows.map((r) => [r.id, r.status])))
    }
    void load()
    const timer = setInterval(load, 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [isRunning, runId, view.childRuns.length])

  const terminal = isTerminalStatus(view.status)
  const errMsg = error ?? view.fatalError
  const canOpenInEditor =
    view.status === "done" &&
    !!onOpenInEditor &&
    !!view.resultText &&
    view.resultText.trim().length > 0

  if (terminal) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-1.5 text-xs text-[var(--muted-foreground)]",
          className
        )}
      >
        <StatusIcon status={view.status} />
        <span>{terminalSummary(view)}</span>
        {errMsg ? (
          <span className="text-[var(--destructive)] truncate">· {errMsg}</span>
        ) : null}
        {canOpenInEditor ? (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={onOpenInEditor}
          >
            <FileText />
            {openInEditorLabel}
          </Button>
        ) : null}
      </div>
    )
  }

  const calls: LiveToolCall[] = view.toolCalls.map((c) => ({
    id: c.toolCallId,
    name: c.toolName,
    argsLabel: argLabel(c.args),
    status: c.status,
    summary: c.summary,
    results: c.results,
  }))

  return (
    <div
      className={cn(
        "rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 space-y-2",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <StatusIcon status={view.status} />
          <span>{statusLabel(view.status)}</span>
          <span className="text-[var(--muted-foreground)]">
            · Step {view.step}
            {view.maxSteps ? ` / ${view.maxSteps}` : ""}
          </span>
        </div>
        {isRunning && onCancel ? (
          <Button size="xs" variant="ghost" onClick={onCancel}>
            <X />
            Cancel
          </Button>
        ) : null}
      </div>

      {view.pendingInput && onRespond ? (
        <InputRequestCard input={view.pendingInput} onRespond={onRespond} />
      ) : null}

      {view.plan.length > 0 ? <PlanList items={view.plan} /> : null}

      {view.childRuns.length > 0 ? (
        <SubagentGroup childRuns={view.childRuns} statuses={childStatuses} />
      ) : null}

      {calls.length > 0 ? <ToolCallStrip calls={calls} /> : null}

      {view.lastStepError ? (
        <p className="text-[11px] text-[var(--muted-foreground)]">
          Retried after error: {view.lastStepError}
        </p>
      ) : null}

      {view.reasoning ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--muted-foreground)]">
            Reasoning
          </summary>
          <MarkdownPreview
            content={view.reasoning}
            className="!p-0 text-[var(--muted-foreground)]"
          />
        </details>
      ) : null}

      {view.text ? (
        <MarkdownPreview content={view.text} className="!p-0" />
      ) : null}

      {errMsg ? (
        <p className="text-xs text-[var(--destructive)]">{errMsg}</p>
      ) : null}
    </div>
  )
}

/** The answer card shown when the run is paused on a pending input —
 *  approval, choice, input or a generative-UI part. The cards are shared
 *  with chat on runs (`components/agent/interrupt-cards/`); the answer
 *  goes to `/api/tasks/:id/respond` as it always has
 *  (`respondBodyForCardAnswer`). */
function InputRequestCard({
  input,
  onRespond,
}: {
  input: PendingInput
  onRespond: (body: RespondRequestInput) => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const submit = async (answer: CardAnswer) => {
    if (busy) return
    setBusy(true)
    try {
      await onRespond(respondBodyForCardAnswer(input.requestId, answer))
    } finally {
      setBusy(false)
    }
  }
  const handleAnswer = (answer: CardAnswer) => {
    // A generative-UI answer is sent without the busy state, as before.
    if ("uiAnswer" in answer) {
      void onRespond(respondBodyForCardAnswer(input.requestId, answer))
      return
    }
    void submit(answer)
  }
  return (
    <AnswerCard
      question={questionFromPendingInput(input)}
      busy={busy}
      onAnswer={handleAnswer}
    />
  )
}

function SubagentGroup({
  childRuns,
  statuses,
}: {
  childRuns: ChildRunRef[]
  statuses: Record<string, string>
}) {
  return (
    <ul className="space-y-0.5 text-xs">
      <li className="flex items-center gap-1.5 text-[var(--muted-foreground)] font-medium">
        Spawned {childRuns.length} subagent{childRuns.length === 1 ? "" : "s"}
      </li>
      {childRuns.map((c) => (
        <li key={c.childTaskId}>
          <button
            type="button"
            onClick={() => openChildRunViewer({ childTaskId: c.childTaskId })}
            className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-[var(--muted)]"
          >
            <span className="rounded-sm bg-[var(--muted)] px-1 py-0.5 text-[10px] leading-none text-[var(--muted-foreground)]">
              {subagentPillLabel(c.childTaskId, statuses)}
            </span>
            <span className="font-medium">{c.agent}</span>
            <span className="text-[var(--muted-foreground)] truncate">{c.subgoal}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function PlanList({ items }: { items: PlanItem[] }) {
  return (
    <ul className="space-y-0.5 text-xs">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-1.5">
          <PlanIcon status={item.status} />
          <span
            className={cn(
              item.status === "completed" &&
                "line-through text-[var(--muted-foreground)]"
            )}
          >
            {item.text}
          </span>
        </li>
      ))}
    </ul>
  )
}

function PlanIcon({ status }: { status: PlanItem["status"] }) {
  if (status === "completed")
    return <CheckCircle2 size={12} className="text-[var(--primary)]" />
  if (status === "in_progress")
    return <CircleDot size={12} className="text-[var(--primary)]" />
  return <Circle size={12} className="text-[var(--muted-foreground)]" />
}

function StatusIcon({ status }: { status: RunStatus }) {
  switch (status) {
    case "running":
    case "queued":
      return <Loader2 size={14} className="animate-spin text-[var(--primary)]" />
    case "paused":
      return <Pause size={14} className="text-[var(--muted-foreground)]" />
    case "done":
      return <CheckCircle2 size={14} className="text-[var(--primary)]" />
    case "failed":
      return <XCircle size={14} className="text-[var(--destructive)]" />
    case "cancelled":
      return <Ban size={14} className="text-[var(--muted-foreground)]" />
  }
}

function statusLabel(status: RunStatus): string {
  switch (status) {
    case "queued":
      return "Queued"
    case "running":
      return "Running"
    case "paused":
      return "Paused"
    case "done":
      return "Done"
    case "failed":
      return "Failed"
    case "cancelled":
      return "Cancelled"
  }
}

function terminalSummary(view: TaskRunView): string {
  const steps = `${view.step} step${view.step === 1 ? "" : "s"}`
  switch (view.status) {
    case "done":
      return `Task finished · ${steps}`
    case "failed":
      return `Task failed · ${steps}`
    case "cancelled":
      return `Task cancelled · ${steps}`
    default:
      return `Task ended · ${steps}`
  }
}

/** Best-effort short label from a tool's input — the query string most
 *  search-style tools carry. Falls back to undefined (generic pill). */
function argLabel(args: unknown): string | undefined {
  if (args && typeof args === "object") {
    const q = (args as { query?: unknown }).query
    if (typeof q === "string" && q.trim()) return q.slice(0, 80)
  }
  return undefined
}
