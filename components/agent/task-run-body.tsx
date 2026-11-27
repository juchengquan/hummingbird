"use client"

/**
 * The parts of a task's view in the runs task list (`TaskCard`,
 * `/v1/runs`): the status icon, the plan, the sub-agent rows, the tool
 * pills, the step error, the reasoning and the text. Presentational
 * only: the caller feeds them.
 */

import type { ReactNode } from "react"
import { Ban, CheckCircle2, Circle, CircleDot, Loader2, Pause, XCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { MarkdownPreview } from "@/components/markdown-preview"
import { ToolCallStrip, type LiveToolCall } from "@/components/skills/tool-call-strip"
import type { PlanItem, RunStatus } from "@/shared/agent/events"
import type { TaskRunView } from "@/shared/agent/project"
import { cn } from "@/shared/utils"

/** One sub-agent row: its pill, name and subgoal, and Skip while it runs. */
export interface SubagentRowData {
  id: string
  agent: string
  subgoal: string
  /** The pill: `queued`, `running`, `skipped`, … */
  label: string
  canSkip: boolean
  skipping: boolean
}

export function SubagentRows({
  rows,
  stale,
  onOpen,
  onSkip,
}: {
  rows: SubagentRowData[]
  /** The last read of their statuses failed. */
  stale?: boolean
  onOpen?: (id: string) => void
  onSkip?: (id: string) => void
}) {
  return (
    <ul className="space-y-0.5 text-xs">
      <li className="flex items-center gap-1.5 text-[var(--muted-foreground)] font-medium">
        Spawned {rows.length} subagent{rows.length === 1 ? "" : "s"}
      </li>
      {stale ? (
        <li className="text-[var(--destructive)]">
          Couldn&apos;t refresh the sub-agents. Retrying…
        </li>
      ) : null}
      {rows.map((c) => (
        <li key={c.id} className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={onOpen ? () => onOpen(c.id) : undefined}
            disabled={!onOpen}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-[var(--muted)] disabled:hover:bg-transparent"
          >
            <span className="shrink-0 rounded-sm bg-[var(--muted)] px-1 py-0.5 text-[10px] leading-none text-[var(--muted-foreground)]">
              {c.label}
            </span>{" "}
            <span className="min-w-0 truncate font-medium">{c.agent}</span>{" "}
            <span className="min-w-0 truncate text-[var(--muted-foreground)]">{c.subgoal}</span>
          </button>
          {c.canSkip && onSkip ? (
            <Button
              size="xs"
              variant="ghost"
              className="shrink-0"
              disabled={c.skipping}
              aria-label={`Skip sub-agent ${c.agent}${c.subgoal ? `: ${c.subgoal}` : ""}`}
              title="Skip this sub-agent; the task carries on"
              onClick={() => onSkip(c.id)}
            >
              Skip
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * Plan, sub-agents (`subagents`, the caller's rows), tool pills, the last
 * step error, reasoning and text — in that order, as the old strip had them.
 * `idle`: the task waits (on the user or its sub-agents), so only finished
 * calls show; a spawn shows as the sub-agent list.
 */
export function TaskRunBody({
  view,
  idle,
  hasSubagents,
  subagents,
}: {
  view: TaskRunView
  idle: boolean
  hasSubagents: boolean
  subagents?: ReactNode
}) {
  const calls: LiveToolCall[] = view.toolCalls
    .filter(
      (c) =>
        c.status === "done" || (!idle && !(c.toolName === "spawnSubagent" && hasSubagents)),
    )
    .map((c) => ({
      id: c.toolCallId,
      name: c.toolName,
      argsLabel: argLabel(c.args),
      status: c.status,
      summary: c.summary,
      results: c.results,
    }))
  return (
    <>
      {view.plan.length > 0 ? <PlanList items={view.plan} /> : null}

      {subagents}

      {calls.length > 0 ? <ToolCallStrip calls={calls} className="[&>span]:max-w-full" /> : null}

      {view.lastStepError ? (
        <p className="text-[11px] text-[var(--muted-foreground)]">
          Retried after error: {view.lastStepError}
        </p>
      ) : null}

      {view.reasoning ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--muted-foreground)]">Reasoning</summary>
          <MarkdownPreview content={view.reasoning} className="!p-0 text-[var(--muted-foreground)]" />
        </details>
      ) : null}

      {view.text ? <MarkdownPreview content={view.text} className="!p-0" /> : null}
    </>
  )
}

export function PlanList({ items }: { items: PlanItem[] }) {
  return (
    <ul className="space-y-0.5 text-xs">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-1.5">
          <PlanIcon status={item.status} />
          <span
            className={cn(
              item.status === "completed" && "line-through text-[var(--muted-foreground)]",
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
  if (status === "completed") return <CheckCircle2 size={12} className="text-[var(--primary)]" />
  if (status === "in_progress") return <CircleDot size={12} className="text-[var(--primary)]" />
  return <Circle size={12} className="text-[var(--muted-foreground)]" />
}

export function StatusIcon({ status }: { status: RunStatus }) {
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

/** Best-effort short label from a tool's input — the query string most
 *  search-style tools carry. Falls back to undefined (generic pill). */
function argLabel(args: unknown): string | undefined {
  if (args && typeof args === "object") {
    const q = (args as { query?: unknown }).query
    if (typeof q === "string" && q.trim()) return q.slice(0, 80)
  }
  return undefined
}
