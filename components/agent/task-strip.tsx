"use client"

import {
  Ban,
  CheckCircle2,
  Circle,
  CircleDot,
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
import { isTerminalStatus, type RunStatus } from "@/shared/agent/events"
import type { PlanItem } from "@/shared/agent/events"
import type { TaskRunView } from "@/shared/agent/project"
import { cn } from "@/shared/utils"

interface TaskStripProps {
  view: TaskRunView
  /** True while the client stream is open. */
  isRunning: boolean
  /** Transport-level error (network / HTTP), shown alongside the run's
   *  own `view.fatalError`. */
  error?: string | null
  onCancel?: () => void
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
  error,
  onCancel,
  className,
}: TaskStripProps) {
  const terminal = isTerminalStatus(view.status)
  const errMsg = error ?? view.fatalError

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

      {view.plan.length > 0 ? <PlanList items={view.plan} /> : null}

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
