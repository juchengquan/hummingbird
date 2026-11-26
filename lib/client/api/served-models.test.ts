/**
 * The browser loads agent-py's `GET /v1/models` once (wave 10, Q119) into
 * `@/shared/served-models`; a failed read leaves the built-in list in place
 * and is tried again on the next load.
 */
import { afterEach, describe, expect, test } from "bun:test"

import { servedModels, servedModelsSettled, setServedModels } from "@/shared/served-models"

import { loadServedModels, resetServedModelsLoad } from "./served-models"

const BODY = { models: [{ id: "minimax/minimax-m3.1-flash", tasks: true }], defaultModel: "minimax/minimax-m3.1-flash", auto: false }

function fetcher(responses: Array<Response | Error>) {
  const calls: string[] = []
  const fn = async (url: string): Promise<Response> => {
    calls.push(url)
    const next = responses.shift()!
    if (next instanceof Error) throw next
    return next
  }
  return { fn, calls }
}

afterEach(() => {
  setServedModels(null)
  resetServedModelsLoad()
})

describe("loadServedModels", () => {
  test("reads /v1/models once", async () => {
    const f = fetcher([Response.json(BODY)])
    await Promise.all([loadServedModels("https://api.example", f.fn), loadServedModels("https://api.example", f.fn)])
    await loadServedModels("https://api.example", f.fn)
    expect(f.calls).toEqual(["https://api.example/v1/models"])
    expect([...servedModels()!.ids]).toEqual(["minimax/minimax-m3.1-flash"])
  })

  test("same origin", async () => {
    const f = fetcher([Response.json(BODY)])
    await loadServedModels("", f.fn)
    expect(f.calls).toEqual(["/v1/models"])
  })

  test("settled after the first answer, read or not", async () => {
    expect(servedModelsSettled()).toBe(false)
    const f = fetcher([new Error("offline")])
    await loadServedModels("https://api.example", f.fn)
    expect(servedModelsSettled()).toBe(true)
    expect(servedModels()).toBeNull()
  })

  test("a failed read keeps the built-in list and is tried again", async () => {
    const f = fetcher([new Error("offline"), new Response("nope", { status: 503 }), Response.json({ x: 1 }), Response.json(BODY)])
    for (let i = 0; i < 3; i++) {
      await loadServedModels("https://api.example", f.fn)
      expect(servedModels()).toBeNull()
    }
    await loadServedModels("https://api.example", f.fn)
    expect(servedModels()).not.toBeNull()
    expect(f.calls).toHaveLength(4)
  })
})
