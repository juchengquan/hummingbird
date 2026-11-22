"use client"

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
import type { ChildRuns } from "@/client/agent/use-child-runs"
import { openChildRunViewer } from "@/client/agent/child-run-viewer/types"
import { taskProgress } from "@/client/agent/task-progress"
import { isTerminalStatus, type RunStatus } from "@/shared/agent/events"
import type { PlanItem } from "@/shared/agent/events"
import type { ChildRunRef, TaskRunView } from "@/shared/agent/project"
import { cn } from "@/shared/utils"

import { subagentPillLabel } from "./subagent-pill-label"
import { TaskQuestion } from "./task-question"

interface TaskStripProps {
  view: TaskRunView
  /** True until the task ends (also while it waits, or reconnects). */
  isRunning: boolean
  /** The id of the run — where its question's answer goes. */
  runId?: string | null
  /** Its sub-agents' rows and questions (a top-level task's). */
  childState?: ChildRuns
  /** This is a sub-agent's run: cancelling it skips it (Q60). */
  subagent?: boolean
  /** Transport-level error (network / HTTP), shown alongside the run's
   *  own `view.fatalError`. */
  error?: string | null
  onCancel?: () => void
  cancelling?: boolean
  /** An answer found the question closed: re-read the run. */
  onStale?: () => void
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
  childState,
  subagent,
  error,
  onCancel,
  cancelling,
  onStale,
  onOpenInEditor,
  openInEditorLabel = "Open in editor",
  className,
}: TaskStripProps) {
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
          "flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-1.5 text-xs text-[var(--muted-foreground)]",
          className
        )}
      >
        <StatusIcon status={view.status} />
        <span>{terminalSummary(view, subagent)}</span>
        {errMsg ? (
          <span className="min-w-0 break-words text-[var(--destructive)]">· {errMsg}</span>
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

  const progress = taskProgress(view, childState)
  // While the task waits (for the user, or its sub-agents) none of its
  // calls runs: the asked one has its card, and the turn's later ones
  // haven't started. A spawn is shown as the sub-agent list.
  const idle = progress.paused || !!childState?.waiting
  const shownCalls = view.toolCalls.filter(
    (c) =>
      c.status === "done" ||
      (!idle && !(c.toolName === "spawnSubagent" && view.childRuns.length > 0))
  )
  const calls: LiveToolCall[] = shownCalls.map((c) => ({
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
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-1.5 text-xs font-medium">
          <span className="mt-px shrink-0">
            <StatusIcon status={progress.paused ? "paused" : view.status} />
          </span>
          <p className="min-w-0 break-words">
            <span role="status">{progress.label}</span>{" "}
            <span className="text-[var(--muted-foreground)]">
              · Step {view.step}
              {view.maxSteps ? ` / ${view.maxSteps}` : ""}
            </span>
          </p>
        </div>
        {isRunning && onCancel ? (
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0"
            // A question's own "Cancel" (a confirm card) can sit right below.
            aria-label={subagent ? "Skip" : "Cancel task"}
            title={subagent ? "Skip this sub-agent" : "Cancel the task and its sub-agents"}
            disabled={cancelling}
            onClick={onCancel}
          >
            <X />
            {subagent ? "Skip" : "Cancel"}
          </Button>
        ) : null}
      </div>

      {/* Up here, not under the text: a failed cancel or watch must be seen. */}
      {errMsg ? (
        <p role="alert" className="break-words text-xs text-[var(--destructive)]">
          {errMsg}
        </p>
      ) : null}

      {view.pendingInput && runId ? (
        <TaskQuestion
          key={`${runId}:${view.pendingInput.requestId}`}
          runId={runId}
          input={view.pendingInput}
          onStale={onStale}
        />
      ) : null}

      {childState?.asking.length ? (
        <ChildQuestions childRuns={view.childRuns} childState={childState} />
      ) : null}

      {view.plan.length > 0 ? <PlanList items={view.plan} /> : null}

      {view.childRuns.length > 0 ? (
        <SubagentGroup childRuns={view.childRuns} childState={childState} />
      ) : null}

      {calls.length > 0 ? <ToolCallStrip calls={calls} className="[&>span]:max-w-full" /> : null}

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
    </div>
  )
}

/** The sub-agents' questions, on their parent (Q59). Each answer goes
 *  to the child's own id. */
function ChildQuestions({
  childRuns,
  childState,
}: {
  childRuns: ChildRunRef[]
  childState: ChildRuns
}) {
  return (
    <div className="space-y-2">
      {childState.asking.map((child) => {
        const ref = childRuns.find((c) => c.childTaskId === child.id)
        const input = child.pendingInput
        if (!input) return null
        return (
          <div
            key={`${child.id}:${input.requestId}`}
            role="group"
            aria-label={`Question from sub-agent ${ref?.agent ?? child.goal}`}
            className="min-w-0 space-y-1"
          >
            <p className="break-words text-xs text-[var(--muted-foreground)]">
              <span className="font-medium text-[var(--foreground)]">
                {ref?.agent ?? "Sub-agent"}
              </span>{" "}
              asks · {ref?.subgoal || child.goal}
            </p>
            <TaskQuestion runId={child.id} input={input} onStale={childState.refresh} />
          </div>
        )
      })}
    </div>
  )
}

function SubagentGroup({
  childRuns,
  childState,
}: {
  childRuns: ChildRunRef[]
  childState?: ChildRuns
}) {
  const rows = childState?.rows ?? []
  const statuses = Object.fromEntries(rows.map((r) => [r.id, r.status]))
  return (
    <ul className="space-y-0.5 text-xs">
      <li className="flex items-center gap-1.5 text-[var(--muted-foreground)] font-medium">
        Spawned {childRuns.length} subagent{childRuns.length === 1 ? "" : "s"}
      </li>
      {childState?.stale ? (
        <li className="text-[var(--destructive)]">
          Couldn&apos;t refresh the sub-agents. Retrying…
        </li>
      ) : null}
      {childRuns.map((c) => {
        const status = statuses[c.childTaskId]
        const canSkip = !!status && !isTerminalStatus(status as RunStatus)
        return (
          <li key={c.childTaskId} className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={() => openChildRunViewer({ childTaskId: c.childTaskId })}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-[var(--muted)]"
            >
              <span className="shrink-0 rounded-sm bg-[var(--muted)] px-1 py-0.5 text-[10px] leading-none text-[var(--muted-foreground)]">
                {subagentPillLabel(c.childTaskId, statuses)}
              </span>{" "}
              <span className="min-w-0 truncate font-medium">{c.agent}</span>{" "}
              <span className="min-w-0 truncate text-[var(--muted-foreground)]">{c.subgoal}</span>
            </button>
            {canSkip && childState ? (
              <Button
                size="xs"
                variant="ghost"
                className="shrink-0"
                disabled={childState.skipping.has(c.childTaskId)}
                aria-label={`Skip sub-agent ${c.agent}`}
                title="Skip this sub-agent; the task carries on"
                onClick={() => void childState.skip(c.childTaskId)}
              >
                Skip
              </Button>
            ) : null}
          </li>
        )
      })}
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

function terminalSummary(view: TaskRunView, subagent?: boolean): string {
  const steps = `${view.step} step${view.step === 1 ? "" : "s"}`
  if (subagent && view.status === "cancelled") return `Sub-agent skipped · ${steps}`
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
