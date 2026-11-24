"use client"

/**
 * One task in the runs list (Q69): a row with its title and badge, and,
 * expanded, its view — the questions (its own and its sub-agents', Q59),
 * Cancel (the whole task, Q60), the step-limit note (Q81), then the same
 * plan / sub-agents / tool pills / text the old strip shows
 * (`TaskRunBody`). Only an expanded task is watched (`useTaskView`).
 */

import { useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight, FileText, MessageSquare, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useStore } from "@/client/hooks/use-store"
import { useTasks, useTaskView } from "@/client/runs/tasks/context"
import type { TaskQuestion, TaskSummary, TaskView } from "@/client/runs/tasks/types"
import { cn } from "@/shared/utils"

import { StatusIcon, SubagentRows, TaskRunBody } from "../task-run-body"

import { useTaskFocus } from "./focus"
import {
  childCanSkip,
  childPill,
  isActivePhase,
  phaseLabel,
  stepLimitNoteFor,
  stripStatus,
  taskGoalLine,
} from "./phase"
import { TaskTitle } from "./task-title"
import { TaskQuestionCard } from "./task-question-card"

export function TaskCard({ task }: { task: TaskSummary }) {
  const expandedSet = useTaskFocus((s) => s.expanded)
  const collapsedSet = useTaskFocus((s) => s.collapsed)
  const toggle = useTaskFocus((s) => s.toggle)
  const focused = useTaskFocus((s) => s.focused)
  const clearFocus = useTaskFocus((s) => s.clearFocus)
  const openAsking = useTaskFocus((s) => s.openAsking)
  const ref = useRef<HTMLLIElement>(null)
  // A task waiting on an answer opens by itself, unless it was closed,
  // and stays open after the answer is sent.
  const asking = task.phase === "needs_answer"
  const expanded =
    expandedSet.has(task.rootRunId) || (asking && !collapsedSet.has(task.rootRunId))
  useEffect(() => {
    if (asking) openAsking(task.rootRunId)
  }, [asking, task.rootRunId, openAsking])

  useEffect(() => {
    if (focused !== task.rootRunId) return
    ref.current?.scrollIntoView({ block: "nearest" })
    clearFocus()
  }, [focused, task.rootRunId, clearFocus])

  const label = phaseLabel(task)
  const note = stepLimitNoteFor(task)
  const detailsId = `task-${task.rootRunId}`

  return (
    <li
      ref={ref}
      aria-label={`Task: ${taskGoalLine(task.title)}`}
      className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 space-y-2"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => toggle(task.rootRunId, expanded)}
        className="flex w-full min-w-0 items-start gap-1.5 text-left text-xs"
      >
        <span className="mt-px shrink-0">
          <StatusIcon status={stripStatus(task.phase)} />
        </span>
        <span className="min-w-0 flex-1">
          <TaskTitle goal={task.title} conversationId={task.conversationId} />
          <span className="flex flex-wrap items-center gap-x-1.5 text-[var(--muted-foreground)]">
            <span role="status">{label}</span>
            {task.research ? (
              <span className="rounded-sm bg-[var(--muted)] px-1 text-[10px] leading-4">Research</span>
            ) : null}
          </span>
        </span>
        <span className="mt-px shrink-0 text-[var(--muted-foreground)]">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {task.phase === "failed" && task.error ? (
        <p role="alert" className="break-words text-xs text-[var(--destructive)]">
          {task.error.message}
        </p>
      ) : null}
      {note ? <p className="text-xs text-amber-600 dark:text-amber-500">{note}</p> : null}

      {expanded ? (
        <div id={detailsId}>
          <TaskDetail rootRunId={task.rootRunId} summary={task} />
        </div>
      ) : null}
    </li>
  )
}

function TaskDetail({ rootRunId, summary }: { rootRunId: string; summary: TaskSummary }) {
  const tasks = useTasks()
  const watched = useTaskView(rootRunId)
  // Until the first read of the task's view, the list row stands in.
  const task: TaskSummary & Partial<Pick<TaskView, "view" | "children" | "connection">> =
    watched ?? summary
  const [cancelling, setCancelling] = useState(false)
  const [skipping, setSkipping] = useState<ReadonlySet<string>>(new Set())
  const active = isActivePhase(task.phase)

  const cancel = async () => {
    setCancelling(true)
    try {
      await tasks.cancel(rootRunId)
      toast.success("Task cancelled. Its sub-agents were stopped too.")
    } catch (err) {
      toast.error(`Couldn't cancel the task: ${(err as Error).message}`)
    } finally {
      setCancelling(false)
    }
  }

  const skip = async (childRunId: string, name: string) => {
    setSkipping((s) => new Set(s).add(childRunId))
    try {
      await tasks.skipChild(childRunId)
      toast.success(`Skipped sub-agent ${name}. The task carries on without it.`)
    } catch (err) {
      toast.error(`Couldn't skip the sub-agent: ${(err as Error).message}`)
    } finally {
      setSkipping((s) => {
        const next = new Set(s)
        next.delete(childRunId)
        return next
      })
    }
  }

  const children = task.children ?? []
  const own = task.questions.filter((q) => q.answeredBy === "resume")
  const childQuestions = mergeChildQuestions(task.questions, children)
  const view = task.view
  const idle = task.phase === "needs_answer" || task.phase === "answer_sent" || task.childrenAsking > 0

  return (
    <div className="space-y-2">
      {active ? (
        <div className="flex justify-end">
          <Button
            size="xs"
            variant="ghost"
            aria-label="Cancel task"
            title="Cancel the task and its sub-agents"
            disabled={cancelling || task.phase === "launching"}
            onClick={() => void cancel()}
          >
            <X />
            Cancel
          </Button>
        </div>
      ) : null}

      {task.connection === "reconnecting" ? (
        <p className="text-[11px] text-[var(--muted-foreground)]">Reconnecting…</p>
      ) : null}

      {task.lastAttemptError && own.length > 0 ? (
        <p className="break-words text-xs text-[var(--muted-foreground)]">
          The last answer couldn&apos;t be applied ({task.lastAttemptError.message}). Answer again.
        </p>
      ) : null}

      {own.map((q) => (
        <TaskQuestionCard key={`${q.runId}:${q.interrupt.id}`} question={q} />
      ))}

      {childQuestions.map((q) => {
        const name = q.subagent?.name ?? "Sub-agent"
        return (
          <div
            key={`${q.runId}:${q.interrupt.id}`}
            role="group"
            aria-label={`Question from sub-agent ${name}`}
            className="min-w-0 space-y-1"
          >
            <p className="break-words text-xs text-[var(--muted-foreground)]">
              <span className="font-medium text-[var(--foreground)]">{name}</span> asks
              {q.subagent?.subgoal ? ` · ${q.subagent.subgoal}` : ""}
            </p>
            <TaskQuestionCard question={q} />
          </div>
        )
      })}

      {task.phase === "needs_answer" && own.length === 0 && childQuestions.length === 0 ? (
        <p className="text-xs text-[var(--muted-foreground)]">Loading the question…</p>
      ) : null}

      {view ? (
        <TaskRunBody
          view={view}
          idle={idle}
          hasSubagents={children.length > 0}
          subagents={
            children.length > 0 ? (
              <SubagentRows
                rows={children.map((c) => ({
                  id: c.runId,
                  agent: c.name ?? "Sub-agent",
                  subgoal: c.subgoal ?? "",
                  label: childPill(c),
                  canSkip: active && childCanSkip(c),
                  skipping: skipping.has(c.runId),
                }))}
                onSkip={(id) => {
                  const child = children.find((c) => c.runId === id)
                  void skip(id, child?.name ?? "")
                }}
              />
            ) : null
          }
        />
      ) : (
        <p className="text-xs text-[var(--muted-foreground)]">Loading the task…</p>
      )}

      <TaskActions task={task} />
    </div>
  )
}

/** A sub-agent's open questions: those the parent's view knows, plus any
 *  the list already had. One per (run, interrupt). */
function mergeChildQuestions(
  questions: readonly TaskQuestion[],
  children: TaskView["children"],
): TaskQuestion[] {
  const out = new Map<string, TaskQuestion>()
  for (const q of questions) if (q.answeredBy === "in_place") out.set(`${q.runId}:${q.interrupt.id}`, q)
  for (const c of children) {
    if (!c.question) continue
    const key = `${c.question.runId}:${c.question.interrupt.id}`
    const known = out.get(key)
    out.set(key, {
      ...c.question,
      subagent: c.question.subagent ?? known?.subagent ?? { name: c.name, subgoal: c.subgoal },
      answerPending: c.question.answerPending || !!known?.answerPending,
    })
  }
  return [...out.values()]
}

function TaskActions({ task }: { task: TaskSummary }) {
  const conversationKnown = useStore((s) => s.conversations.some((c) => c.id === task.conversationId))
  const reportDocument = useStore((s) =>
    s.documents.some((d) => d.id === task.resultIds.documentId),
  )
  const text = task.result?.text?.trim() ?? ""
  const showReport = task.research && task.phase === "succeeded" && (reportDocument || !!text)

  const openConversation = () => {
    const state = useStore.getState()
    state.setActiveConversation(task.conversationId)
    state.setActiveView("chat")
  }
  const openReport = () => {
    const state = useStore.getState()
    if (reportDocument) {
      state.setActiveDocument(task.resultIds.documentId)
    } else {
      if (!state.activeWorkspaceId) {
        toast.error("Select a workspace first")
        return
      }
      state.appendToActiveDocumentOrCreate(text)
    }
    state.setActiveView("editor")
    toast.success("Report opened in the editor")
  }

  if (!conversationKnown && !showReport) return null
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 pt-0.5")}>
      {conversationKnown ? (
        <Button size="xs" variant="ghost" onClick={openConversation}>
          <MessageSquare />
          Open conversation
        </Button>
      ) : null}
      {showReport ? (
        <Button size="xs" variant="ghost" onClick={openReport}>
          <FileText />
          Open report in editor
        </Button>
      ) : null}
    </div>
  )
}
