/**
 * Delivering a finished task (Q70, Q77): once across tabs (one browser:
 * shared storage and locks) and across browsers (separate stores whose
 * rows meet in the cloud by id), into the task's own conversation and
 * workspace, never into a deleted one; a scheduled task's conversation
 * pulled first.
 */
import { describe, expect, test } from "bun:test"

import { resultIdsFor } from "@/shared/runs/ids"

import { deliverTask, type DeliveryDeps } from "./deliver"
import { withStepLimitNote } from "@/shared/agent/step-limit"
import { TaskPointers } from "./pointers"
import { summaryOf } from "./summary"
import { FakeRunsServer, FakeStore, USER, browser, makeRun, tab, type Browser } from "./test-support"

const ROOT = "11111111-0000-4000-8000-0000000000aa"
const CONV = "22222222-0000-4000-8000-0000000000bb"
const IDS = resultIdsFor(USER, ROOT)

function finished(patch: Parameters<typeof makeRun>[0] extends infer P ? Partial<P> : never = {}) {
  return makeRun({
    id: ROOT,
    threadId: CONV,
    status: "succeeded",
    result: { text: "The answer." },
    finishedAt: new Date().toISOString(),
    ...patch,
  })
}

/** The cloud: every row a browser's sync pushed, by id. */
class Cloud {
  messages = new Map<string, { conversationId: string; content: string }>()
  push(store: FakeStore) {
    for (const c of store.conversations.values()) {
      for (const m of c.messages) this.messages.set(m.id, { conversationId: c.id, content: m.content })
    }
  }
}

function deps(
  store: FakeStore,
  b: Browser,
  server: FakeRunsServer,
  cloud: Cloud,
  extra: Partial<DeliveryDeps> = {},
): DeliveryDeps {
  const api = server.api()
  return {
    userId: USER,
    store,
    pointers: new TaskPointers(USER, b.storage),
    locks: b.locks,
    pull: async () => "ok",
    whenDrained: async () => cloud.push(store),
    markDelivered: async (root) => {
      await api.markDelivered(root)
    },
    ...extra,
  }
}

describe("delivery", () => {
  test("two browsers deliver the same task: one message in the cloud, one server mark", async () => {
    const server = new FakeRunsServer()
    server.add(finished())
    const cloud = new Cloud()
    const a = new FakeStore()
    const b = new FakeStore()
    a.addConversation(CONV)
    b.addConversation(CONV)
    // Both read the list before either marked it.
    const listedA = summaryOf(server.list({})[0], { userId: USER })
    const listedB = summaryOf(server.list({})[0], { userId: USER })
    const [ra, rb] = await Promise.all([
      deliverTask(listedA, deps(a, browser(), server, cloud)),
      deliverTask(listedB, deps(b, browser(), server, cloud)),
    ])
    expect([ra, rb]).toEqual(["delivered", "delivered"])
    expect([...cloud.messages.keys()]).toEqual([IDS.messageId])
    expect(server.marks.size).toBe(1)
    // A third browser reads the list after the mark: nothing written.
    const c = new FakeStore()
    c.addConversation(CONV)
    const listedC = summaryOf(server.list({})[0], { userId: USER })
    expect(listedC.delivered).toBe(true)
    expect(await deliverTask(listedC, deps(c, browser(), server, cloud))).toBe("already")
    expect(c.writes).toBe(0)
  })

  test("two tabs of one browser: one writes, the other sees the mark — one message, one mark", async () => {
    const server = new FakeRunsServer()
    server.add(finished())
    const cloud = new Cloud()
    const shared = browser()
    const tab1 = new FakeStore()
    const tab2 = new FakeStore()
    tab1.addConversation(CONV)
    tab2.addConversation(CONV)
    const task = summaryOf(server.list({})[0], { userId: USER })
    const results = await Promise.all([
      deliverTask(task, deps(tab1, shared, server, cloud)),
      deliverTask(task, deps(tab2, shared, server, cloud)),
    ])
    expect(results.sort()).toEqual(["delivered", "marked"])
    expect(tab1.writes + tab2.writes).toBe(1)
    expect(cloud.messages.size).toBe(1)
    expect(server.marks.size).toBe(1)
  })

  test("the controller delivers what the list shows, once, across two tabs and a later read", async () => {
    const server = new FakeRunsServer()
    server.add(finished())
    const shared = browser()
    const store = new FakeStore()
    store.addConversation(CONV)
    const t1 = tab({ server, browser: shared, store })
    const t2 = tab({ server, browser: shared, store })
    await Promise.all([t1.controller.refreshNow(), t2.controller.refreshNow()])
    await new Promise((r) => setTimeout(r, 10))
    expect(store.conversations.get(CONV)!.messages.map((m) => m.id)).toEqual([IDS.messageId])
    expect(server.marks.size).toBe(1)
    await t1.controller.refreshNow()
    await new Promise((r) => setTimeout(r, 10))
    expect(store.writes).toBe(1)
    expect(t1.controller.snapshot().tasks![0].delivered).toBe(true)
  })

  test("a research report goes to the conversation's workspace, not the active one (bug 2)", async () => {
    const server = new FakeRunsServer()
    server.add(finished({ research: true, result: { text: "# Report\n\nBody [1]." } }))
    const store = new FakeStore()
    store.addConversation(CONV, "ws-research")
    store.active = "ws-other"
    const task = summaryOf(server.list({})[0], { userId: USER })
    await deliverTask(task, deps(store, browser(), server, new Cloud()))
    expect(store.documents.get(IDS.documentId)?.workspaceId).toBe("ws-research")
    expect(store.artifacts.get(IDS.artifactId)).toMatchObject({ conversationId: CONV, messageId: IDS.messageId })
    // Not opened in a workspace the user isn't in.
    expect(store.activeDocument).toBeNull()
  })

  test("a deleted conversation gets nothing (bug 21); the task is still marked", async () => {
    const server = new FakeRunsServer()
    server.add(finished({ research: true }))
    const store = new FakeStore()
    let pulls = 0
    const task = summaryOf(server.list({})[0], { userId: USER })
    const out = await deliverTask(
      task,
      deps(store, browser(), server, new Cloud(), {
        pull: async () => {
          pulls += 1
          return "ok"
        },
      }),
    )
    expect(out).toBe("marked")
    expect(pulls).toBe(1)
    expect(store.writes).toBe(0)
    expect(store.documents.size).toBe(0)
    expect(store.artifacts.size).toBe(0)
    expect(server.marks.has(ROOT)).toBe(true)
  })

  test("a scheduled task's conversation is pulled first, then written into", async () => {
    const server = new FakeRunsServer()
    server.add(finished())
    const store = new FakeStore()
    const task = summaryOf(server.list({})[0], { userId: USER })
    const out = await deliverTask(
      task,
      deps(store, browser(), server, new Cloud(), {
        pull: async () => {
          store.addConversation(CONV)
          return "ok"
        },
      }),
    )
    expect(out).toBe("delivered")
    expect(store.conversations.get(CONV)!.messages.map((m) => m.id)).toEqual([IDS.messageId])
  })

  test("a pull that couldn't run: try again later, nothing marked", async () => {
    const server = new FakeRunsServer()
    server.add(finished())
    const store = new FakeStore()
    const task = summaryOf(server.list({})[0], { userId: USER })
    const out = await deliverTask(task, deps(store, browser(), server, new Cloud(), { pull: async () => "failed" }))
    expect(out).toBe("retry")
    expect(server.marks.size).toBe(0)
  })

  test("the mark waits for sync to drain", async () => {
    const server = new FakeRunsServer()
    server.add(finished())
    const store = new FakeStore()
    store.addConversation(CONV)
    const order: string[] = []
    const task = summaryOf(server.list({})[0], { userId: USER })
    await deliverTask(
      task,
      deps(store, browser(), server, new Cloud(), {
        whenDrained: async () => {
          order.push("drained")
        },
        markDelivered: async () => {
          order.push("marked")
        },
      }),
    )
    expect(order).toEqual(["drained", "marked"])
  })

  test("failed / cancelled: no message, the board card back to To-do, marked", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const server = new FakeRunsServer()
      server.add(finished({ status, result: null, error: status === "failed" ? { code: "x", message: "y" } : null }))
      const store = new FakeStore()
      store.addConversation(CONV)
      store.cards.set("c", { id: "c", title: "Card", taskId: ROOT, status: "in_progress" })
      const task = summaryOf(server.list({})[0], { userId: USER })
      expect(await deliverTask(task, deps(store, browser(), server, new Cloud()))).toBe("marked")
      expect(store.writes).toBe(0)
      expect(store.cards.get("c")!.status).toBe("todo")
      expect(server.marks.has(ROOT)).toBe(true)
    }
  })

  test("a board card: done, with the result as its artifact (derived id)", async () => {
    const server = new FakeRunsServer()
    server.add(finished())
    const store = new FakeStore()
    store.addConversation(CONV)
    store.cards.set("c", { id: "c", title: "Card", taskId: ROOT, status: "in_progress" })
    await deliverTask(summaryOf(server.list({})[0], { userId: USER }), deps(store, browser(), server, new Cloud()))
    expect(store.cards.get("c")).toMatchObject({ status: "done", artifactId: IDS.artifactId })
  })

  test("a task the old path already delivered (same text, another id) isn't written again", async () => {
    const server = new FakeRunsServer()
    server.add(finished())
    const store = new FakeStore()
    store.addConversation(CONV)
    store.conversations.get(CONV)!.messages.push({ id: "old-random-id", role: "assistant", content: "The answer." })
    const out = await deliverTask(summaryOf(server.list({})[0], { userId: USER }), deps(store, browser(), server, new Cloud()))
    expect(out).toBe("marked")
    expect(store.conversations.get(CONV)!.messages).toHaveLength(1)
  })

  test("a task that stopped at its step limit delivers what it has, with the note (Q81)", async () => {
    const server = new FakeRunsServer()
    server.add(finished({ result: { text: "Partial.", stoppedAt: "max_steps" } }))
    const store = new FakeStore()
    store.addConversation(CONV)
    const task = summaryOf(server.list({})[0], { userId: USER })
    expect(task.stoppedAt).toBe("max_steps")
    await deliverTask(task, deps(store, browser(), server, new Cloud()))
    expect(store.conversations.get(CONV)!.messages[0].content).toBe(withStepLimitNote("Partial.", 25))
  })
})

describe("board cards on runs", () => {
  test("a card named by the launch's projectTaskId (not linked yet): done, with its artifact, once across two browsers", async () => {
    const server = new FakeRunsServer()
    server.add(finished())
    const cloud = new Cloud()
    const stores = [new FakeStore(), new FakeStore()]
    for (const store of stores) {
      store.addConversation(CONV)
      store.cards.set("card-7", { id: "card-7", title: "Card", status: "in_progress" })
    }
    const listed = summaryOf(server.list({})[0], { userId: USER, projectTaskId: "card-7" })
    await Promise.all(stores.map((store) => deliverTask(listed, deps(store, browser(), server, cloud))))
    for (const store of stores) {
      expect(store.cards.get("card-7")).toMatchObject({ status: "done", artifactId: IDS.artifactId })
      expect([...store.artifacts.keys()]).toEqual([IDS.artifactId])
    }
    expect(server.marks.size).toBe(1)
  })

  test("failed by projectTaskId: back to To-do, no artifact", async () => {
    const server = new FakeRunsServer()
    server.add(finished({ status: "failed", result: null, error: { code: "x", message: "y" } }))
    const store = new FakeStore()
    store.addConversation(CONV)
    store.cards.set("card-8", { id: "card-8", title: "Card", status: "in_progress" })
    const listed = summaryOf(server.list({})[0], { userId: USER, projectTaskId: "card-8" })
    await deliverTask(listed, deps(store, browser(), server, new Cloud()))
    expect(store.cards.get("card-8")!.status).toBe("todo")
    expect(store.artifacts.size).toBe(0)
  })
})

describe("generated images (localFilesOnly)", () => {
  test("the task's images are stored with the delivered message, not left to the URL in the text", async () => {
    const server = new FakeRunsServer()
    server.add(finished({ result: { text: "Here it is: ![fox](https://minimax.example/tmp/fox.png?exp=1)" } }))
    const store = new FakeStore()
    store.addConversation(CONV)
    const image = {
      id: "c-img-0",
      url: "data:image/png;base64,iVBORw0KGgo=",
      width: 1024,
      height: 1024,
      format: "png",
      prompt: "a red fox",
      mode: "t2i" as const,
    }
    await deliverTask(
      summaryOf(server.list({})[0], { userId: USER }),
      deps(store, browser(), server, new Cloud(), {
        outputOf: async () => ({ verification: null, images: [image], files: [], codeResults: [] }),
      }),
    )
    const message = store.conversations.get(CONV)!.messages[0] as { generatedImages?: unknown[] }
    expect(message.generatedImages).toEqual([image])
  })
})

