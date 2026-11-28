import { beforeEach, describe, expect, test } from "bun:test"

import { useStore } from "@/client/hooks/use-store"
import { runMigrations } from "@/client/hooks/store/migrate"

import { BACKEND_REMOVED_NOTICE, noticeBackendSettingRemoved } from "./use-backend-removed-notice"

describe("the v37 backend-removed note (wave 13, Q145)", () => {
  beforeEach(() => useStore.setState({ backendSettingRemoved: undefined }))

  test("says chat now runs on agent-py and the setting is gone", () => {
    expect(BACKEND_REMOVED_NOTICE).toBe("Chat now runs on agent-py. The backend setting was removed.")
  })

  test("a migrated explicit pick shows the note once, never twice", () => {
    const migrated = runMigrations({ chatBackend: "ts" }, 35) as Record<string, unknown>
    useStore.setState(migrated)
    const shown: string[] = []
    noticeBackendSettingRemoved((m) => shown.push(m))
    noticeBackendSettingRemoved((m) => shown.push(m))
    expect(shown).toEqual([BACKEND_REMOVED_NOTICE])
  })

  test("nothing migrated: no note", () => {
    useStore.setState(runMigrations({ chatBackend: null }, 36) as Record<string, unknown>)
    const shown: string[] = []
    noticeBackendSettingRemoved((m) => shown.push(m))
    expect(shown).toEqual([])
  })
})
