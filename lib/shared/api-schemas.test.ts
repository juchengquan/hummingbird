import { describe, expect, test } from "bun:test"

import { RefreshImageUrlRequestSchema } from "./api-schemas"

describe("RefreshImageUrlRequestSchema", () => {
  test("accepts a normal user-scoped storage path", () => {
    const r = RefreshImageUrlRequestSchema.safeParse({
      storagePath: "abc-123/generated/img-42.png",
    })
    expect(r.success).toBe(true)
  })

  test("rejects empty string", () => {
    expect(
      RefreshImageUrlRequestSchema.safeParse({ storagePath: "" }).success
    ).toBe(false)
  })

  test("rejects path traversal", () => {
    expect(
      RefreshImageUrlRequestSchema.safeParse({
        storagePath: "abc/../../etc/passwd",
      }).success
    ).toBe(false)
  })

  test("rejects leading-slash absolute path", () => {
    expect(
      RefreshImageUrlRequestSchema.safeParse({ storagePath: "/abc/x.png" })
        .success
    ).toBe(false)
  })

  test("rejects missing field", () => {
    expect(RefreshImageUrlRequestSchema.safeParse({}).success).toBe(false)
  })
})
