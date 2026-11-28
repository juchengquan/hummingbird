import "client-only"

/**
 * After a reload, rebuild the interrupted turns (Q35/Q36): the answer
 * cards' state (`useInterruptedTurns`) is ephemeral, but the active-run
 * pointer (`status: "interrupted"`) survives in localStorage. For each
 * such pointer whose message still exists, the run's `openInterrupts`
 * (`GET /v1/runs/{id}`) become the turn again; a run the backend forgot
 * (404) or that isn't interrupted any more loses its pointer and shows no
 * card. `running` pointers are wave 4b-A's (rejoin).
 *
 * Dependencies are injected, so this is testable without a store or a
 * network; `useRestoreInterruptedTurns` wires the real ones.
 */

import type { ActiveRunRecord } from "./active-run"
import type { InterruptedTurn } from "./chat-bridge"
import { isRunsError } from "./errors"
import { pendingInterrupts } from "./interrupts"
import type { Run, RunsTarget } from "./types"

export interface RestoreDeps {
  target: RunsTarget
  records: readonly ActiveRunRecord[]
  messageExists(conversationId: string, messageId: string): boolean
  /** The conversation already shows a turn (live, or restored) — never
   *  replaced by an older view of it. */
  hasTurn(conversationId: string): boolean
  getRun(runId: string): Promise<Run>
  setTurn(turn: InterruptedTurn): void
  clearPointer(conversationId: string, runId: string): void
}

export type RestoreOutcome =
  | { runId: string; result: "restored" }
  /** Pointer dropped: the backend forgot the run, or it moved on. */
  | { runId: string; result: "cleared" }
  /** Left as is: the message is gone (sync may bring it back), the turn
   *  is already shown, a transient error, or a run owned by the other
   *  identity (signed in ↔ out since it started). */
  | { runId: string; result: "skipped"; reason: string }

export async function restoreInterruptedTurns(deps: RestoreDeps): Promise<RestoreOutcome[]> {
  const candidates = deps.records.filter((r) => r.status === "interrupted")
  return Promise.all(candidates.map((record) => restoreOne(deps, record)))
}

async function restoreOne(deps: RestoreDeps, record: ActiveRunRecord): Promise<RestoreOutcome> {
  const { runId, conversationId, messageId } = record
  if (!deps.messageExists(conversationId, messageId)) {
    return { runId, result: "skipped", reason: "message-missing" }
  }
  if (deps.hasTurn(conversationId)) return { runId, result: "skipped", reason: "shown" }
  // An anonymous run is addressed by its run token, a signed-in one by the
  // session: asked as the other identity it would 404 without being gone.
  const anonymousNow = !deps.target.authToken
  if (record.anonymous !== anonymousNow) {
    return { runId, result: "skipped", reason: "identity-changed" }
  }
  let run: Run
  try {
    run = await deps.getRun(runId)
  } catch (err) {
    if (isRunsError(err) && err.kind === "http" && err.status === 404) {
      deps.clearPointer(conversationId, runId)
      return { runId, result: "cleared" }
    }
    return { runId, result: "skipped", reason: isRunsError(err) ? err.code : "error" }
  }
  const interrupts = pendingInterrupts(run)
  if (interrupts.length === 0) {
    deps.clearPointer(conversationId, runId)
    return { runId, result: "cleared" }
  }
  // A live turn may have appeared while the status request was in flight.
  if (deps.hasTurn(conversationId)) return { runId, result: "skipped", reason: "shown" }
  deps.setTurn({
    conversationId,
    messageId,
    runId,
    threadId: record.threadId,
    interrupts,
    anonymous: record.anonymous,
    ...(record.model ? { model: record.model } : {}),
    ...(record.allowedMcpServerIds ? { allowedMcpServerIds: record.allowedMcpServerIds } : {}),
  })
  return { runId, result: "restored" }
}
