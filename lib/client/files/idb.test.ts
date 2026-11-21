import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { IDBFactory } from "fake-indexeddb"

import { __setIndexedDBFactoryForTests, openDatabase, runTransaction } from "./idb"

const NAME = "idb-test"

beforeEach(() => {
  __setIndexedDBFactoryForTests(new IDBFactory())
})

afterEach(() => {
  __setIndexedDBFactoryForTests(undefined)
})

async function put(db: IDBDatabase, key: string, value: string) {
  await runTransaction(db, "s", "readwrite", (s) => s.put(value, key))
}

describe("openDatabase connection cache", () => {
  test("caches one connection per database", async () => {
    const a = await openDatabase(NAME, 1, ["s"])
    const b = await openDatabase(NAME, 1, ["s"])
    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  test("a connection the browser closed (close event) is dropped and reopened", async () => {
    const a = (await openDatabase(NAME, 1, ["s"]))!
    await put(a, "k", "v")
    // What Safari does after a connection loss: the handle is dead and
    // the `close` event fires.
    a.close()
    ;(a.onclose as (ev: Event) => void).call(a, new Event("close"))
    const b = (await openDatabase(NAME, 1, ["s"]))!
    expect(b).not.toBe(a)
    const req = await runTransaction(b, "s", "readonly", (s) => s.get("k"))
    expect(req.result).toBe("v")
  })

  test("a dead handle without a close event is dropped on InvalidStateError", async () => {
    const a = (await openDatabase(NAME, 1, ["s"]))!
    a.close() // no `close` event reaches us
    let error: unknown
    try {
      await put(a, "k", "v")
    } catch (err) {
      error = err
    }
    expect((error as DOMException).name).toBe("InvalidStateError")
    // Let the cache drop settle.
    await Promise.resolve()
    await Promise.resolve()
    const b = (await openDatabase(NAME, 1, ["s"]))!
    expect(b).not.toBe(a)
    await put(b, "k", "v")
  })
})
