import { describe, expect, test } from "bun:test"

import { runMigrations } from "./migrate"

/**
 * Representative coverage of the persisted-state migration chain
 * (PLAN-store-slice-split). Full coverage of all 19 steps isn't the goal
 * — these guard the transforms most likely to silently lose user data if
 * the extracted `runMigrations` ever drifts from the original inline
 * `migrate`.
 */
describe("runMigrations", () => {
  test("returns non-objects untouched", () => {
    expect(runMigrations(null, 0)).toBeNull()
    expect(runMigrations("nope", 0)).toBe("nope")
  })

  test("v<2 drops the retired panel keys", () => {
    const out = runMigrations(
      { theme: "dark", chatPanelOpen: true, editorPanelWidth: 300 },
      1
    ) as Record<string, unknown>
    expect(out.theme).toBe("dark")
    expect("chatPanelOpen" in out).toBe(false)
    expect("editorPanelWidth" in out).toBe(false)
  })

  test("v<3 backfills selectedFileIds on conversations", () => {
    const out = runMigrations(
      { conversations: [{ id: "a" }, { id: "b", selectedFileIds: ["keep"] }] },
      2
    ) as { conversations: Array<{ id: string; selectedFileIds: string[] }> }
    expect(out.conversations[0].selectedFileIds).toEqual([])
    expect(out.conversations[1].selectedFileIds).toEqual(["keep"])
  })

  test("v<13 backfills workspace.position by array index", () => {
    const out = runMigrations(
      { workspaces: [{ id: "a" }, { id: "b" }, { id: "c", position: 9 }] },
      12
    ) as { workspaces: Array<{ id: string; position: number }> }
    expect(out.workspaces.map((w) => w.position)).toEqual([0, 1, 9])
  })

  test("v<17/18 seed empty MCP + URL-bookmark slices", () => {
    const out = runMigrations({}, 16) as Record<string, unknown>
    expect(out.mcpServers).toEqual([])
    expect(out.mcpResources).toEqual([])
    expect(out.mcpResourceBindings).toEqual([])
    expect(out.conversationMcpResources).toEqual([])
    expect(out.urlBookmarks).toEqual([])
    expect(out.conversationUrlBookmarks).toEqual([])
  })

  test("v<19 folds webSearchMaxCalls into webSearchConfig.maxCalls", () => {
    const out = runMigrations(
      {
        workspaces: [{ id: "w", webSearchMaxCalls: 5 }],
        conversations: [
          { id: "c", webSearchConfig: { maxCalls: 2 }, webSearchMaxCalls: 9 },
        ],
      },
      18
    ) as {
      workspaces: Array<Record<string, unknown>>
      conversations: Array<Record<string, unknown>>
    }
    // Workspace: legacy flat number folded in.
    expect(out.workspaces[0].webSearchConfig).toEqual({ maxCalls: 5 })
    expect("webSearchMaxCalls" in out.workspaces[0]).toBe(false)
    // Conversation: existing config.maxCalls wins; legacy field dropped.
    expect(
      (out.conversations[0].webSearchConfig as { maxCalls: number }).maxCalls
    ).toBe(2)
    expect("webSearchMaxCalls" in out.conversations[0]).toBe(false)
  })

  test("v<19 folds skillPrefs.webSearchBrave=false into config", () => {
    const out = runMigrations(
      { workspaces: [{ id: "w", skillPrefs: { webSearchBrave: false } }] },
      18
    ) as { workspaces: Array<Record<string, unknown>> }
    const ws = out.workspaces[0]
    expect((ws.webSearchConfig as { brave: { enabled: boolean } }).brave.enabled).toBe(
      false
    )
    expect("webSearchBrave" in (ws.skillPrefs as Record<string, unknown>)).toBe(false)
  })
})

describe("v<22 — Conversation.systemPrompt added", () => {
  test("backfills empty systemPrompt on conversations missing it", () => {
    const out = runMigrations(
      {
        conversations: [
          { id: "c1", title: "old" },
          { id: "c2", title: "newer", systemPrompt: "already set" },
        ],
      },
      21,
    ) as { conversations: Array<Record<string, unknown>> }
    expect(out.conversations[0].systemPrompt).toBe("")
    expect(out.conversations[1].systemPrompt).toBe("already set")
  })

  test("survives missing or non-array conversations field", () => {
    expect(() => runMigrations({}, 21)).not.toThrow()
    expect(() => runMigrations({ conversations: null }, 21)).not.toThrow()
  })
})

describe("v<23 — Conversation.fileRetrievalModes added", () => {
  test("seeds empty fileRetrievalModes on conversations missing it", () => {
    const out = runMigrations(
      {
        conversations: [
          { id: "c1", title: "old" },
          {
            id: "c2",
            title: "newer",
            fileRetrievalModes: { "file-A": "rag" },
          },
        ],
      },
      22,
    ) as { conversations: Array<Record<string, unknown>> }
    expect(out.conversations[0].fileRetrievalModes).toEqual({})
    expect(out.conversations[1].fileRetrievalModes).toEqual({
      "file-A": "rag",
    })
  })

  test("repairs malformed (non-object / array) fileRetrievalModes", () => {
    const out = runMigrations(
      {
        conversations: [
          { id: "c1", fileRetrievalModes: null },
          { id: "c2", fileRetrievalModes: [1, 2, 3] },
        ],
      },
      22,
    ) as { conversations: Array<Record<string, unknown>> }
    expect(out.conversations[0].fileRetrievalModes).toEqual({})
    expect(out.conversations[1].fileRetrievalModes).toEqual({})
  })
})

describe("v<26 — editorPrefs.inlineComplete added", () => {
  test("backfills inlineComplete:false when missing", () => {
    const out = runMigrations(
      { editorPrefs: { aiReviewChanges: true } },
      25,
    ) as { editorPrefs: Record<string, unknown> }
    expect(out.editorPrefs.aiReviewChanges).toBe(true)
    expect(out.editorPrefs.inlineComplete).toBe(false)
  })

  test("preserves an existing inlineComplete value", () => {
    const out = runMigrations(
      { editorPrefs: { aiReviewChanges: false, inlineComplete: true } },
      25,
    ) as { editorPrefs: Record<string, unknown> }
    expect(out.editorPrefs.inlineComplete).toBe(true)
    expect(out.editorPrefs.aiReviewChanges).toBe(false)
  })

  test("no-op when editorPrefs is missing entirely", () => {
    expect(() => runMigrations({}, 25)).not.toThrow()
  })

  test("repairs a non-object editorPrefs by leaving it alone (defensive)", () => {
    // Defensive: a malformed prefs blob (e.g. null) shouldn't crash
    // the migration step. The slice initial value covers the user.
    expect(() =>
      runMigrations({ editorPrefs: null }, 25)
    ).not.toThrow()
  })
})
