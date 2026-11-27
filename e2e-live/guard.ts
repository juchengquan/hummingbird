/**
 * Q133: on the default backend the browser never calls a Next `/api/*`
 * route. Every live spec imports `test` from here; an automatic fixture
 * records the browser's requests to Next's `/api/*` — in the test's own
 * context and in any context or page it opens from `browser` — and fails the
 * test at teardown if there was one. A spec that drives the `ts` backend on
 * purpose (removed in wave 13) opts out with `test.use({ nextApi: "allowed" })`.
 */
import { test as base, type Browser, type BrowserContext } from "@playwright/test"

export { expect } from "@playwright/test"
export type { BrowserContext, Page } from "@playwright/test"

type Options = { nextApi: "forbidden" | "allowed" }

export const test = base.extend<Options & { nextApiGuard: void }>({
  nextApi: ["forbidden", { option: true }],
  nextApiGuard: [
    async ({ browser, context, baseURL, nextApi }, use) => {
      const next = new URL(baseURL ?? "http://127.0.0.1:3171").origin
      const hits: string[] = []
      const watch = (c: BrowserContext) =>
        c.on("request", (req) => {
          const url = new URL(req.url())
          if (url.origin === next && url.pathname.startsWith("/api/")) hits.push(`${req.method()} ${url.pathname}`)
        })
      watch(context)
      const b = browser as Browser & { newContext: Browser["newContext"]; newPage: Browser["newPage"] }
      const { newContext, newPage } = b
      b.newContext = async (options) => {
        const c = await newContext.call(browser, options)
        watch(c)
        return c
      }
      b.newPage = async (options) => {
        const p = await newPage.call(browser, options)
        watch(p.context())
        return p
      }
      try {
        await use()
      } finally {
        b.newContext = newContext
        b.newPage = newPage
      }
      if (nextApi === "forbidden" && hits.length > 0) {
        throw new Error(`the browser called Next's /api/* on the default backend (Q133):\n  ${hits.join("\n  ")}`)
      }
    },
    { auto: true },
  ],
})
