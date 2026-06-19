import { afterEach, describe, expect, test } from "bun:test"

import { hasSandboxConfig } from "./config"
import { selectSandbox } from "./select-sandbox"

const orig = process.env.CODE_SANDBOX_BASE_URL
afterEach(() => {
  if (orig === undefined) delete process.env.CODE_SANDBOX_BASE_URL
  else process.env.CODE_SANDBOX_BASE_URL = orig
})

describe("selectSandbox / hasSandboxConfig", () => {
  test("no base URL → null + gate false", () => {
    delete process.env.CODE_SANDBOX_BASE_URL
    expect(hasSandboxConfig()).toBe(false)
    expect(selectSandbox()).toBeNull()
  })
  test("base URL set → a CodeSandbox + gate true", () => {
    process.env.CODE_SANDBOX_BASE_URL = "http://localhost:5555"
    expect(hasSandboxConfig()).toBe(true)
    const sb = selectSandbox()
    expect(sb).not.toBeNull()
    expect(typeof sb?.run).toBe("function")
  })
})
