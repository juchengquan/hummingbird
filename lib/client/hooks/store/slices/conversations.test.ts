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
