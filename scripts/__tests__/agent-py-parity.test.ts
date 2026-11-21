import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, test } from "bun:test"

import { buildFixtures, FIXTURE_DIR, serialize } from "../gen-agent-py-parity"

// agent-py ports TS logic (chunker, memory prompt + merge, CSP report
// sanitising) and pins its ports to fixtures generated from the TS
// originals. If a TS original changes, this fails until the fixtures are
// regenerated — and agent-py's parity tests then force the port to follow.
describe("agent-py parity fixtures", () => {
  for (const [name, value] of Object.entries(buildFixtures())) {
    test(`${name} is up to date (bun run codegen:agent-py-parity)`, () => {
      const current = readFileSync(path.join(FIXTURE_DIR, name), "utf8")
      expect(current === serialize(value)).toBe(true)
    })
  }
})
