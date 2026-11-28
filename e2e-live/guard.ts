/**
 * Q133 / Q147: the browser never calls a Next `/api/*` route — there is no
 * Next API any more (wave 13). Every live spec imports `test` from here; an
 * automatic fixture records the browser's requests to Next's `/api/*` — in
 * the test's own context and in any context or page it opens from
 * `browser` — and fails the test at teardown if there was one. No opt-out.
 */
import { test as base, type Browser, type BrowserContext } from "@playwright/test"

export { expect } from "@playwright/test"
export type { BrowserContext, Page } from "@playwright/test"

export const test = base.extend<{ nextApiGuard: void }>({
  nextApiGuard: [
    async ({ browser, context, baseURL }, run) => {
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
        await run()
      } finally {
        b.newContext = newContext
        b.newPage = newPage
      }
      if (hits.length > 0) {
        throw new Error(`the browser called Next's /api/* (Q133, Q147):\n  ${hits.join("\n  ")}`)
      }
    },
    { auto: true },
  ],
})
