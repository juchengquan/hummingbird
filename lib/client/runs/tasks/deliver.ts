import "client-only"

/**
 * Delivering a finished task (Q70, Q77): whichever browser lists it first
 * writes its result into its conversation — the message, and for a
 * research task the report document and its artifact — under ids derived
 * from the task (`resultIdsFor`), waits for sync to push them, then marks
 * the task delivered on the server (`markRunDelivered`).
 *
 * Once, everywhere:
 * - **Across tabs** of one browser: the write runs under a Web Lock per
 *   task, behind this browser's `delivered` mark (`humm.tasks.<userId>`).
 * - **Across browsers**: the ids are the same everywhere, so a second
 *   browser's write is an upsert of rows that already exist (sync merges
 *   by id); the server mark stops a third from trying, and the list's
 *   `delivered` stops anyone once it is seen.
 * - A message with the derived id already in the store (pulled from
 *   another browser) is never written again; nor is an identical
 *   assistant message already in the conversation (a task the old
 *   `/api/tasks` path delivered under a random id, before 0047 marked
 *   anything).
 *
 * Where: the task's own conversation (`Run.threadId`) — pulled from the
 * cloud first when this browser doesn't hold it (a scheduled task's is
 * created on the server, Q73) — and its report into that conversation's
 * workspace, never the active one (survey bug 2). A conversation that is
 * gone after the pull gets nothing (bug 21); the task is still marked.
 * Failed and cancelled tasks write no message (Q77): only the board card
 * goes back to To-do. The board card (found by the task's root, or by the
 * launch's `projectTaskId`) is settled as on the old path: Done with the
 * result as its artifact (derived id), or back to To-do.
 */

import { formatResearchCitations } from "@/shared/agent/citation-formatter"
import { deriveResearchReportTitle } from "@/shared/agent/research-report"
import { withStepLimitNote } from "@/shared/agent/step-limit"
import type { GeneratedImage } from "@/shared/types"
import type { VerificationResult } from "@/shared/verify"
import { parseVerificationFrame } from "@/shared/verify"

import type { TaskPointers } from "./pointers"
import type { TaskSummary } from "./types"


/** A finished task's output beyond its result text. */
export interface TaskOutput {
  verification: VerificationResult | null
  images: GeneratedImage[]
}

export interface DeliveryConversation {
  id: string
  workspaceId: string
  messages: ReadonlyArray<{ id: string; role: string; content: string }>
}

/** The store, as delivery uses it (`useStore` in the app; a model in tests). */
export interface DeliveryStore {
  getConversation(id: string): DeliveryConversation | null
  activeWorkspaceId(): string | null
  /** Idempotent on `id`; `false` when the conversation isn't there. */
  addMessageWithId(
    id: string,
    message: {
      role: "assistant"
      content: string
      verification?: VerificationResult
      generatedImages?: GeneratedImage[]
    },
    conversationId: string,
  ): boolean
  createDocumentWithId(id: string, workspaceId: string, title: string, content: string): void
  createArtifactWithId(
    id: string,
    input: { conversationId: string; messageId: string | null; kind: "markdown"; title: string; content: string },
  ): void
  setActiveDocument(id: string): void
  /** The board card the task was launched from (`ProjectTask.taskId`). */
  findCard(rootRunId: string): { id: string; title: string; artifactId?: string } | null
  /** A board card by its id (the launch's `projectTaskId`, before the
   *  card carries the task's id). */
  getCard(cardId: string): { id: string; title: string; artifactId?: string } | null
  setCardArtifact(cardId: string, artifactId: string): void
  moveCard(cardId: string, status: "todo" | "done"): void
}

/** `navigator.locks`, as used here. */
export interface LockLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

export type PullResult = "ok" | "failed" | "deferred" | "cancelled" | "unavailable"

export interface DeliveryDeps {
  userId: string
  store: DeliveryStore
  pointers: TaskPointers
  /** Web Locks; absent (insecure context, tests) → the mark alone guards. */
  locks?: LockLike | null
  /** Pull the user's cloud state (`use-reconcile`), for a conversation
   *  this browser doesn't hold yet. */
  pull(): Promise<PullResult>
  /** Resolves once the sync queue is empty (or gives up). */
  whenDrained(): Promise<void>
  /** `POST /v1/runs/{root}/delivered`. */
  markDelivered(rootRunId: string): Promise<void>
  /** What a list row doesn't carry: the images the task generated (a
   *  0.5.1 result lists them, read from getRun — Q87; an older one, from
   *  its `hummingbird.tool_image` activities) and, for an older result,
   *  the citation checks (`hummingbird.verification`). */
  outputOf?(task: TaskSummary): Promise<TaskOutput>
  /** "Report opened in the editor". */
  onReportOpened?(): void
}

export type DeliveryOutcome =
  /** Written here, and marked. */
  | "delivered"
  /** Nothing to write here (another tab / browser wrote it, the
   *  conversation is gone, or the task ended without a result); marked. */
  | "marked"
  /** Already marked on the server: nothing done. */
  | "already"
  /** Not ended yet. */
  | "not_ended"
  /** Try again on a later read: the conversation couldn't be checked, or
   *  the mark didn't go through. */
  | "retry"

function lockName(userId: string, rootRunId: string): string {
  return `humm.tasks.deliver.${userId}.${rootRunId}`
}

/** The board card of a task: the one carrying its root's id (linked at
 *  launch), else the one its launch named (`projectTaskId`). */
function cardOf(task: TaskSummary, store: DeliveryStore) {
  return store.findCard(task.rootRunId) ?? (task.projectTaskId ? store.getCard(task.projectTaskId) : null)
}

/** The message text of a succeeded task (or null: nothing to write). */
export function resultTextOf(task: TaskSummary): string | null {
  const raw = typeof task.result?.text === "string" ? task.result.text.trim() : ""
  if (!raw) return null
  const text = task.research ? formatResearchCitations(raw) : raw
  return task.stoppedAt === "max_steps" ? withStepLimitNote(text, task.maxSteps) : text
}

async function outputFor(task: TaskSummary, deps: DeliveryDeps): Promise<TaskOutput> {
  const fromResult = parseVerificationFrame((task.result as { verification?: unknown } | null)?.verification)
  let streamed: TaskOutput = { verification: null, images: [] }
  if (deps.outputOf) {
    try {
      streamed = await deps.outputOf(task)
    } catch {
      // The text alone, rather than nothing.
    }
  }
  return { verification: fromResult ?? streamed.verification, images: streamed.images }
}

/**
 * Write a succeeded task's result into its conversation. Returns whether
 * anything was written, or `"retry"` when the conversation's absence
 * couldn't be confirmed.
 */
async function writeResult(task: TaskSummary, deps: DeliveryDeps): Promise<boolean | "retry"> {
  const { store } = deps
  const ids = task.resultIds
  const text = resultTextOf(task)
  let conv = store.getConversation(task.conversationId)
  if (!conv) {
    const pulled = await deps.pull()
    conv = store.getConversation(task.conversationId)
    if (!conv) return pulled === "ok" ? false : "retry"
  }
  const card = cardOf(task, store)
  let wrote = false
  if (text) {
    const legacy = conv.messages.some(
      (m) => m.id !== ids.messageId && m.role === "assistant" && m.content.trim() === text.trim(),
    )
    const exists = conv.messages.some((m) => m.id === ids.messageId)
    if (!legacy && !exists) {
      const { verification, images } = await outputFor(task, deps)
      wrote = store.addMessageWithId(
        ids.messageId,
        {
          role: "assistant",
          content: text,
          ...(verification ? { verification } : {}),
          ...(images.length > 0 ? { generatedImages: images } : {}),
        },
        conv.id,
      )
      if (wrote && task.research) {
        const title = deriveResearchReportTitle(text, conv.id)
        store.createDocumentWithId(ids.documentId, conv.workspaceId, title, text)
        store.createArtifactWithId(ids.artifactId, {
          conversationId: conv.id,
          messageId: ids.messageId,
          kind: "markdown",
          title,
          content: text,
        })
        // Open it only where the user is: the conversation's workspace.
        if (store.activeWorkspaceId() === conv.workspaceId) {
          store.setActiveDocument(ids.documentId)
          deps.onReportOpened?.()
        }
      }
    }
  }
  if (card) {
    if (text && !card.artifactId) {
      store.createArtifactWithId(ids.artifactId, {
        conversationId: conv.id,
        messageId: null,
        kind: "markdown",
        title: card.title,
        content: text,
      })
      store.setCardArtifact(card.id, ids.artifactId)
    }
    store.moveCard(card.id, "done")
  }
  return wrote
}

/**
 * Deliver one listed task, once (see the module doc). Safe to call on
 * every list read: an undelivered task is written at most once per
 * browser, and marked as soon as sync has pushed it.
 */
export async function deliverTask(task: TaskSummary, deps: DeliveryDeps): Promise<DeliveryOutcome> {
  if (task.delivered) {
    deps.pointers.forgetDelivered(task.rootRunId)
    return "already"
  }
  if (task.status !== "succeeded" && task.status !== "failed" && task.status !== "cancelled") return "not_ended"

  const writeOnce = async (): Promise<boolean | "retry"> => {
    if (deps.pointers.deliveredAt(task.rootRunId)) return false
    let wrote: boolean | "retry" = false
    if (task.status === "succeeded") {
      wrote = await writeResult(task, deps)
      if (wrote === "retry") return "retry"
    } else {
      const card = cardOf(task, deps.store)
      if (card) deps.store.moveCard(card.id, "todo")
    }
    deps.pointers.markDelivered(task.rootRunId)
    return wrote
  }

  const wrote = deps.locks
    ? await deps.locks.request(lockName(deps.userId, task.rootRunId), writeOnce)
    : await writeOnce()
  if (wrote === "retry") return "retry"

  // The rows must reach the cloud before the mark tells other browsers
  // not to write them.
  await deps.whenDrained()
  try {
    await deps.markDelivered(task.rootRunId)
  } catch {
    return "retry"
  }
  return wrote ? "delivered" : "marked"
}
