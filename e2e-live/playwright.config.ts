import { defineConfig, devices } from "@playwright/test"

/** The real-stack specs (`bun run test:e2e:live`): `stack.sh` starts the servers. */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { outputFolder: "../playwright-report/live", open: "never" }]] : [["list"]],
  outputDir: "../test-results/live-e2e",
  use: { baseURL: "http://127.0.0.1:3171", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
