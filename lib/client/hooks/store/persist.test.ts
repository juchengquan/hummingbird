import { describe, expect, test } from "bun:test"

import type { AppState } from "../use-store"
import { partializeState } from "./persist"
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
    expect("editorReloadToken" in persisted).toBe(false)
  })

  test("STORE_VERSION is pinned (bump only with a migration step)", () => {
    expect(STORE_VERSION).toBe(31)
  })
})
