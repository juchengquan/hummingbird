import { describe, expect, test } from "bun:test"

import { servedSignedOut } from "./signed-out-calls"

describe("servedSignedOut (wave 12, Q123/Q134)", () => {
  test("the non-chat calls a signed-out browser makes", () => {
    for (const path of [
      "/v1/url/fetch",
      "/v1/summarize",
      "/v1/extract",
      "/v1/extract-table",
      "/v1/embed",
      "/v1/mcp/srv-1/discover",
      "/v1/mcp/srv-1/call",
      "/v1/mcp/srv%2F1/read",
    ]) {
      expect([path, servedSignedOut(path)]).toEqual([path, true])
    }
  })

  test("the account-bound ones never", () => {
    for (const path of [
      "/v1/mcp/server",
      "/v1/share",
      "/v1/share/tok",
      "/v1/tasks/schedules",
      "/v1/tasks/schedules/id",
      "/v1/memory/extract",
      "/v1/images/refresh-url",
      "/v1/files/refresh-url",
      "/v1/mcp/srv/bogus",
      "/v1/extract/",
      "/api/extract",
    ]) {
      expect([path, servedSignedOut(path)]).toEqual([path, false])
    }
  })
})
