/**
 * The chain fold on agent-py's recorded background streams
 * (`fixtures/agent-py/background/`, re-recorded by `bun run fixtures:runs
 * --background`): each scenario folds to what the task panel shows, the
 * incremental fold agrees with the whole-log fold event by event, and a
 * rewind drops the dead attempt.
 */
import { describe, expect, test } from "bun:test"

import { loadBackgroundFixture, loadBackgroundScenario, loadFixture } from "../fixtures"
import { ChainFold, foldChain, type ChainRunLog } from "./chain"

function log(scenario: string, role: string): ChainRunLog {
  const manifest = loadBackgroundScenario(scenario)
  return { runId: manifest.runs[role].runId, items: loadBackgroundFixture(scenario, role).items }
}

/** Push every item of the logs through a `ChainFold`, in order. */
function incremental(runs: ChainRunLog[]) {
  const fold = new ChainFold()
  fold.setLine(runs.map((r) => r.runId))
  for (const run of runs) for (const item of run.items) fold.push(run.runId, item)
  return fold
}

describe("chain fold — recorded background runs", () => {
  test("P0 alone: paused on its question, the askUser call waiting", () => {
    const view = foldChain([log("chain", "p0")])
    expect(view.status).toBe("paused")
    expect(view.step).toBe(1)
    expect(view.pendingInput).toMatchObject({ requestId: "q", kind: "input", prompt: "Which colour?", tool: "askUser" })
    expect(view.toolCalls).toEqual([
      { toolCallId: "q", toolName: "askUser", args: { prompt: "Which colour?" }, status: "running" },
    ])
    expect(view.text).toBe("")
  })

  test("P0 → R1: the resume's opening result closes P0's call; status, step and question are R1's", () => {
    const view = foldChain([log("chain", "p0"), log("chain", "r1")])
    expect(view.status).toBe("done")
    expect(view.step).toBe(2)
    expect(view.pendingInput).toBeNull()
    expect(view.text).toBe("Painted it blue.")
    expect(view.resultText).toBe("Painted it blue.")
    expect(view.toolCalls).toEqual([
      { toolCallId: "q", toolName: "askUser", args: { prompt: "Which colour?" }, summary: "blue", status: "done" },
    ])
  })

  test("the incremental fold agrees with the whole-log fold after every event", () => {
    for (const runs of [
      [log("chain", "p0"), log("chain", "r1")],
      [log("spawn", "parent")],
      [log("plan", "run")],
      [log("rewind", "run")],
      [log("step-error", "run")],
      [log("approval", "run")],
    ]) {
      const fold = new ChainFold()
      fold.setLine(runs.map((r) => r.runId))
      const seen: ChainRunLog[] = runs.map((r) => ({ runId: r.runId, items: [] }))
      runs.forEach((run, i) => {
        for (const item of run.items) {
          fold.push(run.runId, item)
          ;(seen[i].items as typeof run.items[number][]).push(item)
          expect(fold.view).toEqual(foldChain(seen))
        }
      })
    }
  })

  test("repeats (a reconnect or a re-read from an earlier cursor) change nothing", () => {
    const runs = [log("chain", "p0"), log("chain", "r1")]
    const fold = incremental(runs)
    const before = fold.view
    for (const run of runs) for (const item of run.items) expect(fold.push(run.runId, item)).toBe(false)
    expect(fold.view).toBe(before)
    expect(fold.cursorOf(runs[0].runId)).toBe("6")
    expect(fold.cursorOf(runs[1].runId)).toBe("8")
    expect(fold.isClosed(runs[0].runId)).toBe(true)
  })

  test("spawn: the sub-agents with their names and subgoals; the spawn call ends with the run", () => {
    const view = foldChain([log("spawn", "parent")])
    const manifest = loadBackgroundScenario("spawn")
    expect(view.childRuns).toEqual([
      { childTaskId: manifest.runs["child-asks"].runId, agent: "helper", subgoal: "asks" },
      { childTaskId: manifest.runs["child-works"].runId, agent: "helper", subgoal: "works" },
    ])
    expect(view.toolCalls.map((c) => [c.toolName, c.status])).toEqual([["spawnSubagent", "done"]])
    expect(view.status).toBe("done")
  })

  test("a sub-agent answered in place: the question raised, then resolved in the same run", () => {
    const paused = foldChain([log("spawn", "child-asks-paused")])
    expect(paused.status).toBe("paused")
    expect(paused.pendingInput?.requestId).toBe("q")
    const answered = foldChain([log("spawn", "child-asks")])
    expect(answered.pendingInput).toBeNull()
    expect(answered.text).toBe("Blue it is.")
    expect(answered.toolCalls[0]).toMatchObject({ toolCallId: "q", summary: "blue", status: "done" })
  })

  test("a question shows as it is raised (interrupt_pending), before the closing event", () => {
    const { runId, items } = log("approval", "run")
    const fold = new ChainFold()
    fold.setLine([runId])
    for (const item of items.slice(0, -1)) fold.push(runId, item)
    expect(fold.view.status).toBe("running")
    expect(fold.view.pendingInput).toMatchObject({
      requestId: "send-1",
      kind: "approval",
      tool: "mcp__s1__send",
      args: { to: "team" },
    })
  })

  test("plan: the latest whole list", () => {
    const view = foldChain([log("plan", "run")])
    expect(view.plan).toEqual([
      { id: "1", text: "Search", status: "completed" },
      { id: "2", text: "Write", status: "completed" },
    ])
  })

  test("step error: a non-fatal note, the run still succeeds", () => {
    const view = foldChain([log("step-error", "run")])
    expect(view.lastStepError).toBe("tool error: RuntimeError")
    expect(view.status).toBe("done")
    expect(view.fatalError).toBeNull()
  })

  test("rewind on replay: the marker discards nothing, the reclaimed attempt's outcome stands", () => {
    const view = foldChain([log("rewind", "run")])
    expect(view.text).toBe("Done, carefully.")
    expect(view.toolCalls).toEqual([
      { toolCallId: "w", toolName: "mcp__s1__write", args: { n: 1 }, summary: "Interrupted — outcome unknown", status: "done" },
    ])
    expect(view.lastStepError).toContain("was not run again")
  })

  test("rewind live: the dead attempt's text is discarded, the rest kept", () => {
    const stream = loadFixture("stream-rewind-live")
    const runId = "8a6e0804-0000-4000-8000-00000000f907"
    const fold = new ChainFold()
    fold.setLine([runId])
    for (const item of stream.items.slice(0, 9)) fold.push(runId, item)
    expect(fold.view.text).toBe("Checking. dead attempt")
    for (const item of stream.items.slice(9)) fold.push(runId, item)
    expect(fold.view.text).toBe("Checking. Done.")
    expect(fold.view.step).toBe(3)
    expect(foldChain([{ runId, items: stream.items }]).text).toBe("Checking. Done.")
  })

  test("a failed run: failed with its message", () => {
    const stream = loadFixture("stream-failed")
    const runId = (stream.items[0].event as unknown as { runId: string }).runId
    const view = foldChain([{ runId, items: stream.items }])
    expect(view.status).toBe("failed")
    expect(view.fatalError).toBeTruthy()
  })

  test("a line that changes other than by growing re-folds from the runs it still names", () => {
    const p0 = log("chain", "p0")
    const r1 = log("chain", "r1")
    const fold = incremental([p0, r1])
    expect(fold.view.status).toBe("done")
    fold.setLine([p0.runId])
    expect(fold.view.status).toBe("paused")
    expect(fold.view.text).toBe("")
  })
})
