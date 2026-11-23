/**
 * The old-path watcher's read failures (survey bug 6): a task that isn't
 * this account's (404) or a signed-out session (401) ends the watch — it
 * is never settled as cancelled (which moved the board card and wrote the
 * delivered mark) nor retried forever.
 */
import { describe, expect, test } from "bun:test"

import { watchFailure } from "./use-task-run"

describe("watchFailure", () => {
  test("404 → gone, 401 → signed out, anything else → retry", () => {
    expect(watchFailure(404, "not_found")).toBe("gone")
    expect(watchFailure(401, "auth")).toBe("signed_out")
    expect(watchFailure(401, "auth_required")).toBe("signed_out")
    expect(watchFailure(500, "unknown")).toBe("retry")
    expect(watchFailure(0, undefined)).toBe("retry")
  })
})
