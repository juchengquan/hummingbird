import { describe, expect, test } from "bun:test"

import { mergeCrossTabState } from "./cross-tab-merge"

type Row = { id: string; title?: string; messages?: string[] }
const row = (id: string, title = id, extra: Partial<Row> = {}): Row => ({
  id,
  title,
  ...extra,
})
/** What the other tab's write looks like after JSON round-trip. */
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const ids = (rows: unknown) => (rows as Row[]).map((r) => r.id)
const none = new Set<string>()

describe("mergeCrossTabState — entity arrays", () => {
  test("a row added in the other tab is adopted, ours untouched", () => {
    const a = row("a")
    const base = { conversations: [a] }
    const ours = { conversations: [a] }
    const theirs = { conversations: [row("b"), clone(a)] }
    const r = mergeCrossTabState({ base, ours, theirs, heldConversationIds: none })
    expect(ids(r.merged.conversations)).toEqual(["b", "a"])
    // Identical content keeps the live object (no re-render churn).
    expect((r.merged.conversations as Row[])[1]).toBe(a)
    expect(r.oursWon).toBe(false)
  })

  test("the reported bug: tab B's new conversation survives tab A's unflushed edit", () => {
    const a = row("a")
    const base = { conversations: [a] }
    const aEdited = { ...a, title: "renamed in A" }
    const ours = { conversations: [aEdited] }
    const theirs = { conversations: [row("b"), clone(a)] }
    const r = mergeCrossTabState({ base, ours, theirs, heldConversationIds: none })
    expect(r.merged.conversations).toEqual([row("b"), aEdited])
    expect((r.merged.conversations as Row[])[1]).toBe(aEdited)
    // A must write back so B sees the rename.
    expect(r.oursWon).toBe(true)
  })

  test("a row added only here is kept and forces a write-back", () => {
    const a = row("a")
    const c = row("c")
    const r = mergeCrossTabState({
      base: { conversations: [a] },
      ours: { conversations: [c, a] },
      theirs: { conversations: [clone(a)] },
      heldConversationIds: none,
    })
    expect(ids(r.merged.conversations)).toEqual(["c", "a"])
    expect(r.oursWon).toBe(true)
  })

  test("delete in the other tab of a row untouched here → deleted", () => {
    const a = row("a")
    const b = row("b")
    const r = mergeCrossTabState({
      base: { conversations: [a, b] },
      ours: { conversations: [a, b] },
      theirs: { conversations: [clone(a)] },
      heldConversationIds: none,
    })
    expect(ids(r.merged.conversations)).toEqual(["a"])
    expect(r.oursWon).toBe(false)
  })

  test("delete here of a row untouched there → stays deleted, write back", () => {
    const a = row("a")
    const b = row("b")
    const r = mergeCrossTabState({
      base: { conversations: [a, b] },
      ours: { conversations: [a] },
      theirs: { conversations: clone([a, b]) },
      heldConversationIds: none,
    })
    expect(ids(r.merged.conversations)).toEqual(["a"])
    expect(r.oursWon).toBe(true)
  })

  test("edit beats delete, either direction", () => {
    const a = row("a")
    // Deleted here, edited there → their edit survives.
    const r1 = mergeCrossTabState({
      base: { notes: [a] },
      ours: { notes: [] },
      theirs: { notes: [row("a", "edited there")] },
      heldConversationIds: none,
    })
    expect(r1.merged.notes).toEqual([row("a", "edited there")])
    // Edited here, deleted there → our edit survives.
    const aEdited = { ...a, title: "edited here" }
    const r2 = mergeCrossTabState({
      base: { notes: [a] },
      ours: { notes: [aEdited] },
      theirs: { notes: [] },
      heldConversationIds: none,
    })
    expect(r2.merged.notes).toEqual([aEdited])
    expect(r2.oursWon).toBe(true)
  })

  test("both edited the same row → the newer (their) write wins", () => {
    const a = row("a")
    const r = mergeCrossTabState({
      base: { notes: [a] },
      ours: { notes: [{ ...a, title: "ours" }] },
      theirs: { notes: [row("a", "theirs")] },
      heldConversationIds: none,
    })
    expect(r.merged.notes).toEqual([row("a", "theirs")])
    expect(r.oursWon).toBe(false)
  })

  test("a conversation streaming here is never replaced by the other tab's copy", () => {
    const a = row("a", "a", { messages: ["hi"] })
    const streaming = { ...a, messages: ["hi", "partial assistant…"] }
    const conflict = mergeCrossTabState({
      base: { conversations: [a] },
      ours: { conversations: [streaming] },
      theirs: { conversations: [row("a", "renamed there", { messages: ["hi"] })] },
      heldConversationIds: new Set(["a"]),
    })
    expect((conflict.merged.conversations as Row[])[0]).toBe(streaming)
  })

  test("…but the other tab's delete of it wins (no resurrection)", () => {
    // Tab B deleted the conversation tab A is streaming into. Keeping
    // A's copy brought it back without its images (B's delete cascade
    // already dropped those); A aborts the stream instead (useChatSend).
    const a = row("a", "a", { messages: ["hi"] })
    const streaming = { ...a, messages: ["hi", "partial assistant…"] }
    const deleted = mergeCrossTabState({
      base: { conversations: [a] },
      ours: { conversations: [streaming] },
      theirs: { conversations: [] },
      heldConversationIds: new Set(["a"]),
    })
    expect(deleted.merged.conversations).toEqual([])
    expect(deleted.oursWon).toBe(false)
  })

  test("a streaming conversation the other tab never saw is kept", () => {
    const fresh = row("new", "new", { messages: ["hi", "partial…"] })
    const r = mergeCrossTabState({
      base: { conversations: [] },
      ours: { conversations: [fresh] },
      theirs: { conversations: [] },
      heldConversationIds: new Set(["new"]),
    })
    expect(r.merged.conversations).toEqual([fresh])
    expect(r.oursWon).toBe(true)
  })

  test("nextBase lines up with the merged live objects", () => {
    const a = row("a")
    const ours = { conversations: [a] }
    const theirs = { conversations: [row("b"), clone(a)] }
    const r = mergeCrossTabState({
      base: { conversations: [a] },
      ours,
      theirs,
      heldConversationIds: none,
    })
    // A second, identical write from the other tab is a no-op.
    const again = mergeCrossTabState({
      base: r.nextBase,
      ours: r.merged,
      theirs: clone(theirs),
      heldConversationIds: none,
    })
    expect(again.oursWon).toBe(false)
    expect(again.merged.conversations).toEqual(r.merged.conversations)
    const [b2, a2] = again.merged.conversations as Row[]
    const [b1, a1] = r.merged.conversations as Row[]
    expect(b2).toBe(b1)
    expect(a2).toBe(a1)
  })
})

describe("mergeCrossTabState — scalar keys and per-tab state", () => {
  test("shared preference changed there is adopted; changed here is kept", () => {
    const r1 = mergeCrossTabState({
      base: { theme: "dark" },
      ours: { theme: "dark" },
      theirs: { theme: "light" },
      heldConversationIds: none,
    })
    expect(r1.merged.theme).toBe("light")
    expect(r1.oursWon).toBe(false)
    const r2 = mergeCrossTabState({
      base: { theme: "dark" },
      ours: { theme: "system" },
      theirs: { theme: "dark" },
      heldConversationIds: none,
    })
    expect(r2.merged.theme).toBe("system")
    expect(r2.oursWon).toBe(true)
  })

  test("per-tab view keys always stay ours and never force a write-back", () => {
    const a = row("a")
    const b = row("b")
    const r = mergeCrossTabState({
      base: { activeConversationId: "a", sidebarWidth: 300, conversations: [a, b] },
      ours: { activeConversationId: "a", sidebarWidth: 280, conversations: [a, b] },
      theirs: {
        activeConversationId: "b",
        sidebarWidth: 400,
        conversations: clone([a, b]),
      },
      heldConversationIds: none,
    })
    expect(r.merged.activeConversationId).toBe("a")
    expect(r.merged.sidebarWidth).toBe(280)
    expect(r.oursWon).toBe(false)
  })

  test("a per-tab selection whose row was deleted falls back to theirs", () => {
    const a = row("a")
    const b = row("b")
    const r = mergeCrossTabState({
      base: { activeConversationId: "a", conversations: [a, b] },
      ours: { activeConversationId: "a", conversations: [a, b] },
      theirs: { activeConversationId: "b", conversations: [clone(b)] },
      heldConversationIds: none,
    })
    expect(r.merged.activeConversationId).toBe("b")
  })
})
