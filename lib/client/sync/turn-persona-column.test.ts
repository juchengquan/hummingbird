import { afterEach, describe, expect, test } from "bun:test"

import type { AppSupabaseClient } from "@/client/supabase/client"

import { configureSync, enqueue, resetSyncQueue, whenDrained } from "./sync-queue"
import { isMissingTurnPersonaColumn } from "./turn-persona-column"

const MISSING = {
  code: "PGRST204",
  message: "Could not find the 'turn_persona' column of 'messages' in the schema cache",
}

afterEach(() => {
  configureSync({ client: null, userId: null })
  resetSyncQueue()
})

describe("a database without 0044", () => {
  test("only that error counts", () => {
    expect(isMissingTurnPersonaColumn(MISSING)).toBe(true)
    expect(isMissingTurnPersonaColumn({ code: "PGRST204", message: "Could not find the 'kind' column" })).toBe(false)
    expect(isMissingTurnPersonaColumn({ code: "23503", message: "turn_persona" })).toBe(false)
    expect(isMissingTurnPersonaColumn(null)).toBe(false)
  })

  test("the queue uploads the message without the column instead of dropping it", async () => {
    const saved: Record<string, unknown>[] = []
    const client = {
      from: () => ({
        upsert: async (row: Record<string, unknown>) => {
          if ("turn_persona" in row) return { error: MISSING }
          saved.push(row)
          return { error: null }
        },
      }),
    } as unknown as AppSupabaseClient
    configureSync({ client, userId: "user-a" })
    enqueue({
      kind: "upsert",
      target: "messages",
      row: { id: "m1", content: "hi", turn_persona: { agentId: "a1", allowedMcpServerIds: [] } },
    })
    await whenDrained()
    expect(saved).toEqual([{ id: "m1", content: "hi", user_id: "user-a" }])
  })
})
