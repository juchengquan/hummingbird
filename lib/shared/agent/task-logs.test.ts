/** The codecs + fold over rows the real executor wrote
 *  (`e2e/fixtures/task-logs.json`): nothing it emits may be dropped. */

import { describe, expect, test } from "bun:test"

import logs from "../../../e2e/fixtures/task-logs.json"
import { rowsToTaskEvents } from "./persistence"
import { projectRun } from "./project"
import { fromDataPart, toDataPart } from "./wire"

const rowsOf = (id: string, seq = Infinity) =>
  logs.events.filter((e) => e.task_id === id && e.seq <= seq)

describe("the executor's recorded rows", () => {
  test("every row survives the row codec and the wire", () => {
    const events = rowsToTaskEvents(logs.events as never)
    expect(events).toHaveLength(logs.events.length)
    for (const event of events) expect(fromDataPart(toDataPart(event))).toEqual(event)
  })

  for (const kind of ["approval", "choice", "input", "ui-part"] as const) {
    test(`a pause on ${kind} folds into its question`, () => {
      const [task] = logs.stages[`questions.${kind}`]
      const view = projectRun(rowsToTaskEvents(rowsOf(task.id, task.seq) as never))
      expect(view.status).toBe("paused")
      expect(view.pendingInput?.kind).toBe(kind)
      if (kind === "ui-part") {
        expect(view.pendingInput?.uiKind).toBe("confirm")
        expect(view.pendingInput?.uiProps).toEqual({ prompt: "Publish the draft now?" })
      }
    })
  }

  test("an answered call stops running; a declined one isn't shown as run", () => {
    const [task] = logs.stages["questions.done"]
    const view = projectRun(rowsToTaskEvents(rowsOf(task.id) as never))
    expect(view.toolCalls.filter((call) => call.status === "running")).toEqual([])
    // The rejected webSearch; the three answered questions stay.
    expect(view.toolCalls.map((call) => call.toolName)).toEqual(["askUser", "askUser", "renderUI"])
  })
})
