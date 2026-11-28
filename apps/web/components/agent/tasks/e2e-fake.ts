"use client"
import "client-only"

/**
 * E2E ONLY. An in-page `TasksContextValue` for the Playwright specs of the
 * runs task UI (`e2e/tasks-list.spec.ts`, …), so the panel, the launch
 * points and the answer cards can be driven in a real browser before the
 * real value (wave 6-C's `useTasksController`) exists, and without it.
 *
 * Reachable only from `use-tasks-value.ts`, behind the build-time
 * `NEXT_PUBLIC_E2E_TASKS_FAKE=1` (the e2e build sets it; no other build
 * does, so this module is not in their bundles) AND a spec's init script
 * setting `window.__HUMM_E2E_TASKS__`. A spec then drives it through
 * `window.__hummTasksFake` (`set`, `calls`).
 *
 * It does no I/O: it shows the tasks it is given and records what the UI
 * asked of it, answering like the interface says the real one does.
 */

import { useStore } from "@/client/hooks/use-store"
import type {
  TaskAnswerResult,
  TaskError,
  TaskLaunchResult,
  TaskQuestion,
  TasksAvailability,
  TasksContextValue,
  TaskSummary,
  TaskView,
} from "@/client/runs/tasks/types"

/** Marker the bundle audit greps for: it must never be in a production build. */
export const E2E_TASKS_FAKE_MARKER = "__humm_e2e_tasks_fake__"

type ViewPart = Pick<TaskView, "runIds" | "view" | "children" | "connection">

export interface FakeTasksState {
  availability: TasksAvailability
  tasks: TaskSummary[]
  /** rootRunId → the watched part of its view. */
  views: Record<string, ViewPart>
  listError: TaskError | null
  activeLimit: number
  runAsTask: boolean
  /** The next launch's result (default: accepted, a new root id). */
  launchResult: TaskLaunchResult | null
  /** Every answer's result (default: accepted). */
  answerResult: TaskAnswerResult | null
}

export interface FakeCall {
  op: "launch" | "answer" | "cancel" | "skipChild" | "refresh" | "subscribe"
  args: unknown[]
  at: number
}

declare global {
  interface Window {
    __HUMM_E2E_TASKS__?: Partial<FakeTasksState>
    __hummTasksFake?: {
      marker: string
      set(patch: Partial<FakeTasksState>): void
      calls(): FakeCall[]
      state(): FakeTasksState
    }
  }
}

const ACTIVE = new Set(["launching", "queued", "running", "needs_answer", "answer_sent"])

function newId(): string {
  return crypto.randomUUID()
}

export interface FakeTasks {
  subscribe(listener: () => void): () => void
  getValue(): TasksContextValue
}

/** The fake, or null when no spec asked for it. */
export function createFakeTasks(): FakeTasks | null {
  if (typeof window === "undefined" || !window.__HUMM_E2E_TASKS__) return null

  let state: FakeTasksState = {
    availability: { ok: true },
    tasks: [],
    views: {},
    listError: null,
    activeLimit: 5,
    runAsTask: false,
    launchResult: null,
    answerResult: null,
    ...window.__HUMM_E2E_TASKS__,
  }
  const calls: FakeCall[] = []
  const listeners = new Set<() => void>()
  const viewCache = new Map<string, { summary: TaskSummary; part: ViewPart | undefined; view: TaskView }>()
  let value: TasksContextValue

  const record = (op: FakeCall["op"], ...args: unknown[]) => {
    calls.push({ op, args: JSON.parse(JSON.stringify(args ?? [])), at: Date.now() })
  }

  const emit = () => {
    value = build()
    for (const l of [...listeners]) l()
  }

  const set = (patch: Partial<FakeTasksState>) => {
    state = { ...state, ...patch }
    emit()
  }

  const patchTask = (root: string, fn: (t: TaskSummary) => TaskSummary) => {
    state = { ...state, tasks: state.tasks.map((t) => (t.rootRunId === root ? fn(t) : t)) }
  }

  const getTask = (root: string): TaskView | null => {
    const summary = state.tasks.find((t) => t.rootRunId === root)
    if (!summary) return null
    const part = state.views[root]
    const cached = viewCache.get(root)
    if (cached && cached.summary === summary && cached.part === part) return cached.view
    const view: TaskView = {
      ...summary,
      runIds: part?.runIds ?? [summary.rootRunId],
      view: part?.view ?? {
        status: "queued",
        step: 0,
        maxSteps: null,
        text: "",
        reasoning: "",
        plan: [],
        toolCalls: [],
        artifactIds: [],
        lastStepError: null,
        fatalError: null,
        resultText: null,
        verification: null,
        cursor: 0,
        pendingInput: null,
        childRuns: [],
      },
      children: part?.children ?? [],
      connection: part?.connection ?? "closed",
    }
    viewCache.set(root, { summary, part, view })
    return view
  }

  const markAnswered = (question: TaskQuestion) => {
    const matches = (q: TaskQuestion) =>
      q.runId === question.runId && q.interrupt.id === question.interrupt.id
    const task = state.tasks.find((t) => t.rootRunId === question.rootRunId)
    if (!task) return
    const questions = task.questions.map((q) => (matches(q) ? { ...q, answerPending: true } : q))
    const part = state.views[task.rootRunId]
    const children = part?.children.map((c) =>
      c.question && matches(c.question) ? { ...c, question: { ...c.question, answerPending: true } } : c,
    )
    const all = [...questions, ...(children ?? []).flatMap((c) => (c.question ? [c.question] : []))]
    const phase = all.length > 0 && all.every((q) => q.answerPending) ? "answer_sent" : task.phase
    patchTask(task.rootRunId, (t) => ({ ...t, questions, phase }))
    if (part && children) state = { ...state, views: { ...state.views, [task.rootRunId]: { ...part, children } } }
  }

  const build = (): TasksContextValue => ({
    availability: state.availability,
    tasks: state.availability.ok === false && state.availability.reason === "signed_out" ? [] : state.tasks,
    listError: state.listError,
    activeCount: state.tasks.filter((t) => ACTIVE.has(t.phase)).length,
    activeLimit: state.activeLimit,
    getTask,
    subscribeTask(root, onChange) {
      record("subscribe", root)
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    async launch(input, opts) {
      record("launch", input, opts ?? null)
      useStore.getState().setTasksPanelOpen(true)
      const result: TaskLaunchResult = state.launchResult ?? { ok: true, rootRunId: newId() }
      if (result.ok) {
        const now = new Date().toISOString()
        const goal = input.messages.at(-1)
        const text = typeof goal?.content === "string" ? goal.content : "Task"
        state = {
          ...state,
          tasks: [
            {
              rootRunId: result.rootRunId,
              currentRunId: result.rootRunId,
              conversationId: input.conversationId,
              title: opts?.title ?? text,
              research: input.mode === "research",
              phase: "queued",
              status: "queued",
              step: null,
              maxSteps: null,
              stoppedAt: null,
              createdAt: now,
              updatedAt: now,
              finishedAt: null,
              questions: [],
              childrenAsking: 0,
              delivered: false,
              result: null,
              error: null,
              lastAttemptError: null,
              resultIds: { messageId: newId(), documentId: newId(), artifactId: newId() },
              ...(opts?.projectTaskId ? { projectTaskId: opts.projectTaskId } : {}),
            },
            ...state.tasks,
          ],
        }
      }
      emit()
      return result
    },
    async answer(question, answer) {
      record("answer", question, answer)
      const result = state.answerResult ?? { ok: true }
      if (result.ok) markAnswered(question)
      emit()
      return result
    },
    async cancel(root) {
      record("cancel", root)
      patchTask(root, (t) => ({ ...t, phase: "cancelled", status: "cancelled", questions: [] }))
      const part = state.views[root]
      if (part) {
        state = {
          ...state,
          views: {
            ...state.views,
            [root]: {
              ...part,
              view: { ...part.view, status: "cancelled", pendingInput: null },
              children: part.children.map((c) =>
                ACTIVE.has(c.status === "interrupted" ? "needs_answer" : c.status)
                  ? { ...c, status: "cancelled", question: null }
                  : c,
              ),
            },
          },
        }
      }
      emit()
    },
    async skipChild(childRunId) {
      record("skipChild", childRunId)
      for (const [root, part] of Object.entries(state.views)) {
        if (!part.children.some((c) => c.runId === childRunId)) continue
        state = {
          ...state,
          views: {
            ...state.views,
            [root]: {
              ...part,
              children: part.children.map((c) =>
                c.runId === childRunId ? { ...c, status: "cancelled", question: null } : c,
              ),
            },
          },
        }
        patchTask(root, (t) => ({
          ...t,
          questions: t.questions.filter((q) => q.runId !== childRunId),
          childrenAsking: Math.max(0, t.childrenAsking - (t.questions.some((q) => q.runId === childRunId) ? 1 : 0)),
        }))
      }
      emit()
    },
    refresh() {
      record("refresh")
    },
    runAsTask: state.runAsTask,
    setRunAsTask(next) {
      set({ runAsTask: next })
    },
  })

  value = build()
  window.__hummTasksFake = {
    marker: E2E_TASKS_FAKE_MARKER,
    set,
    calls: () => calls,
    state: () => state,
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getValue: () => value,
  }
}
