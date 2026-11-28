/** Q124: the editor's own-gateway-key setting is gone — one note, once per browser. */

import { describe, expect, test } from "bun:test"

import {
  EDITOR_KEY_REMOVED_NOTICE,
  EDITOR_KEY_REMOVED_NOTICE_KEY,
  createEditorKeyNotice,
  type NoticeStorage,
} from "./editor-key-notice"

function memoryStorage(initial: Record<string, string> = {}): NoticeStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v
    },
  }
}

describe("the editor-key note", () => {
  test("says the editor now uses the deploy's models", () => {
    expect(EDITOR_KEY_REMOVED_NOTICE).toContain("this deploy's models")
  })

  test("shown once, then never again — across reloads (a fresh notice over the same storage)", () => {
    const storage = memoryStorage()
    const shown: string[] = []
    const first = createEditorKeyNotice({ storage: () => storage, show: (m) => shown.push(m) })
    first()
    first()
    createEditorKeyNotice({ storage: () => storage, show: (m) => shown.push(m) })()
    expect(shown).toEqual([EDITOR_KEY_REMOVED_NOTICE])
    expect(storage.data[EDITOR_KEY_REMOVED_NOTICE_KEY]).toBe("1")
  })

  test("already seen in this browser: nothing", () => {
    const shown: string[] = []
    createEditorKeyNotice({
      storage: () => memoryStorage({ [EDITOR_KEY_REMOVED_NOTICE_KEY]: "1" }),
      show: (m) => shown.push(m),
    })()
    expect(shown).toEqual([])
  })

  test("storage that throws (private mode): still at most once for this page", () => {
    const shown: string[] = []
    const broken: NoticeStorage = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
    }
    const notice = createEditorKeyNotice({ storage: () => broken, show: (m) => shown.push(m) })
    notice()
    notice()
    expect(shown).toEqual([EDITOR_KEY_REMOVED_NOTICE])
  })
})
