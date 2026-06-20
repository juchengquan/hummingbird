import { afterEach, describe, expect, test } from "bun:test"

import { openChildRunViewer, useChildRunViewer } from "./types"

afterEach(() => useChildRunViewer.getState().close())

describe("useChildRunViewer", () => {
  test("open sets the target", () => {
    useChildRunViewer.getState().open({ childTaskId: "c1" })
    expect(useChildRunViewer.getState().target).toEqual({ childTaskId: "c1" })
  })
  test("close clears the target", () => {
    useChildRunViewer.getState().open({ childTaskId: "c1" })
    useChildRunViewer.getState().close()
    expect(useChildRunViewer.getState().target).toBeNull()
  })
  test("openChildRunViewer helper calls open", () => {
    openChildRunViewer({ childTaskId: "c2" })
    expect(useChildRunViewer.getState().target).toEqual({ childTaskId: "c2" })
  })
})
