import { defineConfig, devices } from "@playwright/test"

import {
  AGENT_PORT,
  AGENT_PY_ORIGIN,
  HOST,
  SUPABASE_ORIGIN,
  SUPABASE_PORT,
  WEB_ORIGIN,
  WEB_PORT,
} from "./e2e/support/env"

/**
 * Playwright smoke suite (`e2e/`, decision Q39 of
 * docs/PLAN-frontend-backend-split.md): the browser → agent-py `/v1/runs`
 * path, model-free. `bun run test:e2e` starts both halves itself:
 *
 * - **agent-py** on its own port with the stub harness
 *   (`RUNS_STUB_HARNESS=true`), CORS open to the app's origin, no Supabase
 *   (signed out → anonymous runs, kept in memory) and conformance-sized
 *   rate limits so a burst of runs from 127.0.0.1 is never throttled.
 * - **Next.js** as a production build (`next build` + `next start`, ~20 s
 *   locally) with `NEXT_PUBLIC_AGENT_PY_URL` baked in. It builds into
 *   `.next-e2e/` (`NEXT_DIST_DIR`), so it never overwrites the `.next/` of
 *   a normal `bun run build`. `E2E_SKIP_BUILD=1` reuses the last e2e build.
 *
 * Cross-origin (app :3100 → agent-py :8100) rather than the same-origin
 * Caddy proxy, which needs Docker or a host Caddy; the CORS path is the
 * documented "agent-py on its own port" setup (lib/client/runs/README.md).
 *
 * Every env var either side would otherwise pick up from a developer's
 * `.env` / `.env.local` and that changes behaviour is pinned here
 * (process env wins over dotenv files on both sides).
 */

const reuse = process.env.E2E_REUSE_SERVERS === "1"
const skipBuild = process.env.E2E_SKIP_BUILD === "1"

const NEXT_ENV: Record<string, string> = {
  NEXT_DIST_DIR: ".next-e2e",
  NEXT_PUBLIC_AGENT_PY_URL: AGENT_PY_ORIGIN,
  // A fake Supabase (`e2e/support/tasks-runs-backend.ts`): signed out
  // unless a spec seeds a session cookie (`support/tasks.ts` `openApp`,
  // tasks need sign-in); its sync writes are accepted and dropped.
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE_ORIGIN,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-anon",
  NEXT_PUBLIC_API_BASE_URL: "",
  NEXT_TELEMETRY_DISABLED: "1",
  // The runs task UI's specs (`tasks-list` / `tasks-launch`) swap in the
  // in-page fake tasks interface (`components/agent/tasks/e2e-fake.ts`)
  // when they ask for it; no other build carries it.
  NEXT_PUBLIC_E2E_TASKS_FAKE: "1",
}

const AGENT_PY_ENV: Record<string, string> = {
  RUNS_STUB_HARNESS: "true",
  CORS_ALLOWED_ORIGINS: WEB_ORIGIN,
  // No Supabase: anonymous runs only, in memory; no poller work.
  SUPABASE_URL: "",
  SUPABASE_JWT_SECRET: "",
  SUPABASE_DB_URL: "",
  REQUIRE_AUTH_FOR_AI: "",
  // One served provider, so `GET /v1/models` lists exactly the built-in
  // `anthropic/*` models the specs expect (Q131: an *empty* list now means
  // "no model provider" and blocks sending). The stub harness never calls a
  // model; the key is a dummy and the base URL a closed loopback port, so
  // nothing can reach Anthropic. Every other provider is pinned off so a
  // developer's `.env` can't widen the list.
  ANTHROPIC_API_KEY: "e2e-stub-not-a-key",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
  AI_GATEWAY_API_KEY: "",
  OPENROUTER_API_KEY: "",
  MINIMAX_CN_BASE_URL: "",
  MINIMAX_CN_API_KEY: "",
  OLLAMA_BASE_URL: "",
  OLLAMA_API_KEY: "",
  // Rate-limit key = the socket peer (no proxy in front).
  TRUSTED_PROXY_HOPS: "0",
  CLIENT_IP_HEADER: "",
  // Conformance-sized limits (packages/contract/README.md): every run in
  // the suite comes from 127.0.0.1, and a failed run keeps its slot until
  // it settles.
  RUNS_RATE_PER_MINUTE: "1000",
  RUNS_ANONYMOUS_RATE_PER_MINUTE: "1000",
  RUNS_ANONYMOUS_DAILY_BUDGET: "100000",
  RUNS_ANONYMOUS_MAX_CONCURRENT: "50",
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // Wave 6's wire specs need the real tasks provider and their own build
  // (a faked Supabase origin baked in): `e2e/tasks-wire.config.ts`.
  testIgnore: ["**/tasks-wire.spec.ts"],
  outputDir: "./test-results/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // Specs share one agent-py; each run is its own conversation + thread,
  // so they are independent, but keep the smoke suite serial — it is
  // small, and serial keeps timing-based steps (stop, reload) predictable.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"]],
  use: {
    baseURL: WEB_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      name: "fake-supabase",
      command: `bun e2e/support/tasks-runs-backend.ts ${SUPABASE_PORT}`,
      url: `${SUPABASE_ORIGIN}/auth/v1/health`,
      reuseExistingServer: reuse,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      name: "agent-py",
      command: `uv run --frozen uvicorn agent_py.main:app --host ${HOST} --port ${AGENT_PORT}`,
      cwd: "./services/agent-py",
      url: `${AGENT_PY_ORIGIN}/healthz`,
      env: AGENT_PY_ENV,
      reuseExistingServer: reuse,
      timeout: 60_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      name: "next",
      command: skipBuild
        ? `bun run start -H ${HOST} -p ${WEB_PORT}`
        : `bun run build && bun run start -H ${HOST} -p ${WEB_PORT}`,
      url: WEB_ORIGIN,
      env: NEXT_ENV,
      reuseExistingServer: reuse,
      timeout: 240_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
})
