/**
 * Shared `mock.module` registration for the task-route handler tests.
 *
 * `mock.module` in bun is process-global: the *last* registration of a
 * module path wins. With per-file mocks each handler test would race
 * to register a different subset of `@/server/agent/store` exports
 * and the loser would `SyntaxError` on `import { … }` from the route
 * file. This module registers the **union** of symbols every task
 * route imports so any one file's win is a superset of the others.
 *
 * Per-test behaviour is wired by reading the `mocks` object back:
 * each handler test imports `mocks.createRun` etc., calls
 * `mockClear()` in `beforeEach`, and swaps `mockImplementation` for
 * error-path cases. The actual mock fn instances are stable across
 * the run (each export points at the same closure), so
 * `mocks.getRun.mock.calls` works as expected.
 */

import { mock } from "bun:test"

import * as realTaskWrites from "@/server/agent/task-writes"

// --- Supabase server client + auth -----------------------------------------

type GetUserResult = {
  data: { user: { id: string } | null }
  error: { message: string } | null
}

/** Test-side handle for the Supabase client stub. Mutate via
 *  `supabaseClient.value = signedIn()` / `signedOut()` / `null`. */
export const supabaseClient: {
  value: { auth: { getUser: () => Promise<GetUserResult> } } | null
} = { value: null }

mock.module("@/server/supabase/server", () => ({
  getSupabaseServerClient: async () => supabaseClient.value,
}))

export const signedIn = (
  userId = "11111111-1111-1111-1111-111111111111",
) => ({
  auth: {
    getUser: async (): Promise<GetUserResult> => ({
      data: { user: { id: userId } },
      error: null,
    }),
  },
})

export const signedOut = () => ({
  auth: {
    getUser: async (): Promise<GetUserResult> => ({
      data: { user: null },
      error: { message: "Auth session missing!" },
    }),
  },
})

// --- model-provider --------------------------------------------------------

/** Next itself has no provider configured here (no AI Gateway key): the
 *  task routes must not need one, as agent-py's worker calls the model. */
class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderUnavailableError"
  }
}

mock.module("@/server/model-provider", () => ({
  ProviderUnavailableError,
  selectModel: (modelId: string) => {
    throw new ProviderUnavailableError(`no provider configured for model "${modelId}"`)
  },
}))

// --- Agent store + jobs (union of symbols every route uses) ----------------

// Mock fns carry their full call signatures so `mock.calls[i][N]` is
// typed at the assertion site — the test files inspect specific arg
// positions and rely on those types. The `_` prefix on params signals
// "deliberately unread"; the file-level eslint-disable above keeps
// the linter quiet for this dense-stub file without weakening the
// rule elsewhere.
/* eslint-disable @typescript-eslint/no-unused-vars */

export const mocks = {
  // store
  createRun: mock(async (_db: unknown, _input: unknown) => {}),
  listTaskChildren: mock(
    async (
      _db: unknown,
      _parentId: string,
      _userId: string,
    ): Promise<{ id: string; status: string; goal: string }[]> => [],
  ),
  getRun: mock(
    async (
      _db: unknown,
      _runId: string,
      _userId: string,
    ): Promise<{ id: string; status: string } | null> => null,
  ),
  updateRun: mock(
    async (
      _db: unknown,
      _runId: string,
      _userId: string,
      _patch: Record<string, unknown>,
    ) => {},
  ),
  saveCheckpoint: mock(
    async (
      _db: unknown,
      _runId: string,
      _userId: string,
      _checkpoint: unknown,
    ) => {},
  ),
  appendEvent: mock(
    async (_db: unknown, _event: unknown, _userId: string) => {},
  ),
  listEventsSince: mock(
    async (
      _db: unknown,
      _runId: string,
      _userId: string,
      _sinceSeq: number,
    ): Promise<unknown[]> => [],
  ),
  getQuestionKind: mock(
    async (
      _db: unknown,
      _run: unknown,
      _userId: string,
      _requestId: string,
    ): Promise<string | null> => null,
  ),
  appendSyntheticResult: mock(
    async (
      _db: unknown,
      _runId: string,
      _userId: string,
      _opts: Record<string, unknown>,
    ): Promise<boolean> => true,
  ),
  reconcileStaleRuns: mock(
    async (_db: unknown, _userId: string): Promise<number> => 0,
  ),
  // task-writes (RPC-backed run creation, 0034)
  createTaskRun: mock(async (_db: unknown, _input: unknown) => {}),
  cancelTask: mock(async (_db: unknown, _taskId: string) => {}),
  // jobs
  enqueueStartJob: mock(
    async (_db: unknown, _input: { taskId: string; userId: string }) => {},
  ),
  enqueueRespondJob: mock(
    async (
      _db: unknown,
      _input: {
        taskId: string
        userId: string
        payload: Record<string, unknown>
      },
    ) => {},
  ),
}

mock.module("@/server/agent/store", () => ({
  getQuestionKind: mocks.getQuestionKind,
  appendSyntheticResult: mocks.appendSyntheticResult,
  createRun: mocks.createRun,
  getRun: mocks.getRun,
  listTaskChildren: mocks.listTaskChildren,
  updateRun: mocks.updateRun,
  saveCheckpoint: mocks.saveCheckpoint,
  appendEvent: mocks.appendEvent,
  listEventsSince: mocks.listEventsSince,
  reconcileStaleRuns: mocks.reconcileStaleRuns,
}))

// The error class + SQLSTATE mapping stay real so the routes' status
// mapping is exercised; only the RPC call is stubbed.
mock.module("@/server/agent/task-writes", () => ({
  ...realTaskWrites,
  createTaskRun: mocks.createTaskRun,
  cancelTask: mocks.cancelTask,
}))

mock.module("@/server/agent/jobs", () => ({
  enqueueStartJob: mocks.enqueueStartJob,
  enqueueRespondJob: mocks.enqueueRespondJob,
}))

/** Reset every mock fn's call history + default implementation. Call
 *  from each test file's `beforeEach`. */
export function resetAgentMocks(): void {
  mocks.createRun.mockClear()
  mocks.createRun.mockImplementation(async () => {})
  mocks.listTaskChildren.mockClear()
  mocks.listTaskChildren.mockImplementation(async () => [])
  mocks.getRun.mockClear()
  mocks.getRun.mockImplementation(async () => null)
  mocks.updateRun.mockClear()
  mocks.updateRun.mockImplementation(async () => {})
  mocks.saveCheckpoint.mockClear()
  mocks.saveCheckpoint.mockImplementation(async () => {})
  mocks.appendEvent.mockClear()
  mocks.appendEvent.mockImplementation(async () => {})
  mocks.listEventsSince.mockClear()
  mocks.listEventsSince.mockImplementation(async () => [])
  mocks.getQuestionKind.mockClear()
  mocks.getQuestionKind.mockImplementation(async () => null)
  mocks.appendSyntheticResult.mockClear()
  mocks.appendSyntheticResult.mockImplementation(async () => true)
  mocks.cancelTask.mockClear()
  mocks.cancelTask.mockImplementation(async () => {})
  mocks.reconcileStaleRuns.mockClear()
  mocks.reconcileStaleRuns.mockImplementation(async () => 0)
  mocks.createTaskRun.mockClear()
  mocks.createTaskRun.mockImplementation(async () => {})
  mocks.enqueueStartJob.mockClear()
  mocks.enqueueStartJob.mockImplementation(async () => {})
  mocks.enqueueRespondJob.mockClear()
  mocks.enqueueRespondJob.mockImplementation(async () => {})
  supabaseClient.value = signedIn()
}
