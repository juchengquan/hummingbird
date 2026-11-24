import { expect, test, type Page } from "@playwright/test"

import {
  DESKTOP,
  PHONE,
  calls,
  foldStream,
  manifest,
  openPanel,
  openWithTasks,
  panel,
  question,
  recordedInterrupt,
  setFake,
  sse,
  summary,
  taskItem,
  taskToggle,
} from "./support/tasks-fake"

/**
 * The Tasks panel on runs (wave 6): the list of every task (Q69), a
 * task's view, a sub-agent's question answered on its parent (Q59),
 * Cancel and Skip (Q60), the step-limit note (Q81). Against the in-page
 * fake tasks interface, fed views folded from agent-py's recorded
 * background streams.
 */

const SPAWN = manifest("spawn").runs
const PARENT = SPAWN.parent.runId
const ASKS = SPAWN["child-asks"].runId
const WORKS = SPAWN["child-works"].runId
const CHAIN = manifest("chain").runs

/** A parent whose four sub-agents each ask a different kind of question. */
function spawnTask() {
  const kinds = {
    approval: recordedInterrupt("background/approval/run.sse", "send-1"),
    choice: recordedInterrupt("memory-interrupt-choice.sse", "c-ask"),
    input: recordedInterrupt("background/spawn/child-asks-paused.sse", "q"),
    "ui-part": recordedInterrupt("memory-interrupt-ui.sse", "c-ui"),
  }
  const childIds = {
    approval: "aaaaaaaa-0000-4000-8000-000000000001",
    choice: "aaaaaaaa-0000-4000-8000-000000000002",
    input: ASKS,
    "ui-part": "aaaaaaaa-0000-4000-8000-000000000004",
  }
  const questions = Object.entries(kinds).map(([kind, raw]) =>
    question(PARENT, childIds[kind as keyof typeof childIds], raw, "in_place", {
      name: `${kind}-helper`,
      subgoal: `Check ${kind}`,
    }),
  )
  const view = foldStream(["background/spawn/parent.sse"])
  view.status = "running"
  view.resultText = null
  return {
    task: summary({
      rootRunId: PARENT,
      title: "Ask the helpers",
      phase: "needs_answer",
      status: "running",
      step: 2,
      childrenAsking: 4,
      questions,
    }),
    view: {
      runIds: [PARENT],
      view,
      children: [
        ...Object.entries(childIds).map(([kind, runId], i) => ({
          runId,
          name: `${kind}-helper`,
          subgoal: `Check ${kind}`,
          status: "interrupted",
          question: questions[i],
          error: null,
        })),
        { runId: WORKS, name: "works-helper", subgoal: "works", status: "running", question: null, error: null },
      ],
      connection: "live",
    },
  }
}

function planTask() {
  const view = foldStream(["background/plan/run.sse"])
  view.status = "running"
  return {
    task: summary({ title: "Plan the release", phase: "running", status: "running", step: 2, maxSteps: 25 }),
    view: { runIds: [], view, children: [], connection: "live" },
  }
}

async function openList(page: Page, viewport = DESKTOP) {
  const spawn = spawnTask()
  const plan = planTask()
  const stepLimited = summary({
    title: "Summarise the logs",
    phase: "succeeded",
    status: "succeeded",
    step: 25,
    maxSteps: 25,
    result: { text: "Partial summary.", stoppedAt: "max_steps" },
  })
  const failed = summary({
    title: "Broken task",
    phase: "failed",
    status: "failed",
    error: { code: "provider", message: "The model provider failed." },
  })
  const cancelled = summary({ title: "Old task", phase: "cancelled", status: "cancelled" })
  const queued = summary({ title: "Queued task", phase: "queued", status: "queued", step: null })
  await openWithTasks(page, {
    tasks: [spawn.task, plan.task, queued, stepLimited, failed, cancelled],
    views: {
      [spawn.task.rootRunId as string]: spawn.view as never,
      [plan.task.rootRunId as string]: plan.view as never,
    },
  })
  await openPanel(page)
  await page.setViewportSize(viewport)
  return { spawn, plan, stepLimited, failed }
}

test("every task is listed with its state; the cap is shown (Q69, Q72)", async ({ page }) => {
  await openList(page)
  const items = panel(page).getByRole("listitem", { name: /^Task: / })
  await expect(items).toHaveCount(6)
  await expect(panel(page)).toContainText("3 of 5 running")
  await expect(taskItem(page, "Ask the helpers")).toContainText("4 sub-agents need your answer")
  await expect(taskItem(page, "Plan the release")).toContainText("Running · step 2 / 25")
  await expect(taskItem(page, "Queued task")).toContainText("Queued")
  await expect(taskItem(page, "Broken task")).toContainText("The model provider failed.")
  await expect(taskItem(page, "Old task")).toContainText("Cancelled")
  // The header's button counts the tasks waiting on an answer.
  await expect(page.getByRole("button", { name: "Open tasks panel (1 needs your answer)" })).toBeVisible()
})

test("expanding a task shows its view: steps, plan, tool calls, text (Q69)", async ({ page }) => {
  await openList(page)
  const item = taskItem(page, "Plan the release")
  await expect(item.getByText("Search", { exact: true })).toHaveCount(0)
  await item.getByRole("button", { expanded: false }).click()
  // The plan recorded in `background/plan/run.sse`.
  await expect(item.getByText("Search", { exact: true })).toBeVisible()
  await expect(item.getByText("Write", { exact: true })).toBeVisible()
  await expect(item.getByRole("button", { name: "Cancel task" })).toBeVisible()
  expect((await calls(page, "subscribe")).map((c) => c.args[0])).toContain(await rootOf(page, "Plan the release"))
  await item.getByRole("button", { expanded: true }).click()
  await expect(item.getByText("Search", { exact: true })).toHaveCount(0)
})

async function rootOf(page: Page, title: string): Promise<string> {
  return page.evaluate(
    (t) =>
      (window.__hummTasksFake!.state().tasks.find((x) => x.title === t) as { rootRunId: string }).rootRunId,
    title,
  )
}

test("a sub-agent's question of every kind is answered on its parent (Q59)", async ({ page }) => {
  await openList(page)
  const item = taskItem(page, "Ask the helpers")
  // A task waiting on an answer opens by itself.
  const group = (kind: string) => item.getByRole("group", { name: `Question from sub-agent ${kind}-helper` })
  for (const kind of ["approval", "choice", "input", "ui-part"]) await expect(group(kind)).toBeVisible()
  // The sub-agents spawned, from the parent's recorded stream.
  await expect(item).toContainText("Spawned 5 subagents")

  await group("approval").getByRole("button", { name: "Approve", exact: true }).click()
  await expect(group("approval")).toContainText("Answer sent. Waiting for the task to continue…")

  await group("choice").getByRole("radio", { name: "A", exact: true }).check()
  await group("choice").getByRole("button", { name: "Submit" }).click()
  await expect(group("choice")).toContainText("Answer sent")

  await group("input").getByRole("textbox").fill("blue")
  await group("input").getByRole("button", { name: "Submit" }).click()
  await expect(group("input")).toContainText("Answer sent")

  await group("ui-part").getByRole("button", { name: "Yes" }).click()
  await expect(group("ui-part")).toContainText("Answer sent")

  const answers = await calls(page, "answer")
  const byChild = Object.fromEntries(
    answers.map((c) => [(c.args[0] as { runId: string }).runId, { q: c.args[0], a: c.args[1] }]),
  )
  expect(answers).toHaveLength(4)
  for (const a of answers) expect((a.args[0] as { answeredBy: string }).answeredBy).toBe("in_place")
  expect(byChild["aaaaaaaa-0000-4000-8000-000000000001"].a).toEqual({ approved: true })
  expect(byChild["aaaaaaaa-0000-4000-8000-000000000002"].a).toEqual({ selection: ["a"] })
  expect(byChild[ASKS].a).toEqual({ value: "blue" })
  expect(byChild["aaaaaaaa-0000-4000-8000-000000000004"].a).toEqual({
    uiAnswer: { kind: "confirm", confirmed: true },
    value: "Yes",
  })
  // Every question answered and none picked up yet: "answer sent".
  await expect(item.getByRole("status")).toContainText("Answer sent")
})

test("an answer the question moved past says so plainly", async ({ page }) => {
  await openList(page)
  await setFake(page, {
    answerResult: { ok: false, code: "run_already_answered", message: "Already answered." },
  })
  const group = taskItem(page, "Ask the helpers").getByRole("group", {
    name: "Question from sub-agent input-helper",
  })
  await group.getByRole("textbox").fill("blue")
  await group.getByRole("button", { name: "Submit" }).click()
  await expect(group).toContainText("This question was answered elsewhere.")
  expect(await calls(page, "refresh")).toHaveLength(1)
})

test("Cancel stops the whole task; Skip one sub-agent and the task carries on (Q60)", async ({ page }) => {
  await openList(page)
  const item = taskItem(page, "Ask the helpers")
  await item.getByRole("button", { name: "Skip sub-agent works-helper" }).click()
  expect((await calls(page, "skipChild")).map((c) => c.args[0])).toEqual([WORKS])
  await expect(page.getByText("Skipped sub-agent works-helper. The task carries on without it.")).toBeVisible()
  await expect(item.getByRole("listitem").filter({ hasText: "works-helper" })).toContainText("skipped")
  await expect(item.getByRole("status")).not.toContainText("Cancelled")

  await item.getByRole("button", { name: "Cancel task" }).click()
  expect((await calls(page, "cancel")).map((c) => c.args[0])).toEqual([PARENT])
  await expect(item.getByRole("status")).toHaveText("Cancelled")
  await expect(page.getByText("Task cancelled. Its sub-agents were stopped too.")).toBeVisible()
  await expect(item.getByRole("button", { name: "Cancel task" })).toHaveCount(0)
  await expect(item.getByRole("group", { name: /Question from sub-agent/ })).toHaveCount(0)
})

test("a task stopped at its step limit says so (Q81)", async ({ page }) => {
  await openList(page)
  await expect(taskItem(page, "Summarise the logs")).toContainText(
    "Stopped at the step limit (25 steps): this is what the task had by then.",
  )
  await expect(taskItem(page, "Plan the release")).not.toContainText("step limit")
})

test("a chain's task shows its own question with the dead branch's note (Q75)", async ({ page }) => {
  const raw = recordedInterrupt("background/chain/p0.sse", recordedChainInterruptId())
  const root = CHAIN.p0.runId
  await openWithTasks(page, {
    tasks: [
      summary({
        rootRunId: root,
        title: "Send the summary",
        phase: "needs_answer",
        status: "interrupted",
        questions: [question(root, root, raw, "resume")],
        lastAttemptError: { code: "worker_lost", message: "The worker stopped" },
      }),
    ],
    views: { [root]: { runIds: [root, CHAIN.r1.runId], view: foldStream(["background/chain/p0.sse"]), children: [], connection: "closed" } },
  })
  await openPanel(page)
  const item = taskItem(page, "Send the summary")
  await expect(item).toContainText("The last answer couldn't be applied (The worker stopped). Answer again.")
  await item.getByRole("textbox").fill("green")
  await item.getByRole("button", { name: "Submit" }).click()
  await expect(item).toContainText("Answer sent")
  const [answer] = await calls(page, "answer")
  expect(answer.args[0]).toMatchObject({ runId: root, answeredBy: "resume" })
  expect(answer.args[1]).toEqual({ value: "green" })
})

function recordedChainInterruptId(): string {
  const pendingEvent = sse("background/chain/p0.sse").find(
    (e) => e.type === "CUSTOM" && e.name === "hummingbird.interrupt_pending",
  )
  if (!pendingEvent) throw new Error("no interrupt in chain/p0")
  return (pendingEvent.value as { id: string }).id
}

test("a task is titled by its goal's first line, with its conversation's name under it", async ({ page }) => {
  await openWithTasks(page, {})
  const conversation = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("hummingbird-storage")!).state
    return saved.conversations.find((c: { id: string }) => c.id === saved.activeConversationId) as {
      id: string
      title: string
    }
  })
  await setFake(page, {
    tasks: [
      summary({
        title: "  Write the release notes\nwith every fix since 2.0  ",
        conversationId: conversation.id,
        phase: "running",
      }),
    ],
  })
  await openPanel(page)
  const item = panel(page).getByRole("listitem", { name: "Task: Write the release notes" })
  await expect(item).toBeVisible()
  await expect(item).not.toContainText("with every fix")
  await expect(item.locator("[data-task-title]")).toHaveText("Write the release notes")
  await expect(item.locator("[data-task-conversation]")).toHaveText(conversation.title)
})

test("off runs the old single-task panel stays (Q61)", async ({ page }) => {
  await openWithTasks(page, { availability: { ok: false, reason: "not_runs" } }, { chatBackend: "ts" }, { signedIn: true })
  await expect(page.getByRole("button", { name: /^Open tasks panel/ })).toHaveCount(0)
  await taskToggle(page).click()
  await expect(taskToggle(page)).toHaveAttribute("aria-pressed", "true")
  expect(await page.evaluate(() => window.__hummTasksFake!.state().runAsTask)).toBe(false)
})

test("signed out, tasks can't be launched and the panel says why (bug 20)", async ({ page }) => {
  await openWithTasks(page, { availability: { ok: false, reason: "signed_out" } })
  await expect(taskToggle(page)).toHaveCount(0)
  await page.evaluate(() => {
    // The panel can still be open from an earlier session.
    window.__hummTasksFake!.set({})
  })
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("hummingbird-storage")!)
    raw.state.tasksPanelOpen = true
    localStorage.setItem("hummingbird-storage", JSON.stringify(raw))
  })
  await page.reload()
  await expect(panel(page)).toContainText("Sign in to run tasks.")
})

for (const [size, viewport] of Object.entries({ desktop: DESKTOP, phone: PHONE })) {
  test(`${size}: the list and an expanded task fit the screen`, async ({ page }, info) => {
    await openList(page, viewport)
    await taskItem(page, "Plan the release").getByRole("button", { expanded: false }).click()
    const list = panel(page).getByRole("list", { name: "Tasks" })
    await expect(list).toBeVisible()
    for (const title of ["Ask the helpers", "Plan the release", "Summarise the logs"]) {
      const box = (await taskItem(page, title).boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
    }
    const horizontal = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(horizontal).toBeLessThanOrEqual(0)
    await page.screenshot({ path: info.outputPath(`tasks-list-${size}.png`), fullPage: false })
  })
}
