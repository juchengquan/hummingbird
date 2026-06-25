import { describe, expect, it } from "bun:test"

import type { Message } from "@/shared/types"
import { forkTargetForEdit, forkTargetForRegenerate } from "./fork-target"

const t = new Date("2026-01-01T00:00:00Z")
const u = (id: string): Message => ({ id, role: "user", content: id, timestamp: t })
const a = (id: string): Message => ({ id, role: "assistant", content: id, timestamp: t })

describe("forkTargetForEdit", () => {
  it("returns the edited message id when present", () => {
    expect(forkTargetForEdit([u("u1"), a("a1")], "u1")).toBe("u1")
  })
  it("returns null when the id is absent", () => {
    expect(forkTargetForEdit([u("u1")], "gone")).toBeNull()
  })
})

describe("forkTargetForRegenerate", () => {
  it("returns the nearest preceding user message", () => {
    expect(forkTargetForRegenerate([u("u1"), a("a1")], "a1")).toBe("u1")
  })
  it("skips back over intervening assistant messages", () => {
    expect(forkTargetForRegenerate([u("u1"), a("a1"), a("a2")], "a2")).toBe("u1")
  })
  it("returns null when there is no preceding user message", () => {
    expect(forkTargetForRegenerate([a("a1")], "a1")).toBeNull()
  })
  it("returns null when the assistant id isn't found", () => {
    expect(forkTargetForRegenerate([u("u1"), a("a1")], "gone")).toBeNull()
  })
})
