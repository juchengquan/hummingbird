import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { refuseStaleRootEnv, staleRootEnv } from "../root-env"

let dir = ""
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ""
})
const root = () => (dir = mkdtempSync(join(tmpdir(), "root-env-")))

describe("a root .env from before the split (Q155)", () => {
  test("none → fine", () => {
    const r = root()
    writeFileSync(join(r, ".env.example"), "") // an example is not a settings file
    expect(staleRootEnv(r)).toBeNull()
    expect(() => refuseStaleRootEnv(r)).not.toThrow()
  })

  for (const name of [".env", ".env.local"]) {
    test(`${name} → refused, naming env:split`, () => {
      const r = root()
      writeFileSync(join(r, name), "ANTHROPIC_API_KEY=x\n")
      expect(staleRootEnv(r)).toBe(join(r, name))
      expect(() => refuseStaleRootEnv(r)).toThrow(/bun run env:split/)
    })
  }

  test("the message names the file, never its contents", () => {
    const r = root()
    writeFileSync(join(r, ".env"), "ANTHROPIC_API_KEY=sk-secret\n")
    expect(() => refuseStaleRootEnv(r)).toThrow(/^(?!.*sk-secret).*\.env is no longer read/)
  })
})
