import { describe, expect, test } from "bun:test"

import {
  collectPendingSuggestionIds,
  type SuggestionEntry,
} from "./reject-remaining-ai-suggestions"

describe("collectPendingSuggestionIds", () => {
  test("empty input → empty output", () => {
    expect(collectPendingSuggestionIds([])).toEqual([])
  })

  test("entries with no ids → empty output", () => {
    const entries: SuggestionEntry[] = [
      { nodeId: null, dataIds: [] },
      { nodeId: null, dataIds: [] },
    ]
    expect(collectPendingSuggestionIds(entries)).toEqual([])
  })

  test("single block-level id", () => {
    expect(
      collectPendingSuggestionIds([{ nodeId: "abc", dataIds: [] }])
    ).toEqual(["abc"])
  })

  test("single text-mark id", () => {
    expect(
      collectPendingSuggestionIds([{ nodeId: null, dataIds: ["mark-1"] }])
    ).toEqual(["mark-1"])
  })

  test("dedups ids across entries (same suggestion spans multiple nodes)", () => {
    const entries: SuggestionEntry[] = [
      { nodeId: "same", dataIds: [] },
      { nodeId: "same", dataIds: [] },
      { nodeId: null, dataIds: ["same"] },
    ]
    expect(collectPendingSuggestionIds(entries)).toEqual(["same"])
  })

  test("preserves first-seen order — important for Tab-through navigation", () => {
    const entries: SuggestionEntry[] = [
      { nodeId: "c", dataIds: [] },
      { nodeId: "a", dataIds: [] },
      { nodeId: "b", dataIds: [] },
    ]
    expect(collectPendingSuggestionIds(entries)).toEqual(["c", "a", "b"])
  })

  test("mixes block-level + text-mark ids on the same entry", () => {
    const entries: SuggestionEntry[] = [
      { nodeId: "block-1", dataIds: ["mark-a", "mark-b"] },
    ]
    expect(collectPendingSuggestionIds(entries)).toEqual([
      "block-1",
      "mark-a",
      "mark-b",
    ])
  })

  test("filters empty / falsy ids without crashing", () => {
    const entries: SuggestionEntry[] = [
      { nodeId: "", dataIds: ["valid"] },
      { nodeId: "ok", dataIds: [""] },
    ]
    expect(collectPendingSuggestionIds(entries)).toEqual(["valid", "ok"])
  })

  test("returns ids in document order across multiple entries", () => {
    const entries: SuggestionEntry[] = [
      { nodeId: null, dataIds: ["1", "2"] },
      { nodeId: "3", dataIds: ["4"] },
      { nodeId: null, dataIds: ["5", "1"] }, // 1 is a repeat — skipped
    ]
    expect(collectPendingSuggestionIds(entries)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ])
  })
})
