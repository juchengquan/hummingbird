import { describe, expect, test } from "bun:test"

import { useStore } from "@/client/hooks/use-store"

describe("updateArtifactStoragePath", () => {
  test("replaces the artifact's storagePath", () => {
    const conv = useStore.getState().createConversation()
    const art = useStore.getState().createArtifact({
      conversationId: conv.id,
      kind: "file",
      title: "a.csv",
      content: "",
      storagePath: "https://old",
    })
    useStore.getState().updateArtifactStoragePath(art.id, "https://fresh")
    const got = useStore.getState().artifacts.find((a) => a.id === art.id)
    expect(got?.storagePath).toBe("https://fresh")
  })

  test("no-ops on an unknown artifact id", () => {
    const conv = useStore.getState().createConversation()
    const art = useStore.getState().createArtifact({
      conversationId: conv.id,
      kind: "file",
      title: "b.csv",
      content: "",
      storagePath: "https://keep",
    })
    useStore.getState().updateArtifactStoragePath("nope", "https://fresh")
    const got = useStore.getState().artifacts.find((a) => a.id === art.id)
    expect(got?.storagePath).toBe("https://keep")
  })
})
