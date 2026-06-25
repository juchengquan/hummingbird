import { describe, expect, test } from "bun:test"
import { useStore } from "@/client/hooks/use-store"
import type { GeneratedFile } from "@/shared/types"

describe("appendMessageGeneratedFiles", () => {
  test("appends files to the target message", () => {
    const conv = useStore.getState().createConversation()
    const msg = useStore.getState().addMessage({ role: "assistant", content: "" }, conv.id)
    const file: GeneratedFile = {
      id: "f1", name: "report.csv", sizeBytes: 12,
      mimeType: "text/csv", url: "data:text/csv;base64,AAAA", storagePath: null,
    }
    useStore.getState().appendMessageGeneratedFiles(msg.id, [file])
    const updated = useStore
      .getState()
      .conversations.find((c) => c.id === conv.id)
      ?.messages.find((m) => m.id === msg.id)
    expect(updated?.generatedFiles).toEqual([file])
  })

  test("appends (does not replace) when called twice", () => {
    const conv = useStore.getState().createConversation()
    const msg = useStore.getState().addMessage({ role: "assistant", content: "" }, conv.id)
    const f = (id: string): GeneratedFile => ({ id, name: id, sizeBytes: 1, mimeType: "text/plain", url: "data:,", storagePath: null })
    useStore.getState().appendMessageGeneratedFiles(msg.id, [f("a")])
    useStore.getState().appendMessageGeneratedFiles(msg.id, [f("b")])
    const updated = useStore.getState().conversations.find((c) => c.id === conv.id)?.messages.find((m) => m.id === msg.id)
    expect(updated?.generatedFiles?.map((x) => x.id)).toEqual(["a", "b"])
  })
})

describe("updateMessageGeneratedFileUrl", () => {
  test("replaces the url of the matching file", () => {
    const conv = useStore.getState().createConversation()
    const msg = useStore.getState().addMessage({ role: "assistant", content: "" }, conv.id)
    const file = {
      id: "f1", name: "a.csv", sizeBytes: 1, mimeType: "text/csv",
      url: "https://old", storagePath: "u/generated/f1-a.csv",
    }
    useStore.getState().appendMessageGeneratedFiles(msg.id, [file])
    useStore.getState().updateMessageGeneratedFileUrl(msg.id, "f1", "https://fresh")
    const got = useStore.getState().conversations
      .find((c) => c.id === conv.id)?.messages
      .find((m) => m.id === msg.id)?.generatedFiles?.[0]
    expect(got?.url).toBe("https://fresh")
    expect(got?.storagePath).toBe("u/generated/f1-a.csv")
  })

  test("no-ops on an unknown file id", () => {
    const conv = useStore.getState().createConversation()
    const msg = useStore.getState().addMessage({ role: "assistant", content: "" }, conv.id)
    const file = {
      id: "f1", name: "a.csv", sizeBytes: 1, mimeType: "text/csv",
      url: "https://old", storagePath: null,
    }
    useStore.getState().appendMessageGeneratedFiles(msg.id, [file])
    useStore.getState().updateMessageGeneratedFileUrl(msg.id, "nope", "https://fresh")
    const got = useStore.getState().conversations
      .find((c) => c.id === conv.id)?.messages
      .find((m) => m.id === msg.id)?.generatedFiles?.[0]
    expect(got?.url).toBe("https://old")
  })
})
