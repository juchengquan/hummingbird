import { describe, expect, test } from "bun:test"

import { renderMemoryBlock } from "./render"

describe("renderMemoryBlock", () => {
  test("empty → null", () => {
    expect(renderMemoryBlock([])).toBeNull()
  })
  test("renders a labelled bullet block the user is told they can edit", () => {
    const out = renderMemoryBlock([
      { fact: "Runs Postgres 16", category: "stack" },
      { fact: "Terse answers", category: "preference" },
    ])
    expect(out).toContain("edit")
    expect(out).toContain("- Runs Postgres 16")
    expect(out).toContain("- Terse answers")
  })
  test("facts with no category still render", () => {
    expect(renderMemoryBlock([{ fact: "solo", category: null }])).toContain("- solo")
  })
})
