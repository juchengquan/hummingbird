import { describe, expect, test } from "bun:test"

import type { AppState } from "../use-store"
import { mergePersistedState, partializeState, reviveChatBackend } from "./persist"
import { STORE_VERSION } from "./migrate"

/**
 * The persisted-shape contract (PLAN-store-slice-split, hard constraint
 * #1). Users have months of data under `hummingbird-storage` at the
 * current `STORE_VERSION`. The slice split must not change which keys
 * persist or the version number without a matching migration step.
 *
 * This pins the exact set of persisted keys. If you add/remove a key to
 * `partializeState`, this test fails on purpose — update it together
 * with a `runMigrations` step and a `STORE_VERSION` bump.
 */
const EXPECTED_PERSISTED_KEYS = [
  "theme",
  "colorScheme",
  "activeView",
  "workspaces",
  "activeWorkspaceId",
  "resources",
  "conversationFiles",
  "mcpServers",
  "mcpResources",
  "mcpResourceBindings",
  "conversationMcpResources",
  "urlBookmarks",
  "conversationUrlBookmarks",
  "conversations",
  "activeConversationId",
  "files",
  "chatModel",
  "chatReasoningEffort",
  "customInstructionsAbout",
  "customInstructionsStyle",
  "memoryEnabled",
  "notes",
  "artifacts",
  "documents",
  "activeDocumentId",
  "resourcesSidebarOpen",
  "resourcesSidebarTab",
  "tasksPanelOpen",
  "sidebarWidth",
  "resourcesSidebarWidth",
  "editorPrefs",
  "localOnlyMode",
  "localFilesOnly",
  "verifyCitations",
  "chatBackend",
  "prompts",
  "agents",
  "activeAgentId",
  "userSkills",
  "projectTasks",
].sort()

describe("partializeState — frozen persisted shape", () => {
  test("persists exactly the expected key set", () => {
    // A sentinel value per persisted key plus a couple of runtime-only
    // keys that must NOT survive partialize.
    const fakeState = {
      theme: "dark",
      colorScheme: "default",
      activeView: "workspaces",
      workspaces: [],
      activeWorkspaceId: "default",
      resources: [],
      conversationFiles: [],
      mcpServers: [],
      mcpResources: [],
      mcpResourceBindings: [],
      conversationMcpResources: [],
      urlBookmarks: [],
      conversationUrlBookmarks: [],
      conversations: [],
      activeConversationId: null,
      files: [],
      chatModel: "x",
      chatReasoningEffort: null,
      customInstructionsAbout: "",
      customInstructionsStyle: "",
      memoryEnabled: false,
      notes: [],
      artifacts: [],
      documents: [],
      activeDocumentId: null,
      resourcesSidebarOpen: true,
      resourcesSidebarTab: "files",
      tasksPanelOpen: false,
      sidebarWidth: 256,
      resourcesSidebarWidth: 272,
      editorPrefs: { aiReviewChanges: true, inlineComplete: false },
      localOnlyMode: false,
      localFilesOnly: false,
      verifyCitations: false,
      chatBackend: "ts",
      prompts: [],
      agents: [],
      activeAgentId: null,
      userSkills: [],
      projectTasks: [],
      // Runtime-only — must be excluded:
      pendingChatInput: "leaked?",
      streamingContent: "leaked?",
      typingConversationIds: ["leaked?"],
      streamingConversationIds: ["leaked?"],
      pinnedExplanations: [{ id: "leaked?" }],
      pendingSelectionAction: { type: "quote", text: "leaked?" },
      editorReloadToken: 7,
      sessionModelOverridden: true,
    } as unknown as AppState

    const persisted = partializeState(fakeState)
    expect(Object.keys(persisted).sort()).toEqual(EXPECTED_PERSISTED_KEYS)

    // Spot-check the explicit exclusions.
    expect("pendingChatInput" in persisted).toBe(false)
    expect("pinnedExplanations" in persisted).toBe(false)
    expect("streamingContent" in persisted).toBe(false)
    expect("streamingConversationIds" in persisted).toBe(false)
    expect("editorReloadToken" in persisted).toBe(false)

    // `theme` must stay the FIRST key: the pre-paint theme script reads
    // it by prefix without parsing the blob (`shared/persisted-theme`).
    expect(Object.keys(persisted)[0]).toBe("theme")
  })

  test("STORE_VERSION is pinned (bump only with a migration step)", () => {
    // v32: file blob fields → IndexedDB. v33: inline `data:` URLs on
    // message generated images / files → IndexedDB (`hb-blob:` refs in
    // the persisted copy). v34: an image / file artifact's inline
    // `storagePath` → the same IndexedDB store (shared with its source
    // item). v35: `chatBackend` widened to `'python-runs'` ("agent-py
    // (runs)"). None of them changed the persisted KEY set.
    // v36: `chatBackend` may be persisted as null — unset, follow the
    // deploy (wave 11, Q110). Same key set.
    expect(STORE_VERSION).toBe(36)
  })

  test("v36: an unchosen backend persists as null and comes back as the deploy's default", () => {
    const empty = { conversations: [], files: [], artifacts: [] }
    const base = { ...empty, chatBackend: "python-runs", chatBackendExplicit: false } as unknown as AppState
    expect(partializeState(base).chatBackend).toBeNull()
    const chosen = { ...empty, chatBackend: "ts", chatBackendExplicit: true } as unknown as AppState
    expect(partializeState(chosen).chatBackend).toBe("ts")

    const unset = { chatBackend: null } as unknown as Record<string, unknown>
    reviveChatBackend(unset, true)
    expect(unset).toMatchObject({ chatBackend: "python-runs", chatBackendExplicit: false })
    const unsetNoAgentPy = { chatBackend: null } as unknown as Record<string, unknown>
    reviveChatBackend(unsetNoAgentPy, false)
    expect(unsetNoAgentPy).toMatchObject({ chatBackend: "ts", chatBackendExplicit: false })
    const explicit = { chatBackend: "ts" } as unknown as Record<string, unknown>
    reviveChatBackend(explicit, true)
    expect(explicit).toMatchObject({ chatBackend: "ts", chatBackendExplicit: true })
  })

  test("v34: artifact references persist only once IndexedDB confirms; inline values verbatim", () => {
    const img = "data:image/png;base64,AAAA"
    const artifacts = [
      { id: "a1", kind: "image", storagePath: img },
      { id: "a2", kind: "file", storagePath: "https://x.test/a.csv" },
      { id: "a3", kind: "code", storagePath: null },
      // A reference whose bytes this process doesn't hold: kept as-is.
      { id: "a4", kind: "image", storagePath: "hb-blob:m/i" },
    ]
    const persisted = partializeState({
      conversations: [],
      files: [],
      artifacts,
    } as unknown as AppState)
    // Nothing to inflate → the array passes through untouched.
    expect(persisted.artifacts).toBe(artifacts as unknown as AppState["artifacts"])
  })

  test("v33: message generated data: URLs persist verbatim until IndexedDB confirms them", () => {
    const img = "data:image/png;base64,AAAA"
    const conversations = [
      {
        id: "c",
        messages: [
          {
            id: "m",
            generatedImages: [{ id: "i", url: img }],
            generatedFiles: [{ id: "f", url: "https://x.test/a.csv" }],
          },
        ],
      },
    ]
    const persisted = partializeState({ conversations, files: [], artifacts: [] } as unknown as AppState)
    // Nothing is durable in this process → the array passes through untouched.
    expect(persisted.conversations).toBe(conversations as unknown as AppState["conversations"])
  })
})

describe("mergePersistedState (v36)", () => {
  const current = { chatBackend: "python-runs", chatBackendExplicit: false, theme: "dark" } as unknown as AppState

  test("nothing stored (a fresh browser): the in-memory default stays a default", () => {
    expect(mergePersistedState(undefined, current)).toBe(current)
  })

  test("a stored choice is explicit; a stored null follows the deploy", () => {
    const chosen = mergePersistedState({ chatBackend: "ts" }, current)
    expect([chosen.chatBackend, chosen.chatBackendExplicit, chosen.theme]).toEqual(["ts", true, "dark"])
    const unset = mergePersistedState({ chatBackend: null }, current)
    expect(unset.chatBackendExplicit).toBe(false)
  })
})
