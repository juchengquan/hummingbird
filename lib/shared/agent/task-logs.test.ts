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

  test("answered calls and a finished spawn stop running", () => {
    for (const stage of ["questions.done", "children.answered-ui-part"] as const) {
      const [task] = logs.stages[stage]
      const view = projectRun(rowsToTaskEvents(rowsOf(task.id) as never))
      expect(view.toolCalls.filter((call) => call.status === "running")).toEqual([])
    }
    const [task] = logs.stages["questions.done"]
    const [rejected] = projectRun(rowsToTaskEvents(rowsOf(task.id) as never)).toolCalls
    expect(rejected.summary).toBe("Declined by the user")
  })

  test("an approved call runs until its output or the next step", () => {
    const [task] = logs.stages["questions.approval"]
    const paused = rowsToTaskEvents(rowsOf(task.id, task.seq) as never)
    const next = { runId: task.id, step: 1, createdAt: paused[0].createdAt }
    const answered = [
      ...paused,
      {
        ...next,
        seq: task.seq + 1,
        kind: "approval" as const,
        phase: "response" as const,
        approvalId: "toolu_parent_0",
        approved: true,
      },
    ]
    expect(projectRun(answered).toolCalls[0].status).toBe("running")
    const stepped = [...answered, { ...next, seq: task.seq + 2, step: 2, kind: "step_start" as const }]
    expect(projectRun(stepped).toolCalls[0].status).toBe("done")
  })
})
