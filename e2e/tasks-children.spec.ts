import { expect, type Locator } from "@playwright/test"

import {
  childOf,
  childQuestion,
  DESKTOP,
  launch,
  panel,
  PHONE,
  test,
} from "./support/tasks"

/** Q59 / B3: a sub-agent's question is shown and answered on the parent task. */

const ANSWERS: {
  kind: string
  answer: (card: Locator) => Promise<void>
  body: Record<string, unknown>
}[] = [
  {
    kind: "approval",
    answer: (card) => card.getByRole("button", { name: "Reject" }).click(),
    body: { approved: false },
  },
  {
    kind: "choice",
    answer: async (card) => {
      await card.getByRole("radio", { name: "Blue" }).check()
      await card.getByRole("button", { name: "Submit" }).click()
    },
    body: { selection: ["blue"] },
  },
  {
    kind: "input",
    answer: async (card) => {
      await card.getByRole("textbox").fill("Version 2")
      await card.getByRole("button", { name: "Submit" }).click()
    },
    body: { value: "Version 2" },
  },
  {
    kind: "ui-part",
    answer: (card) => card.getByRole("button", { name: "Yes" }).click(),
    body: { uiAnswer: { kind: "confirm", confirmed: true }, value: "Yes" },
  },
]

for (const [size, viewport] of Object.entries({ desktop: DESKTOP, phone: PHONE })) {
  test.describe(size, () => {
    test("each kind of child question is answered on the parent, to that child's id", async ({ page, tasks }) => {
      await launch(page, tasks, "children.asking")
      await page.setViewportSize(viewport)
      await expect(panel(page).getByRole("status")).toContainText("need your answer")
      for (const [i, { kind, answer, body }] of ANSWERS.entries()) {
        await answer(childQuestion(page, kind))
        await expect.poll(async () => (await tasks.sent("respond")).length).toBe(i + 1)
        const sent = (await tasks.sent("respond"))[i]
        expect(sent.id).toBe(childOf(kind))
        expect(sent.body).toEqual({ requestId: `toolu_child_${kind}`, ...body })
      }
    })

    test("each child's window answers its question too", async ({ page, tasks }) => {
      await launch(page, tasks, "children.asking")
      await page.setViewportSize(viewport)
      for (const [i, { kind, answer, body }] of ANSWERS.entries()) {
        await panel(page).getByRole("button", { name: new RegExp(`${kind}-helper Check ${kind}$`) }).click()
        const sheet = page.getByRole("dialog", { name: "Subagent run" })
        await answer(sheet)
        await expect.poll(async () => (await tasks.sent("respond")).length).toBe(i + 1)
        const sent = (await tasks.sent("respond"))[i]
        expect(sent.id).toBe(childOf(kind))
        expect(sent.body).toEqual({ requestId: `toolu_child_${kind}`, ...body })
        // The parent's card took the answer too: one state per question.
        await page.keyboard.press("Escape")
        await expect(sheet).toBeHidden()
        await expect(childQuestion(page, kind)).toContainText("Answer sent")
      }
    })

    test("the new cards fit the panel", async ({ page, tasks }) => {
      await launch(page, tasks, "children.asking")
      await page.setViewportSize(viewport)
      await expect(childQuestion(page, "approval")).toBeVisible()
      await page.waitForTimeout(400) // the panel's width transition
      const bounds = (await panel(page).boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
      const controls = panel(page).locator("button, pre, textarea, [role=group]")
      for (const control of await controls.all()) {
        const box = await control.boundingBox()
        if (!box || !box.width) continue
        expect(box.x).toBeGreaterThanOrEqual(bounds.x)
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width)
      }
    })
  })
}

test("answering one child leaves the others, and what was typed in them", async ({ page, tasks }) => {
  await launch(page, tasks, "children.asking")
  const typed = childQuestion(page, "input").getByRole("textbox")
  await typed.fill("half an answer")
  await childQuestion(page, "approval").getByRole("button", { name: "Reject" }).click()
  await expect(childQuestion(page, "approval").getByRole("button", { name: "Reject" })).toBeHidden()

  await tasks.stage("children.answered-approval")
  await expect(childQuestion(page, "approval")).toBeHidden()
  await expect(childQuestion(page, "choice")).toBeVisible()
  await expect(childQuestion(page, "ui-part")).toBeVisible()
  await expect(typed).toHaveValue("half an answer")
})

test("children's questions survive a reload", async ({ page, tasks }) => {
  await launch(page, tasks, "children.asking")
  await page.reload()
  for (const { kind } of ANSWERS) await expect(childQuestion(page, kind)).toBeVisible()
})

test("answered elsewhere: the 409 re-reads and drops the card", async ({ page, tasks }) => {
  await launch(page, tasks, "children.asking")
  await tasks.fault({ op: "respond", status: 409, body: { code: "already_answered", message: "Already answered." }, times: 1 })
  const card = childQuestion(page, "approval")
  await card.getByRole("button", { name: "Reject" }).click()
  await expect(card.getByRole("button", { name: "Reject" })).toBeHidden()
  await expect(card).toContainText("answered elsewhere")
  await tasks.stage("children.answered-approval")
  await expect(card).toBeHidden()
})

for (const [name, status, code] of [
  ["a server error", 500, "provider"],
  ["a full queue (409 limit_reached)", 409, "limit_reached"],
] as const) {
  test(`${name} is shown and the answer can be sent again`, async ({ page, tasks }) => {
    await launch(page, tasks, "children.asking")
    await tasks.fault({ op: "respond", status, body: { code, message: "Couldn't queue it." }, times: 1 })
    const card = childQuestion(page, "approval")
    await card.getByRole("button", { name: "Reject" }).click()
    await expect(card.getByRole("alert")).toContainText("Couldn't queue it.")
    await card.getByRole("button", { name: "Reject" }).click()
    await expect.poll(async () => (await tasks.sent("respond")).length).toBe(2)
  })
}

test("a double click sends one answer", async ({ page, tasks }) => {
  await launch(page, tasks, "children.asking")
  await tasks.fault({ op: "respond", delayMs: 400 })
  await childQuestion(page, "approval").getByRole("button", { name: "Reject" }).dblclick({ force: true })
  await page.waitForTimeout(600)
  expect(await tasks.sent("respond")).toHaveLength(1)
})

test("the parent is seen to resume after its stream closed while waiting", async ({ page, tasks }) => {
  await launch(page, tasks, "children.asking")
  await expect(childQuestion(page, "approval")).toBeVisible()
  await tasks.dropStreams()
  await tasks.stage("children.answered-ui-part")
  await expect(panel(page)).toContainText("Task finished")
  await expect(page.getByText("Every helper has reported back.").first()).toBeVisible()
})
