"use client"
import "client-only"

/**
 * Per-card task-runner glue for project-mode (`PLAN-project-mode.md`
 * Phase 4). One hook per card on the Kanban board: `launch()` kicks off
 * a long-running agent task with the workspace's prompt + skills using
 * the card title as the goal, then auto-moves the card between columns
 * as the run state changes.
 *
 * Live status comes via the same backfill + Realtime path the Tasks
 * panel uses: we replay the persisted log on mount (so we discover
 * runs that already settled while the board was unmounted) and then
 * subscribe to live `task_events` for anything new. The reduceRun
 * fold is idempotent by seq, so a duplicate delivery on the two
 * channels is a no-op on the second copy.
 *
 * Multiple cards can run concurrently — each instance has its own
 * subscription. The shared `TaskRunProvider` mounted at the dashboard
 * root tracks only the *single* run launched from the chat panel; this
 * hook lives outside it.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { apiClient } from "@/client/api-client"
import { useStore } from "@/client/hooks/use-store"
import { subscribeTaskEvents } from "@/client/agent/realtime"
import { isTerminalStatus } from "@/shared/agent/events"
import {
  EMPTY_RUN_VIEW,
  reduceRun,
  type TaskRunView,
} from "@/shared/agent/project"
import { decodeTaskEventStream } from "@/shared/agent/stream"
import { SKILLS } from "@/shared/skills/registry"
import { resolveSkill } from "@/shared/skills/types"
import type { ProjectTask, ProjectTaskStatus, Workspace } from "@/shared/types"

export interface UseProjectTaskRunResult {
  /** Live view of the underlying run, or `EMPTY_RUN_VIEW` until the
   *  first event lands. */
  view: TaskRunView
  /** True between launch and the first persisted event arriving. */
  starting: boolean
  /** Transport-level error (network / HTTP). */
  error: string | null
  /** Kick off the long-running task. No-op if the card already has a
   *  `taskId` or no workspace is active. */
  launch: () => Promise<void>
}

/**
 * Project-mode card runner. Returns a `view` reflecting the current
 * task's progress (when one is attached) plus a `launch()` to start one.
 *
 * Auto-transitions the card across columns on terminal status:
 *  - `done` → `done`
 *  - `cancelled` → `cancelled`
 *  - `failed` → `todo` (so the user can edit / retry)
 */
export function useProjectTaskRun(
  card: ProjectTask,
  workspace: Workspace | undefined
): UseProjectTaskRunResult {
  const updateProjectTask = useStore((s) => s.updateProjectTask)
  const createConversation = useStore((s) => s.createConversation)
  const renameConversation = useStore((s) => s.renameConversation)
  const addMessage = useStore((s) => s.addMessage)

  const [view, setView] = useState<TaskRunView>(EMPTY_RUN_VIEW)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Ref so the watcher can read the latest card status without needing
  // to re-tear-down whenever React re-renders for other reasons.
  const cardRef = useRef(card)
  cardRef.current = card

  // Watch the attached run when this card is `in_progress` with a
  // `taskId`. Backfill from cursor 0 first (catches runs that settled
  // while the board was unmounted), then live-tail via Realtime.
  useEffect(() => {
    if (!card.taskId || card.status !== "in_progress") return

    const runId = card.taskId
    const ac = new AbortController()
    let unsubscribeRealtime: (() => void) | null = null
    let cancelled = false
    let currentView: TaskRunView = EMPTY_RUN_VIEW

    const handleTerminal = (status: TaskRunView["status"]) => {
      const nextStatus = mapTerminalToColumn(status)
      if (cardRef.current.status !== nextStatus) {
        updateProjectTask(cardRef.current.id, { status: nextStatus })
      }
    }

    const apply = (next: TaskRunView) => {
      currentView = next
      if (!cancelled) setView(next)
      if (isTerminalStatus(next.status)) {
        handleTerminal(next.status)
      }
    }

    void (async () => {
      // 1) Replay persisted events so we know the run's current state.
      try {
        const res = await apiClient.tasks.resume(runId, {
          cursor: 0,
          signal: ac.signal,
        })
        if (res.ok && res.body) {
          for await (const event of decodeTaskEventStream(res.body)) {
            if (cancelled) return
            apply(reduceRun(currentView, event))
          }
        }
      } catch (err) {
        if (!cancelled && !ac.signal.aborted) {
          setError(err instanceof Error ? err.message : "Replay failed.")
        }
      }
      if (cancelled || isTerminalStatus(currentView.status)) return

      // 2) Live-tail via Realtime for anything that arrives after the
      // replay's cursor. The poll-tail isn't needed here because the
      // card view doesn't need to recover quickly from a Realtime
      // hiccup; the next board mount re-replays.
      unsubscribeRealtime = subscribeTaskEvents(runId, {
        onEvent: (event) => apply(reduceRun(currentView, event)),
      })
    })()

    return () => {
      cancelled = true
      ac.abort()
      unsubscribeRealtime?.()
    }
  }, [card.taskId, card.status, updateProjectTask])

  const launch = useCallback(async () => {
    if (card.taskId) return // already attached
    if (!workspace) return
    setStarting(true)
    setError(null)
    try {
      // Run lives in its own conversation so the goal + result + tool
      // calls don't pollute whatever chat the user happens to have
      // open. Renamed to make it findable from the chat sidebar; the
      // goal lands as the first user message so opening the convo
      // post-settle shows the prompt that drove the run.
      const conv = createConversation(workspace.id)
      renameConversation(conv.id, `Task: ${card.title}`)
      addMessage({ role: "user", content: card.title }, conv.id)

      // Workspace-level skill cascade. Conversation prefs are
      // intentionally absent — the new conversation is fresh.
      const enabledSkills = SKILLS.filter((s) =>
        resolveSkill(s, workspace.skillPrefs, undefined)
      ).map((s) => ({ id: s.id }))

      const res = await apiClient.tasks.start({
        messages: [{ role: "user", content: card.title }],
        conversationId: conv.id,
        model: workspace.defaultModel,
        workspaceSystemPrompt: workspace.systemPrompt,
        workspaceId: workspace.id,
        skills: enabledSkills,
      })
      if (!res.ok || !res.runId) {
        setError(res.error?.message ?? `Failed to start task (HTTP ${res.status}).`)
        return
      }
      updateProjectTask(card.id, {
        taskId: res.runId,
        status: "in_progress",
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start task.")
    } finally {
      setStarting(false)
    }
  }, [
    card.id,
    card.taskId,
    card.title,
    workspace,
    addMessage,
    createConversation,
    renameConversation,
    updateProjectTask,
  ])

  return { view, starting, error, launch }
}

/** Map an agent run's terminal status to the matching board column.
 *  `failed` goes back to `todo` so the user can edit + retry; the
 *  failure detail lives in the task's `view.fatalError`. */
function mapTerminalToColumn(
  status: TaskRunView["status"]
): ProjectTaskStatus {
  if (status === "done") return "done"
  if (status === "cancelled") return "cancelled"
  return "todo"
}
