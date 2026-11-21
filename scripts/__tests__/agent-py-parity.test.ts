import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, test } from "bun:test"

import { allOutputs, serialize } from "../gen-agent-py-parity"

// agent-py ports TS logic (chunker, memory prompt + merge, CSP report
// sanitising, `renderUI`'s props schemas) and pins its ports to fixtures
// generated from the TS originals. If a TS original changes, this fails until the fixtures are
// regenerated — and agent-py's parity tests then force the port to follow.
describe("agent-py parity fixtures", () => {
  for (const { file, value } of allOutputs()) {
    test(`${path.basename(file)} is up to date (bun run codegen:agent-py-parity)`, () => {
      const current = readFileSync(file, "utf8")
      expect(current === serialize(value)).toBe(true)
    })
  }
})
