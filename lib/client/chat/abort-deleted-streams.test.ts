import { describe, expect, test } from "bun:test"

import { abortStreamsOfDeletedConversations } from "./abort-deleted-streams"

describe("abortStreamsOfDeletedConversations", () => {
  test("aborts only the streams whose conversation is gone", () => {
    const kept = new AbortController()
    const gone = new AbortController()
    const map = new Map([
      ["a", kept],
      ["b", gone],
    ])
    expect(abortStreamsOfDeletedConversations(map, [{ id: "a" }])).toEqual(["b"])
    expect(gone.signal.aborted).toBe(true)
    expect(kept.signal.aborted).toBe(false)
  })

  test("no streams → nothing to do", () => {
    expect(abortStreamsOfDeletedConversations(new Map(), [])).toEqual([])
  })
})
