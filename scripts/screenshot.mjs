#!/usr/bin/env node
/**
 * Tiny Playwright wrapper for taking screenshots of the running dev server.
 *
 * Usage:
 *   node scripts/screenshot.mjs <path> <out> [width] [height]
 *
 * Examples:
 *   node scripts/screenshot.mjs /dashboard /tmp/desktop.png 1400 900
 *   node scripts/screenshot.mjs /dashboard /tmp/mobile.png 390 844
 *
 * Assumes `bun dev` is already running on http://localhost:3000.
 * Uses the system-installed Playwright + Chromium at /opt/pw-browsers
 * (PLAYWRIGHT_BROWSERS_PATH should already be set in the env).
 */

import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs"

const [, , pathArg = "/dashboard", outArg = "/tmp/screenshot.png", widthArg = "1400", heightArg = "900"] = process.argv

const width = parseInt(widthArg, 10)
const height = parseInt(heightArg, 10)
const url = `http://localhost:3000${pathArg}`

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width, height },
  // Mobile UA when viewport is narrow so the layout sees a phone signal.
  ...(width < 768
    ? {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        isMobile: true,
        hasTouch: true,
      }
    : {}),
})
const page = await context.newPage()

page.on("pageerror", (err) => console.error("[page error]", err.message))
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("[console error]", msg.text())
})

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 })
  // Give the client-side React tree a tick to hydrate after networkidle.
  await page.waitForTimeout(500)
  await page.screenshot({ path: outArg, fullPage: false })
  console.log(`OK ${url} → ${outArg} (${width}×${height})`)
} catch (err) {
  console.error(`FAIL ${url}:`, err.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
