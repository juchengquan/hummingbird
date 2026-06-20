import { afterEach, describe, expect, test } from "bun:test"

import { hasSandboxConfig } from "./config"
import { selectSandbox } from "./select-sandbox"

const origUrl = process.env.CODE_SANDBOX_BASE_URL
const origEnabled = process.env.CODE_SANDBOX_ENABLED
function restore(key: string, val: string | undefined) {
  if (val === undefined) delete process.env[key]
  else process.env[key] = val
}
afterEach(() => {
  restore("CODE_SANDBOX_BASE_URL", origUrl)
  restore("CODE_SANDBOX_ENABLED", origEnabled)
})

describe("selectSandbox / hasSandboxConfig", () => {
  test("nothing set → null + gate false", () => {
    delete process.env.CODE_SANDBOX_BASE_URL
    delete process.env.CODE_SANDBOX_ENABLED
    expect(hasSandboxConfig()).toBe(false)
    expect(selectSandbox()).toBeNull()
  })
  test("CODE_SANDBOX_ENABLED=1 → a CodeSandbox + gate true", () => {
    delete process.env.CODE_SANDBOX_BASE_URL
    process.env.CODE_SANDBOX_ENABLED = "1"
    expect(hasSandboxConfig()).toBe(true)
    const sb = selectSandbox()
    expect(sb).not.toBeNull()
    expect(typeof sb?.run).toBe("function")
  })
  test("CODE_SANDBOX_ENABLED with a falsy value → gate false", () => {
    delete process.env.CODE_SANDBOX_BASE_URL
    process.env.CODE_SANDBOX_ENABLED = "0"
    expect(hasSandboxConfig()).toBe(false)
  })
  test("CODE_SANDBOX_BASE_URL still enables it (back-compat)", () => {
    delete process.env.CODE_SANDBOX_ENABLED
    process.env.CODE_SANDBOX_BASE_URL = "http://localhost:5555"
    expect(hasSandboxConfig()).toBe(true)
    expect(selectSandbox()).not.toBeNull()
  })
})
