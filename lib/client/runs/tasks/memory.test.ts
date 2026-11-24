/**
 * A task's result never feeds memory extraction (survey § 2: chat's
 * end-of-turn handling isn't reused; background results never set
 * `memoryTainted`, which would read as trusted). Delivering a task through
 * the controller makes no request at all besides the runs API — so no
 * `/api/memory/extract` (nor agent-py's `/v1/memory/extract`) — and the
 * tasks modules don't import the memory or chat-turn code.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { FakeRunsServer, FakeStore, makeRun, tab } from "./test-support"

const CONV = "4738a0ca-220f-43ff-b1c6-a75aa9265be1"
const realFetch = globalThis.fetch
const requests: string[] = []

beforeEach(() => {
  requests.length = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(input.toString())
    return new Response("{}", { status: 200 })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe("no memory extraction for tasks", () => {
  test("delivering a finished task makes no request outside the runs API", async () => {
    const server = new FakeRunsServer()
    server.add(makeRun({ id: "00000000-0000-4000-8000-0000000000f1", threadId: CONV, status: "succeeded", result: { text: "I remember you like blue." } }))
    const store = new FakeStore()
    store.addConversation(CONV)
    const t = tab({ server, store })
    await t.controller.refreshNow()
    await new Promise((r) => setTimeout(r, 20))
    expect(store.writes).toBe(1)
    expect(server.marks.size).toBe(1)
    expect(requests).toEqual([])
  })

  test("the tasks modules import neither memory extraction nor chat's turn runner", () => {
    const dir = import.meta.dir
    for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))) {
      const source = readFileSync(join(dir, file), "utf8")
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])
      for (const spec of imports) {
        expect(spec).not.toMatch(/memory|chat-runner|chat-bridge|active-run|restore-interrupted|use-chat-send/)
      }
    }
  })
})
