import { expect, test } from "@playwright/test"

import { CREDENTIAL, SERVER, createPersona, openWithLocalServer, sendAsPersona } from "./support/persona"
import { isStartRequest, steerRuns } from "./support/runs"

/**
 * Q50: a persona's MCP allow-list filters local-mode servers as well as
 * cloud-mode ones (Q48), so `/personas` must offer both. Driven through
 * the dialog, down to what the run is sent. Q51: a resume from
 * a page that didn't start the run (reload, other tab) keeps the list.
 */

test.describe("persona MCP allow-list", () => {
  test("runs: a ticked local server is sent with the run", async ({ page }) => {
    const { starts } = await steerRuns(page, {})
    await openWithLocalServer(page)
    await createPersona(page, { allowServer: true })

    await sendAsPersona(page)
    await expect.poll(() => starts.length).toBe(1)
    expect(starts[0].forwardedProps?.allowedMcpServerIds).toEqual([SERVER.id])
    expect(starts[0].forwardedProps?.localMcpServers).toMatchObject([{ id: SERVER.id }])
  })

  test("runs: an empty allow-list still means no MCP", async ({ page }) => {
    const { starts } = await steerRuns(page, {})
    await openWithLocalServer(page)
    await createPersona(page, { allowServer: false })

    await sendAsPersona(page)
    await expect.poll(() => starts.length).toBe(1)
    expect(starts[0].forwardedProps?.allowedMcpServerIds).toEqual([])
    expect(starts[0].forwardedProps?.localMcpServers).toBeUndefined()
  })

  for (const answeredFrom of ["after a reload", "in another tab"] as const) {
    for (const allowServer of [false, true]) {
      test(`runs: answered ${answeredFrom}, the list holds (${allowServer ? "server ticked" : "empty"})`, async ({
        page,
        context,
      }) => {
        await steerRuns(page, { outcome: "interrupt" })
        await openWithLocalServer(page)
        await createPersona(page, { allowServer })
        await sendAsPersona(page)
        await page.getByText("Approve the stub action?").waitFor()
        // Wait for the turn to be on disk before another page reads it.
        await expect
          .poll(() => page.evaluate(() => localStorage.getItem("hummingbird-storage") ?? ""))
          .toContain("Stub reply to")

        let answering = page
        if (answeredFrom === "after a reload") await page.reload()
        else {
          answering = await context.newPage()
          await steerRuns(answering, { outcome: "interrupt" })
          await answering.goto("/")
        }
        await answering.getByText("Approve the stub action?").waitFor()

        const resume = answering.waitForRequest(isStartRequest)
        await answering.getByRole("button", { name: "Approve", exact: true }).click()
        const request = await resume
        const sent = request.postDataJSON()
        expect(sent.forwardedProps.allowedMcpServerIds).toEqual(allowServer ? [SERVER.id] : [])
        if (allowServer) {
          expect(sent.forwardedProps.localMcpServers).toMatchObject([{ id: SERVER.id }])
        } else {
          expect(sent.forwardedProps.localMcpServers).toBeUndefined()
          // Never sent, not just ignored by the server.
          expect(request.postData()).not.toContain(CREDENTIAL)
        }
      })
    }
  }
})
