"use client"
import "client-only"

/**
 * Answers sent to `/api/tasks/:id/respond`, per question. Shared, so the
 * parent's card and the child's window agree, and a card that remounts
 * (the panel closes, the view changes) doesn't offer an answered question
 * again. Not persisted: after a reload the server decides (409).
 */

import { create } from "zustand"

import { apiClient } from "@/client/api-client"
import type { RespondRequestInput } from "@/shared/api-schemas"

export type AnswerState =
  | { phase: "sending" }
  /** Accepted, or answered elsewhere: no card until the task moves on. */
  | { phase: "sent" | "elsewhere"; at: number }
  | { phase: "failed"; message: string }

interface AnswersStore {
  byQuestion: Record<string, AnswerState>
}

const useAnswers = create<AnswersStore>(() => ({ byQuestion: {} }))

const questionKey = (runId: string, requestId: string) => `${runId}:${requestId}`

export function useTaskAnswer(runId: string, requestId: string): AnswerState | undefined {
  return useAnswers((s) => s.byQuestion[questionKey(runId, requestId)])
}

/**
 * Send one answer. `onStale` runs when the question turned out to be
 * closed (409, or the task is gone), so the caller re-reads the task.
 */
export async function sendTaskAnswer(
  runId: string,
  body: RespondRequestInput,
  onStale?: () => void
): Promise<void> {
  const key = questionKey(runId, body.requestId)
  const put = (state: AnswerState) =>
    useAnswers.setState((s) => ({ byQuestion: { ...s.byQuestion, [key]: state } }))
  // One request per question at a time: a double click, or both cards.
  if (useAnswers.getState().byQuestion[key]?.phase === "sending") return
  put({ phase: "sending" })
  try {
    const res = await apiClient.tasks.respond(runId, body)
    if (res.ok) return put({ phase: "sent", at: Date.now() })
    // `limit_reached` is also a 409, but nothing was answered.
    const closed = res.status === 409 && res.error?.code !== "limit_reached"
    if (closed || res.status === 404) {
      put({ phase: "elsewhere", at: Date.now() })
      onStale?.()
      return
    }
    put({ phase: "failed", message: res.error?.message ?? `HTTP ${res.status}.` })
  } catch {
    put({ phase: "failed", message: "Couldn't reach the server." })
  }
}
