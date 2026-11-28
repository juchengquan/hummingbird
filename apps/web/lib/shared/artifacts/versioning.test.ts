import { describe, expect, it } from "bun:test"

import type { ArtifactVersion } from "@/shared/types"
import { MAX_ARTIFACT_VERSIONS, pushArtifactVersion } from "./versioning"

const v = (id: string): ArtifactVersion => ({
  id,
  content: id,
  createdAt: new Date("2026-01-01T00:00:00Z"),
})

describe("pushArtifactVersion", () => {
  it("appends to the end (oldest→newest)", () => {
    expect(pushArtifactVersion([v("a")], v("b")).map((x) => x.id)).toEqual(["a", "b"])
  })
  it("treats undefined as an empty list", () => {
    expect(pushArtifactVersion(undefined, v("a")).map((x) => x.id)).toEqual(["a"])
  })
  it("caps at the limit, dropping the oldest", () => {
    const seed = Array.from({ length: MAX_ARTIFACT_VERSIONS }, (_, i) => v(`v${i}`))
    const out = pushArtifactVersion(seed, v("new"))
    expect(out).toHaveLength(MAX_ARTIFACT_VERSIONS)
    expect(out[0].id).toBe("v1") // v0 dropped
    expect(out[out.length - 1].id).toBe("new")
  })
  it("respects an explicit cap arg", () => {
    const out = pushArtifactVersion([v("a"), v("b")], v("c"), 2)
    expect(out.map((x) => x.id)).toEqual(["b", "c"])
  })
})
