"use client"

import { FileText, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ChildRuns } from "@/client/agent/use-child-runs"
import { openChildRunViewer } from "@/client/agent/child-run-viewer/types"
import { taskProgress } from "@/client/agent/task-progress"
import { isTerminalStatus, type RunStatus } from "@/shared/agent/events"
import type { ChildRunRef, TaskRunView } from "@/shared/agent/project"
import { cn } from "@/shared/utils"

import { subagentPillLabel } from "./subagent-pill-label"
import { StatusIcon, SubagentRows, TaskRunBody } from "./task-run-body"
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

      <TaskRunBody
        view={view}
        idle={idle}
        hasSubagents={view.childRuns.length > 0}
        subagents={
          view.childRuns.length > 0 ? (
            <SubagentGroup childRuns={view.childRuns} childState={childState} />
          ) : null
        }
      />
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
  const statuses = Object.fromEntries((childState?.rows ?? []).map((r) => [r.id, r.status]))
  return (
    <SubagentRows
      stale={childState?.stale}
      rows={childRuns.map((c) => {
        const status = statuses[c.childTaskId]
        return {
          id: c.childTaskId,
          agent: c.agent,
          subgoal: c.subgoal,
          label: subagentPillLabel(c.childTaskId, statuses),
          canSkip: !!childState && !!status && !isTerminalStatus(status as RunStatus),
          skipping: !!childState?.skipping.has(c.childTaskId),
        }
      })}
      onOpen={(id) => openChildRunViewer({ childTaskId: id })}
      onSkip={childState ? (id) => void childState.skip(id) : undefined}
    />
  )
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
