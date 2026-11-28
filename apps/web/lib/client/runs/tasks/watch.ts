import "client-only"

/**
 * Following one task (the expanded one; only watched tasks are streamed,
 * Q69): read its chain (`listRuns?rootRunId=<root>&topLevel=true`), fold
 * each run's stream on the line from the root to the current run, oldest
 * first, then follow the current run live; read its sub-agent runs
 * (`listRuns?parentRunId=<current run>`) on every list tick.
 *
 * A run's stream closes when it ends or pauses on a question. The watch
 * then waits for the list to name another current run (an answer from
 * here, another tab or browser — after a `409 run_already_resumed` too)
 * and folds that one's stream on top. Dropped connections are resumed by
 * the transport from the run's cursor (with a fresh token, bug 19); a
 * failed open is retried with a back-off, a `404` or `401` ends the watch.
 */

import { RunsError } from "../errors"
import type { RunStream } from "../transport"
import type { Run, RunCursor } from "../types"
import { ChainFold } from "./chain"

export interface WatchApi {
  /** The task's top-level runs (root, answers, dead branches). */
  chain(rootRunId: string, signal: AbortSignal): Promise<Run[]>
  /** A run's stream from a cursor. */
  stream(runId: string, after: RunCursor, signal: AbortSignal): Promise<RunStream>
}

const RETRY_MS = 1_000
const RETRY_MAX_MS = 15_000

/** The line from the root to `current`, oldest first: walk `previousRunId`
 *  back from the current run (a dead branch is never on it). */
export function chainLine(runs: readonly Run[], currentRunId: string): string[] {
  const byId = new Map(runs.map((r) => [r.id, r]))
  const line: string[] = []
  const seen = new Set<string>()
  let run = byId.get(currentRunId)
  if (!run) return [currentRunId]
  while (run && !seen.has(run.id)) {
    seen.add(run.id)
    line.unshift(run.id)
    run = run.previousRunId ? byId.get(run.previousRunId) : undefined
  }
  return line
}

/** The task's top-level runs, oldest first. */
export function chainRunIds(runs: readonly Run[]): string[] {
  return [...runs]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1))
    .map((r) => r.id)
}

export type Connection = "live" | "reconnecting" | "closed"

export class TaskWatch {
  readonly rootRunId: string
  readonly fold = new ChainFold()
  connection: Connection = "reconnecting"
  /** Every top-level run of the task, oldest first. */
  runIds: string[] = []
  /** The task's current run as the list last named it. */
  private currentRunId: string
  private controller: AbortController | null = null
  private wake: (() => void) | null = null
  private listKey = ""

  constructor(
    rootRunId: string,
    currentRunId: string,
    private readonly api: WatchApi,
    private readonly onChange: () => void,
  ) {
    this.rootRunId = rootRunId
    this.currentRunId = currentRunId
  }

  get running(): boolean {
    return this.controller !== null
  }

  /** The list's view of the task: its current run and that run's status.
   *  A change wakes a watch waiting on a closed stream. */
  setCurrent(currentRunId: string, status: string): void {
    const key = `${currentRunId}:${status}`
    if (key === this.listKey) return
    this.listKey = key
    this.currentRunId = currentRunId
    this.poke()
  }

  /** Wake a watch waiting for the list (a new current run, or a refresh). */
  poke(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }

  start(): void {
    if (this.controller) return
    const controller = new AbortController()
    this.controller = controller
    void this.loop(controller.signal).finally(() => {
      if (this.controller === controller) this.controller = null
    })
  }

  stop(): void {
    this.controller?.abort()
    this.controller = null
    this.poke()
  }

  private setConnection(next: Connection): void {
    if (this.connection === next) return
    this.connection = next
    this.onChange()
  }

  private waitForPoke(signal: AbortSignal, ms?: number): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve()
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        if (timer) clearTimeout(timer)
        signal.removeEventListener("abort", done)
        if (this.wake === done) this.wake = null
        resolve()
      }
      this.wake = done
      if (ms !== undefined) timer = setTimeout(done, ms)
      signal.addEventListener("abort", done, { once: true })
    })
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let failures = 0
    while (!signal.aborted) {
      try {
        const runs = await this.api.chain(this.rootRunId, signal)
        if (signal.aborted) return
        const current = runs.find((r) => r.id === this.currentRunId)
          ? this.currentRunId
          : (runs.find((r) => r.currentRunId === null)?.id ?? this.currentRunId)
        this.runIds = chainRunIds(runs)
        const line = chainLine(runs, current)
        if (this.fold.setLine(line)) this.onChange()
        for (const runId of line) {
          if (signal.aborted) return
          if (this.fold.isClosed(runId)) continue
          this.setConnection("live")
          const stream = await this.api.stream(runId, this.fold.cursorOf(runId), signal)
          for await (const item of stream) {
            if (signal.aborted) return
            if (this.fold.push(runId, item)) this.onChange()
          }
        }
        failures = 0
        // Closed (ended, or paused on a question): wait for the list to
        // name another current run, or another status.
        this.setConnection("closed")
        await this.waitForPoke(signal)
      } catch (err) {
        if (signal.aborted) return
        if (err instanceof RunsError && (err.status === 404 || err.status === 401)) {
          this.setConnection("closed")
          await this.waitForPoke(signal)
          continue
        }
        failures += 1
        this.setConnection("reconnecting")
        await this.waitForPoke(signal, Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS))
      }
    }
  }
}
