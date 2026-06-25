import { describe, expect, test } from "bun:test"

import { useStore } from "@/client/hooks/use-store"

describe("forkConversation titleSuffix", () => {
  test("uses the given suffix in the fork title", () => {
    const conv = useStore.getState().createConversation()
    useStore.getState().renameConversation(conv.id, "My chat")
    const msg = useStore.getState().addMessage({ role: "user", content: "hi" }, conv.id)
    const fork = useStore.getState().forkConversation(conv.id, msg.id, "edit")
    expect(fork?.title).toBe("My chat (edit)")
  })

  test("defaults to (branch) when no suffix is given", () => {
    const conv = useStore.getState().createConversation()
    useStore.getState().renameConversation(conv.id, "My chat")
    const msg = useStore.getState().addMessage({ role: "user", content: "hi" }, conv.id)
    const fork = useStore.getState().forkConversation(conv.id, msg.id)
    expect(fork?.title).toBe("My chat (branch)")
  })
})

describe("forkConversation synchronous visibility", () => {
  // Root-cause guarantee the use-chat-send fix relies on: the fork is in
  // `useStore.getState().conversations` AND is the active conversation
  // synchronously, in the same event tick as the `forkConversation` call
  // (before any React re-render). The send pipeline resolves the forked
  // conversation off `getState()` for an explicit target precisely
  // because the React-subscribed `conversations` closure hasn't seen it
  // yet at that point.
  test("getState() sees the fork (and it is active) immediately", () => {
    const conv = useStore.getState().createConversation()
    const msg = useStore
      .getState()
      .addMessage({ role: "user", content: "hi" }, conv.id)
    const fork = useStore.getState().forkConversation(conv.id, msg.id, "edit")
    expect(fork).not.toBeNull()
    const state = useStore.getState()
    expect(state.conversations.find((c) => c.id === fork!.id)).toBeDefined()
    expect(state.activeConversationId).toBe(fork!.id)
    // The fork carries a re-id'd copy of the turn (so edits don't bleed
    // across branches) — the id differs from the source message.
    expect(fork!.messages.at(-1)?.id).not.toBe(msg.id)
    expect(fork!.messages.at(-1)?.content).toBe("hi")
  })
})
