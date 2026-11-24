import "client-only"

/**
 * Test support for the tasks controller (tests only): a fake runs server
 * that serves the recorded background streams, a model of the store, a
 * shared Web Locks stand-in.
 */

import { RunsError } from "../errors"
import { memoryStorage } from "../fixtures"
import type { RunStream, RunStreamItem } from "../transport"
import type { ListRunsQuery, ResumeEntry, Run, RunCursor, StartRunRequest } from "../types"
import { compareCursors, START_CURSOR } from "@/shared/runs/cursor"

import type { TasksApi, TasksControllerDeps } from "./controller"
import { TasksController } from "./controller"
import type { DeliveryConversation, DeliveryStore, LockLike } from "./deliver"
import { TaskPointers, type PointerStorage } from "./pointers"

export const USER = "6f1c2c9e-1111-4222-8333-444455556666"

let clock = Date.parse("2026-11-23T10:00:00Z")
function nextTime(): string {
  clock += 1000
  return new Date(clock).toISOString()
}

export function makeRun(partial: Partial<Run> & { id: string }): Run {
  const at = nextTime()
  return {
    threadId: "4738a0ca-220f-43ff-b1c6-a75aa9265be1",
    mode: "background",
    status: "running",
    parentRunId: null,
    previousRunId: null,
    openInterrupts: [],
    result: null,
    error: null,
    lastSeq: 0,
    goal: "Paint it",
    maxSteps: 25,
    step: 0,
    createdAt: at,
    startedAt: at,
    finishedAt: null,
    updatedAt: at,
    rootRunId: partial.id,
    currentRunId: null,
    research: false,
    delivered: false,
    childrenAsking: 0,
    answerPending: false,
    ...partial,
  } as Run
}

function streamOf(runId: string, items: readonly RunStreamItem[], after: RunCursor): RunStream {
  const out = items.filter(
    (i) => i.cursor === null || after === START_CURSOR || compareCursors(i.cursor, after) > 0,
  )
  return {
    runId,
    runToken: null,
    cursor: after,
    close() {},
    async *[Symbol.asyncIterator]() {
      for (const item of out) yield item
    },
  }
}

/** The server side of `/v1/runs`, in memory. */
export class FakeRunsServer {
  runs = new Map<string, Run>()
  streams = new Map<string, RunStreamItem[]>()
  calls: Array<{ op: string; arg?: unknown }> = []
  /** Server-side delivered marks: root → first mark time. */
  marks = new Map<string, string>()
  /** The next start: created, then the response lost (`created`), or lost
   *  before it reached the server (`dropped`). */
  loseNextStart: "created" | "dropped" | null = null
  /** The next resume answers with this error. */
  nextResumeError: RunsError | null = null
  /** Called when a resume is accepted (to set up the new run). */
  onResume: ((request: { runId: string; previousRunId: string }) => void) | null = null

  add(run: Run, stream?: RunStreamItem[]): Run {
    this.runs.set(run.id, run)
    if (stream) this.streams.set(run.id, stream)
    return run
  }

  update(id: string, patch: Partial<Run>): void {
    const run = this.runs.get(id)
    if (run) this.runs.set(id, { ...run, ...patch, updatedAt: nextTime() })
  }

  list(query: ListRunsQuery): Run[] {
    return [...this.runs.values()]
      .filter((r) => {
        if (query.mode && r.mode !== query.mode) return false
        if (query.topLevel === true && r.parentRunId !== null) return false
        if (query.topLevel === false && r.parentRunId === null) return false
        if (query.current === true && r.currentRunId !== null) return false
        if (query.current === false && r.currentRunId === null) return false
        if (query.parentRunId && r.parentRunId !== query.parentRunId) return false
        if (query.rootRunId && r.rootRunId !== query.rootRunId) return false
        if (query.delivered !== undefined && this.delivered(r.rootRunId) !== query.delivered) return false
        if (query.status && !query.status.includes(r.status)) return false
        return true
      })
      .map((r) => ({ ...r, delivered: this.delivered(r.rootRunId) }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  }

  private delivered(root: string): boolean {
    return this.marks.has(root)
  }

  api(): TasksApi {
    return {
      list: async (query) => {
        this.calls.push({ op: "list", arg: query })
        return { runs: this.list(query), nextPageToken: null }
      },
      start: async (body: StartRunRequest) => {
        this.calls.push({ op: "start", arg: body })
        const lose = this.loseNextStart
        this.loseNextStart = null
        if (lose === "dropped") throw new RunsError("network", "network", "Failed to fetch")
        if (!this.runs.has(body.runId)) {
          const fp = body.forwardedProps as { goal?: string; research?: boolean }
          this.add(
            makeRun({
              id: body.runId,
              threadId: body.threadId,
              status: "queued",
              goal: fp.goal ?? "task",
              research: fp.research ?? false,
            }),
          )
        }
        if (lose === "created") throw new RunsError("network", "network", "Failed to fetch")
        return { runId: body.runId, status: this.runs.get(body.runId)!.status }
      },
      resume: async (request) => {
        this.calls.push({ op: "resume", arg: request })
        const err = this.nextResumeError
        this.nextResumeError = null
        if (err) throw err
        this.onResume?.(request)
        return { runId: request.runId, status: "queued" }
      },
      answer: async (runId: string, resume: ResumeEntry[]) => {
        this.calls.push({ op: "answer", arg: { runId, resume } })
        const run = this.runs.get(runId)
        if (!run) throw new RunsError("http", "not_found", "gone", 404)
        if (!run.parentRunId) throw new RunsError("http", "invalid_state", "not a sub-agent", 409)
        if (run.answerPending) throw new RunsError("http", "run_already_answered", "answered", 409)
        this.update(runId, { answerPending: true })
        return this.runs.get(runId)!
      },
      cancel: async (runId) => {
        this.calls.push({ op: "cancel", arg: runId })
        this.update(runId, { status: "cancelled", finishedAt: nextTime() })
        return this.runs.get(runId)!
      },
      markDelivered: async (root) => {
        this.calls.push({ op: "markDelivered", arg: root })
        if (!this.marks.has(root)) this.marks.set(root, nextTime())
        return { ...this.runs.get(root)!, delivered: true }
      },
      stream: async (runId, after) => {
        this.calls.push({ op: "stream", arg: { runId, after } })
        const items = this.streams.get(runId)
        if (!items) throw new RunsError("http", "not_found", "gone", 404)
        return streamOf(runId, items, after)
      },
    }
  }
}

/** One browser's store, as delivery sees it; rows by id. */
export class FakeStore implements DeliveryStore {
  conversations = new Map<string, DeliveryConversation & { messages: Array<{ id: string; role: string; content: string; verification?: unknown }> }>()
  documents = new Map<string, { id: string; workspaceId: string; title: string; content: string }>()
  artifacts = new Map<string, { id: string; conversationId: string; messageId: string | null; title: string; content: string }>()
  cards = new Map<string, { id: string; title: string; taskId?: string; artifactId?: string; status: string }>()
  active = "ws-1"
  activeDocument: string | null = null
  writes = 0

  addConversation(id: string, workspaceId = "ws-1"): void {
    this.conversations.set(id, { id, workspaceId, messages: [] })
  }

  getConversation(id: string) {
    return this.conversations.get(id) ?? null
  }
  activeWorkspaceId() {
    return this.active
  }
  addMessageWithId(
    id: string,
    message: { role: "assistant"; content: string; generatedImages?: unknown[] },
    conversationId: string,
  ): boolean {
    for (const c of this.conversations.values()) if (c.messages.some((m) => m.id === id)) return true
    const conv = this.conversations.get(conversationId)
    if (!conv) return false
    this.writes += 1
    conv.messages.push({ id, ...message })
    return true
  }
  createDocumentWithId(id: string, workspaceId: string, title: string, content: string) {
    if (!this.documents.has(id)) this.documents.set(id, { id, workspaceId, title, content })
  }
  createArtifactWithId(
    id: string,
    input: { conversationId: string; messageId: string | null; title: string; content: string },
  ) {
    if (!this.artifacts.has(id)) this.artifacts.set(id, { id, ...input })
  }
  setActiveDocument(id: string) {
    this.activeDocument = id
  }
  getCard(cardId: string) {
    return this.cards.get(cardId) ?? null
  }
  findCard(root: string) {
    return [...this.cards.values()].find((c) => c.taskId === root) ?? null
  }
  setCardArtifact(cardId: string, artifactId: string) {
    const card = this.cards.get(cardId)
    if (card) card.artifactId = artifactId
  }
  moveCard(cardId: string, status: "todo" | "done") {
    const card = this.cards.get(cardId)
    if (card) card.status = status
  }
}

/** Web Locks shared by the "tabs" of one browser: callbacks under one
 *  name run one after another. */
export function sharedLocks(): LockLike {
  const tails = new Map<string, Promise<unknown>>()
  return {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const prev = tails.get(name) ?? Promise.resolve()
      const next = prev.then(callback, callback)
      tails.set(
        name,
        next.catch(() => {}),
      )
      return next
    },
  }
}

export interface Browser {
  storage: PointerStorage
  locks: LockLike
}

export function browser(): Browser {
  return { storage: memoryStorage(), locks: sharedLocks() }
}

export interface TabOptions {
  server: FakeRunsServer
  store?: FakeStore
  browser?: Browser
  overrides?: Partial<TasksControllerDeps>
}

/** One tab: a controller over the fake server, with no timers. */
export function tab(opts: TabOptions): { controller: TasksController; store: FakeStore; pointers: TaskPointers; notes: string[]; shown: Array<{ title: string; tag: string }> } {
  const store = opts.store ?? new FakeStore()
  const b = opts.browser ?? browser()
  const pointers = new TaskPointers(USER, b.storage)
  const notes: string[] = []
  const shown: Array<{ title: string; tag: string }> = []
  const controller = new TasksController({
    userId: USER,
    api: opts.server.api(),
    pointers,
    store,
    availability: () => ({ ok: true }),
    isPanelOpen: () => true,
    locks: b.locks,
    pull: async () => "ok",
    whenDrained: async () => {},
    notifier: {
      isHidden: () => true,
      permission: () => "granted",
      show: (title, o) => shown.push({ title, tag: o.tag }),
    },
    launch: {
      whenDrained: async () => {},
      openPanel: () => {},
      note: (m) => notes.push(m),
      linkCard: (cardId, root) => {
        const card = store.cards.get(cardId)
        if (card) card.taskId = root
      },
      revertCard: (cardId) => store.moveCard(cardId, "todo"),
      localFilesOnly: () => false,
    },
    setTimer: () => null,
    clearTimer: () => {},
    now: () => clock,
    ...opts.overrides,
  })
  return { controller, store, pointers, notes, shown }
}

/** Wait until `cond` holds (the watch streams asynchronously). */
export async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 2))
  }
}

export function advanceClock(ms: number): void {
  clock += ms
}

export function nowIso(): string {
  return new Date(clock).toISOString()
}
