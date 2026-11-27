/**
 * Q137/Q142: a deploy without `NEXT_PUBLIC_AGENT_PY_URL` builds, and every
 * page (the app, the editor, share pages) shows one full-page "no backend"
 * screen pointing at the setup docs instead of an app that can't reach
 * anything. The gate wraps the root layout's children.
 */
import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { resolveBackendBaseUrl } from "@/shared/backend-base-url"

import { NO_BACKEND_DOCS_URL, NO_BACKEND_TITLE, NoBackendGate } from "./no-backend-gate"

const APP = createElement("main", { id: "the-app" }, "the app")

describe("NoBackendGate", () => {
  test("no backend configured: the full-page screen, never the app", () => {
    const html = renderToStaticMarkup(createElement(NoBackendGate, { configured: false }, APP))
    expect(NO_BACKEND_TITLE).toBe("This deploy has no backend configured")
    expect(html).toContain(NO_BACKEND_TITLE)
    expect(html).toContain("NEXT_PUBLIC_AGENT_PY_URL")
    expect(html).toContain(`href="${NO_BACKEND_DOCS_URL}"`)
    expect(html).not.toContain("the-app")
  })

  test("a backend configured: the app, untouched", () => {
    const html = renderToStaticMarkup(createElement(NoBackendGate, { configured: true }, APP))
    expect(html).toBe('<main id="the-app">the app</main>')
  })

  test("by default it follows the build's NEXT_PUBLIC_AGENT_PY_URL", () => {
    const configured = resolveBackendBaseUrl(process.env.NEXT_PUBLIC_AGENT_PY_URL).configured
    const html = renderToStaticMarkup(createElement(NoBackendGate, null, APP))
    expect(html.includes("the-app")).toBe(configured)
    expect(html.includes(NO_BACKEND_TITLE)).toBe(!configured)
  })

  test("the docs link points at agent-py's setup", () => {
    expect(NO_BACKEND_DOCS_URL).toMatch(/^https:\/\/github\.com\/.+\/services\/agent-py\/README\.md/)
  })
})
