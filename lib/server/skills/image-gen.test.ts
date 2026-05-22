import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { imageGenSkill, isImageGenConfigured } from "./image-gen"

const ORIGINAL_KEY = process.env.MINIMAX_CN_API_KEY

beforeEach(() => {
  delete process.env.MINIMAX_CN_API_KEY
})
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.MINIMAX_CN_API_KEY
  else process.env.MINIMAX_CN_API_KEY = ORIGINAL_KEY
})

describe("isImageGenConfigured", () => {
  test("false when MINIMAX_CN_API_KEY is unset", () => {
    expect(isImageGenConfigured()).toBe(false)
  })
  test("true when MINIMAX_CN_API_KEY is set", () => {
    process.env.MINIMAX_CN_API_KEY = "test"
    expect(isImageGenConfigured()).toBe(true)
  })
})

describe("imageGenSkill registry entry", () => {
  test("has the expected id + toolName", () => {
    expect(imageGenSkill.id).toBe("imageGen")
    expect(imageGenSkill.toolName).toBe("generateImage")
  })
})

describe("imageGenSkill.buildTool", () => {
  test("returns null when env is missing", () => {
    const tool = imageGenSkill.buildTool(undefined, {})
    expect(tool).toBeNull()
  })

  test("returns a Tool when env is set", () => {
    process.env.MINIMAX_CN_API_KEY = "test"
    const tool = imageGenSkill.buildTool(undefined, {})
    expect(tool).not.toBeNull()
  })

  test("returns a Tool whose description mentions the configured cap", () => {
    process.env.MINIMAX_CN_API_KEY = "test"
    const tool = imageGenSkill.buildTool(
      { id: "imageGen", imageGenConfig: { maxCalls: 3 } },
      {}
    ) as { description: string } | null
    expect(tool).not.toBeNull()
    expect(tool!.description).toContain("3 calls per turn")
  })
})

describe("imageGenSkill.promptFragment", () => {
  test("returns the 'not configured' note when env is missing", () => {
    const note = imageGenSkill.promptFragment(undefined)
    expect(note).not.toBeNull()
    expect(note).toContain("MINIMAX_CN_API_KEY")
    expect(note).toContain("cannot actually generate images")
  })

  test("returns the model-facing description when env is set", () => {
    process.env.MINIMAX_CN_API_KEY = "test"
    const note = imageGenSkill.promptFragment(undefined)
    expect(note).not.toBeNull()
    expect(note).toContain("generateImage")
    expect(note).toContain("HARD LIMIT")
    // Default aspect ratio surfaces in the prompt
    expect(note).toContain("1:1")
  })

  test("reflects a custom cap from the request entry", () => {
    process.env.MINIMAX_CN_API_KEY = "test"
    const note = imageGenSkill.promptFragment({
      id: "imageGen",
      imageGenConfig: { maxCalls: 4 },
    })
    expect(note).toContain("4 calls per turn")
  })

  test("reflects a custom aspect ratio from the request entry", () => {
    process.env.MINIMAX_CN_API_KEY = "test"
    const note = imageGenSkill.promptFragment({
      id: "imageGen",
      imageGenConfig: { aspectRatio: "16:9" },
    })
    expect(note).toContain("Default aspect ratio is 16:9")
  })
})
