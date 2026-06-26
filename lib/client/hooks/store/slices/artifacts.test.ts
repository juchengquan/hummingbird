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

describe("artifact versioning", () => {
  test("updateArtifactContent captures the prior content as a version", () => {
    const conv = useStore.getState().createConversation()
    const art = useStore.getState().createArtifact({
      conversationId: conv.id, kind: "markdown", title: "doc", content: "v1",
    })
    useStore.getState().updateArtifactContent(art.id, "v2")
    const got = useStore.getState().artifacts.find((a) => a.id === art.id)
    expect(got?.content).toBe("v2")
    expect(got?.versions?.map((v) => v.content)).toEqual(["v1"])
  })

  test("no version captured when content is unchanged", () => {
    const conv = useStore.getState().createConversation()
    const art = useStore.getState().createArtifact({
      conversationId: conv.id, kind: "markdown", title: "doc", content: "same",
    })
    useStore.getState().updateArtifactContent(art.id, "same")
    const got = useStore.getState().artifacts.find((a) => a.id === art.id)
    expect(got?.versions ?? []).toEqual([])
  })

  test("restoreArtifactVersion swaps content and captures the prior current", () => {
    const conv = useStore.getState().createConversation()
    const art = useStore.getState().createArtifact({
      conversationId: conv.id, kind: "markdown", title: "doc", content: "v1",
    })
    useStore.getState().updateArtifactContent(art.id, "v2") // versions: [v1], content v2
    const v1Id = useStore.getState().artifacts.find((a) => a.id === art.id)!.versions![0].id
    useStore.getState().restoreArtifactVersion(art.id, v1Id)
    const got = useStore.getState().artifacts.find((a) => a.id === art.id)
    expect(got?.content).toBe("v1")
    // restoring captured the prior current ("v2") as a new version
    expect(got?.versions?.map((v) => v.content)).toEqual(["v1", "v2"])
  })

  test("restoreArtifactVersion no-ops on an unknown version id", () => {
    const conv = useStore.getState().createConversation()
    const art = useStore.getState().createArtifact({
      conversationId: conv.id, kind: "markdown", title: "doc", content: "v1",
    })
    useStore.getState().restoreArtifactVersion(art.id, "nope")
    const got = useStore.getState().artifacts.find((a) => a.id === art.id)
    expect(got?.content).toBe("v1")
  })
})
