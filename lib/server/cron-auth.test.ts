import { describe, expect, test } from "bun:test"

import { isAuthorizedCronRequest } from "./cron-auth"

describe("isAuthorizedCronRequest", () => {
  test("accepts the exact bearer token", () => {
    expect(isAuthorizedCronRequest("Bearer s3cret", "s3cret")).toBe(true)
  })

  test("rejects a wrong token, including prefixes and different lengths", () => {
    expect(isAuthorizedCronRequest("Bearer s3cre", "s3cret")).toBe(false)
    expect(isAuthorizedCronRequest("Bearer s3cretX", "s3cret")).toBe(false)
    expect(isAuthorizedCronRequest("Bearer nope", "s3cret")).toBe(false)
  })

  test("rejects a missing header, non-Bearer schemes and a bare secret", () => {
    expect(isAuthorizedCronRequest(null, "s3cret")).toBe(false)
    expect(isAuthorizedCronRequest("", "s3cret")).toBe(false)
    expect(isAuthorizedCronRequest("s3cret", "s3cret")).toBe(false)
    expect(isAuthorizedCronRequest("Basic s3cret", "s3cret")).toBe(false)
    expect(isAuthorizedCronRequest("Bearer ", "s3cret")).toBe(false)
  })

  test("an empty expected secret never authorizes", () => {
    expect(isAuthorizedCronRequest("Bearer ", "")).toBe(false)
    expect(isAuthorizedCronRequest("Bearer x", "")).toBe(false)
  })
})
