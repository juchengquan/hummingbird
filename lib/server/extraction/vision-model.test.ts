import { describe, expect, test } from "bun:test"

import type { ChatModel } from "@/shared/models"
import { resolveVisionModel } from "./vision-model"

const MODELS = [
  { id: "text/only", label: "t", provider: "p", contextWindow: 1, routes: [{ via: "gateway" }] },
  { id: "vis/a", label: "a", provider: "p", contextWindow: 1, routes: [{ via: "gateway" }], supportsVision: true },
  { id: "vis/b", label: "b", provider: "p", contextWindow: 1, routes: [{ via: "gateway" }], supportsVision: true },
] as unknown as ChatModel[]

describe("resolveVisionModel", () => {
  test("env override that is vision-capable wins", () => {
    expect(resolveVisionModel(MODELS, { VISION_MODEL: "vis/b" })).toBe("vis/b")
  })
  test("env override that is NOT vision-capable is ignored → first flagged", () => {
    expect(resolveVisionModel(MODELS, { VISION_MODEL: "text/only" })).toBe("vis/a")
  })
  test("no override → first vision-capable model", () => {
    expect(resolveVisionModel(MODELS, {})).toBe("vis/a")
  })
  test("no vision-capable models → null", () => {
    const textOnly = [MODELS[0]] as ChatModel[]
    expect(resolveVisionModel(textOnly, {})).toBeNull()
  })
})
