import { defineConfig, devices } from "@playwright/test"

import { HOST, WEB_ORIGIN, WEB_PORT } from "./support/env"

/**
 * The runs task UI's wire specs (`tasks-wire.spec.ts`): the real tasks
 * provider (wave 6-C's `useTasksController`) against a fake `/v1/runs`
 * and a fake Supabase on one origin (`support/tasks-runs-backend.ts`), in
 * a Next build with that origin baked in as both `NEXT_PUBLIC_SUPABASE_URL`
 * and `NEXT_PUBLIC_AGENT_PY_URL` (`.next-e2e-wire/`).
 *
 * `bunx playwright test -c e2e/tasks-wire.config.ts`. Ports: the app on
 * `E2E_WEB_PORT`, the fake on `E2E_WIRE_PORT` (default 8190).
 *
 * These need the real provider: on a branch without it the dashboard's
 * tasks interface is the `not_runs` placeholder, and they fail at the
 * first step that expects the runs list.
 */

export const WIRE_PORT = Number(process.env.E2E_WIRE_PORT ?? 8190)
export const WIRE_ORIGIN = `http://${HOST}:${WIRE_PORT}`
const skipBuild = process.env.E2E_SKIP_BUILD === "1"

export default defineConfig({
  testDir: ".",
  testMatch: "tasks-wire.spec.ts",
  outputDir: "../test-results/e2e-wire",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: { baseURL: WEB_ORIGIN, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      name: "fake-runs",
      command: `bun e2e/support/tasks-runs-backend.ts ${WIRE_PORT}`,
      cwd: "..",
      url: `${WIRE_ORIGIN}/v1/runs`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      name: "next",
      cwd: "..",
      command: skipBuild
        ? `bun run start -H ${HOST} -p ${WEB_PORT}`
        : `bun run build && bun run start -H ${HOST} -p ${WEB_PORT}`,
      url: WEB_ORIGIN,
      env: {
        NEXT_DIST_DIR: ".next-e2e-wire",
        NEXT_PUBLIC_SUPABASE_URL: WIRE_ORIGIN,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-anon",
        NEXT_PUBLIC_AGENT_PY_URL: WIRE_ORIGIN,
        NEXT_PUBLIC_AGENT_TS_URL: "",
        NEXT_PUBLIC_API_BASE_URL: "",
        NEXT_PUBLIC_E2E_TASKS_FAKE: "",
        REQUIRE_AUTH_FOR_AI: "",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      reuseExistingServer: false,
      timeout: 240_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
})
