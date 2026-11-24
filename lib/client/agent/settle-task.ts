"use client"
import "client-only"

/**
 * What a task's end does in this browser: the result message, a research
 * report's document + artifact + toast, the board card, the notification.
 *
 * Exactly once per run, however often it is replayed (a reload replays
 * the log from 0) and however many tabs watch it: the effects run under a
 * Web Lock, behind a "delivered" mark in localStorage. The resume pointer
 * is cleared only afterwards, so a reload in between delivers on replay.
 */

import { toast } from "sonner"

import { clearActiveTask } from "@/client/agent/active-task"
import { notifyTaskFinished } from "@/client/agent/notify"
import { useStore } from "@/client/hooks/use-store"
import { formatResearchCitations } from "@/shared/agent/citation-formatter"
import { resultIdsFor } from "@/shared/runs/ids"
import type { TaskRunView } from "@/shared/agent/project"
import { deriveResearchReportTitle } from "@/shared/agent/research-report"

export interface TaskMeta {
  conversationId: string
  title?: string
  mode: "default" | "research"
  /** The signed-in user who launched or resumed it: the result is written
   *  under ids derived from the user and the run (`resultIdsFor`, Q70), so
   *  the runs list delivering the same task in this or another browser is
   *  a no-op. Null without accounts (Supabase unconfigured): the ids are
   *  then derived from the run alone. */
  userId: string | null
}

const DELIVERED_KEY = "humm.settledTasks"
const DELIVERED_MAX = 100
/** How long the lock outlives the effects, so the next tab to take it sees
 *  the mark (localStorage reaches other tabs' processes asynchronously). */
const MARK_PROPAGATION_MS = 500

const lockName = (runId: string) => `humm.taskResult.${runId}`

function readDelivered(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DELIVERED_KEY) ?? "[]")
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

function markDelivered(runId: string, delivered: string[]): void {
  try {
    localStorage.setItem(
      DELIVERED_KEY,
      JSON.stringify([...delivered, runId].slice(-DELIVERED_MAX))
    )
  } catch {
    // Private mode / quota — a later replay may then deliver again.
  }
}

export async function settleTask(runId: string, view: TaskRunView, meta: TaskMeta): Promise<void> {
  const deliverOnce = () => {
    const delivered = readDelivered()
    const first = !delivered.includes(runId)
    if (first) {
      markDelivered(runId, delivered)
      deliver(runId, view, meta)
    }
    clearActiveTask(runId, meta.userId)
    return first
  }
  // Web Locks need a secure context; without them the mark alone guards.
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks
  if (!locks) {
    deliverOnce()
    return
  }
  await locks.request(lockName(runId), async () => {
    if (deliverOnce()) await new Promise((resolve) => setTimeout(resolve, MARK_PROPAGATION_MS))
  })
}

function deliver(runId: string, view: TaskRunView, meta: TaskMeta): void {
  const store = useStore.getState()
  const { conversationId, title, mode } = meta
  const rawText = (view.resultText ?? view.text).trim()
  const ids = resultIdsFor(meta.userId ?? "local", runId)

  notifyTaskFinished(view, { title, runId })

  // Never into a deleted conversation (survey bug 21), and a report into
  // the conversation's own workspace, never the active one (bug 2).
  const conversation = store.conversations.find((c) => c.id === conversationId)
  let text = rawText
  if (view.status === "done" && rawText && conversation) {
    // Research reports go through the citation formatter
    // (`PLAN-deep-research.md` §Phase 4): inline `[N]` markers remapped to
    // first-appearance order, `## Sources` deduped.
    const research = mode === "research"
    text = research ? formatResearchCitations(rawText) : rawText
    // Citation-verification verdicts, for `MessageVerification`
    // (`docs/PLAN-citation-verifiability.md`).
    const verification = view.verification ?? undefined
    const message = store.addMessageWithId(
      ids.messageId,
      { role: "assistant", content: text, ...(verification ? { verification } : {}) },
      conversationId
    )
    const workspaceId = conversation.workspaceId
    if (message && research && workspaceId) {
      const reportTitle = deriveResearchReportTitle(text, conversationId)
      // A document per report, so a workspace accumulates a library of
      // reports rather than one mixed document.
      store.createDocumentWithId(ids.documentId, workspaceId, reportTitle, text)
      store.createArtifactWithId(ids.artifactId, {
        conversationId,
        messageId: message.id,
        kind: "markdown",
        title: reportTitle,
        content: text,
      })
      if (store.activeWorkspaceId === workspaceId) {
        store.setActiveDocument(ids.documentId)
        toast.success("Report opened in the editor")
      }
    }
  }

  const card = store.projectTasks.find((task) => task.taskId === runId)
  if (!card) return
  if (view.status === "done") {
    if (!card.artifactId && rawText && conversation) {
      const artifact = store.createArtifactWithId(ids.artifactId, {
        conversationId,
        kind: "markdown",
        title: card.title,
        content: text,
      })
      store.updateProjectTask(card.id, { artifactId: artifact.id })
    }
    store.moveProjectTask(card.id, "done", 0)
  } else {
    store.moveProjectTask(card.id, "todo", 0)
    if (view.status === "failed") toast.error("Task failed — card moved back to To-do.")
  }
}
