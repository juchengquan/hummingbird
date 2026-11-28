import { describe, expect, test } from "bun:test"

import { resolveSendTargetConversationId } from "@/client/chat/resolve-send-target"

describe("resolveSendTargetConversationId", () => {
  test("an explicit targetConversationId wins over activeConversationId", () => {
    // The bug this guards: a non-destructive edit/regenerate forks the
    // thread (setting `activeConversationId = fork.id` in the store) and
    // resends in the SAME event tick. `send`'s React-subscribed
    // `activeConversationId` is still the source until the next render,
    // so the caller passes the fork id explicitly — it must win, or the
    // reply lands on the source conversation.
    expect(
      resolveSendTargetConversationId(
        { targetConversationId: "fork-1" },
        "source-1"
      )
    ).toBe("fork-1")
  })

  test("falls back to activeConversationId when no target is given", () => {
    // Default path — preserves the tab-switch-mid-stream protection that
    // relies on the subscribed `activeConversationId`.
    expect(resolveSendTargetConversationId(undefined, "active-1")).toBe(
      "active-1"
    )
    expect(resolveSendTargetConversationId({}, "active-1")).toBe("active-1")
  })

  test("returns null when neither is available", () => {
    expect(resolveSendTargetConversationId(undefined, null)).toBeNull()
  })

  test("an explicit target wins even with no active conversation", () => {
    expect(
      resolveSendTargetConversationId({ targetConversationId: "fork-1" }, null)
    ).toBe("fork-1")
  })
})
