"use client"
import "client-only"

/**
 * The `TasksContextValue` the dashboard hands to `TasksProvider`.
 *
 * - The real value is `useTasksController()` (`lib/client/runs/tasks/
 *   controller.ts`): `not_runs` off "agent-py (runs)", so every surface
 *   keeps the old single-task path there (Q61).
 * - E2E builds (`NEXT_PUBLIC_E2E_TASKS_FAKE=1`, set only by
 *   `playwright.config.ts`) can swap in the in-page fake (`./e2e-fake`)
 *   when a spec asks for it. Any other build folds the flag to `false`,
 *   drops `useE2eTasks` and with it the fake's dynamic import.
 */

import { useEffect, useState, useSyncExternalStore } from "react"

import { useTasksController } from "@/client/runs/tasks/controller"
import type { TasksContextValue } from "@/client/runs/tasks/types"

import type { FakeTasks } from "./e2e-fake"

/** Whether this build may load the e2e fake. Off unless the build set it. */
export function e2eTasksFakeAllowed(flag: string | undefined): boolean {
  return flag === "1"
}

const refuse = async () =>
  ({ ok: false, code: "not_runs", message: "Tasks don't run on agent-py (runs) here." }) as const

/** Tasks off runs: the old path drives them (`TaskRunProvider`). */
export const PLACEHOLDER_TASKS: TasksContextValue = {
  availability: { ok: false, reason: "not_runs" },
  tasks: [],
  listError: null,
  activeCount: 0,
  activeLimit: 5,
  getTask: () => null,
  subscribeTask: () => () => {},
  launch: refuse,
  answer: refuse,
  cancel: async () => {},
  skipChild: async () => {},
  refresh: () => {},
  runAsTask: false,
  setRunAsTask: () => {},
}

function useRealTasks(): TasksContextValue {
  return useTasksController()
}

const NO_FAKE = {
  subscribe: () => () => {},
  getValue: () => null,
}

function useE2eTasks(): TasksContextValue {
  const real = useRealTasks()
  const [fake, setFake] = useState<FakeTasks | null>(null)
  useEffect(() => {
    // Written out (not `e2eTasksFakeAllowed`) so the bundler folds it and
    // drops the import below from every build without the flag.
    if (process.env.NEXT_PUBLIC_E2E_TASKS_FAKE !== "1") return
    if (!window.__HUMM_E2E_TASKS__) return
    let cancelled = false
    void import("./e2e-fake").then(({ createFakeTasks }) => {
      if (!cancelled) setFake(createFakeTasks())
    })
    return () => {
      cancelled = true
    }
  }, [])
  const source = fake ?? NO_FAKE
  const value = useSyncExternalStore(source.subscribe, source.getValue, () => null)
  return value ?? real
}

export const useTasksValue: () => TasksContextValue =
  process.env.NEXT_PUBLIC_E2E_TASKS_FAKE === "1" ? useE2eTasks : useRealTasks
