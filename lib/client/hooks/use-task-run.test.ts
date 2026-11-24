/**
 * The old-path watcher's read failures (survey bug 6): a task that isn't
 * this account's (404) ends the watch — it is never settled as cancelled
 * (which moved the board card and wrote the delivered mark). A 401 is
 * retried, so the watch comes back after signing in again.
 */
import { describe, expect, test } from "bun:test"

import { watchFailure } from "./use-task-run"

describe("watchFailure", () => {
  test("404 → gone, anything else (a 401 too) → retry", () => {
    expect(watchFailure(404, "not_found")).toBe("gone")
    expect(watchFailure(401, "auth")).toBe("retry")
    expect(watchFailure(500, "unknown")).toBe("retry")
    expect(watchFailure(0, undefined)).toBe("retry")
  })
})
