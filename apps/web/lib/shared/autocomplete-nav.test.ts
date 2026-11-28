import { describe, expect, test } from "bun:test"

import { navigateAutocomplete } from "./autocomplete-nav"

describe("navigateAutocomplete", () => {
  test("ArrowDown advances and wraps at the end", () => {
    expect(navigateAutocomplete("ArrowDown", 3, 0)).toEqual({
      kind: "move",
      index: 1,
    })
    expect(navigateAutocomplete("ArrowDown", 3, 2)).toEqual({
      kind: "move",
      index: 0,
    })
  })

  test("ArrowUp retreats and wraps at the start", () => {
    expect(navigateAutocomplete("ArrowUp", 3, 2)).toEqual({
      kind: "move",
      index: 1,
    })
    expect(navigateAutocomplete("ArrowUp", 3, 0)).toEqual({
      kind: "move",
      index: 2,
    })
  })

  test("Enter and Tab pick the active row", () => {
    expect(navigateAutocomplete("Enter", 3, 1)).toEqual({ kind: "pick" })
    expect(navigateAutocomplete("Tab", 3, 1)).toEqual({ kind: "pick" })
  })

  test("Escape dismisses", () => {
    expect(navigateAutocomplete("Escape", 3, 1)).toEqual({ kind: "dismiss" })
  })

  test("unhandled keys pass through (no preventDefault)", () => {
    expect(navigateAutocomplete("a", 3, 1)).toEqual({ kind: "passthrough" })
    expect(navigateAutocomplete("Backspace", 3, 1)).toEqual({
      kind: "passthrough",
    })
  })

  test("an empty menu passes everything through", () => {
    expect(navigateAutocomplete("ArrowDown", 0, 0)).toEqual({
      kind: "passthrough",
    })
    expect(navigateAutocomplete("Enter", 0, 0)).toEqual({
      kind: "passthrough",
    })
  })
})
