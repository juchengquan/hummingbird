import { describe, expect, test } from "bun:test"

import { useStore } from "@/client/hooks/use-store"
import { computeSyncOps, type SyncSnapshot } from "@/client/sync/compute-sync-ops"

describe("deleteWorkspace cascade — prompts / agents / user skills", () => {
  test("drops the workspace's rows, keeps others', and unpins its active agent", () => {
    const s = useStore.getState()
    const keep = s.createWorkspace("keep")
    const doomed = s.createWorkspace("doomed")

    const keptPrompt = s.createPrompt({ workspaceId: keep.id, name: "k", template: "k" })
    const doomedPrompt = s.createPrompt({ workspaceId: doomed.id, name: "d", template: "d" })
    const keptAgent = s.createAgent({ workspaceId: keep.id, name: "ka" })
    const doomedAgent = s.createAgent({ workspaceId: doomed.id, name: "da" })
    const keptSkill = s.createUserSkill({ workspaceId: keep.id, name: "ks" })
    const doomedSkill = s.createUserSkill({ workspaceId: doomed.id, name: "ds" })
    s.setActiveAgent(doomedAgent.id)

    const before = useStore.getState()
    useStore.getState().deleteWorkspace(doomed.id)
    const after = useStore.getState()

    const promptIds = after.prompts.map((p) => p.id)
    expect(promptIds).toContain(keptPrompt.id)
    expect(promptIds).not.toContain(doomedPrompt.id)
    const agentIds = after.agents.map((a) => a.id)
    expect(agentIds).toContain(keptAgent.id)
    expect(agentIds).not.toContain(doomedAgent.id)
    const skillIds = after.userSkills.map((x) => x.id)
    expect(skillIds).toContain(keptSkill.id)
    expect(skillIds).not.toContain(doomedSkill.id)
    expect(after.activeAgentId).toBeNull()

    // The cloud-sync diff turns the removed prompt into a delete op.
    const ops = computeSyncOps(
      before as unknown as SyncSnapshot,
      after as unknown as SyncSnapshot,
      new Set(),
      new Map()
    )
    expect(
      ops.some(
        (op) =>
          op.kind === "delete" &&
          op.target === "prompts" &&
          op.where.value === doomedPrompt.id
      )
    ).toBe(true)
  })

  test("an active agent from another workspace stays pinned", () => {
    const s = useStore.getState()
    const keep = s.createWorkspace("keep2")
    const doomed = s.createWorkspace("doomed2")
    const keptAgent = s.createAgent({ workspaceId: keep.id, name: "stay" })
    s.setActiveAgent(keptAgent.id)
    useStore.getState().deleteWorkspace(doomed.id)
    expect(useStore.getState().activeAgentId).toBe(keptAgent.id)
  })
})
