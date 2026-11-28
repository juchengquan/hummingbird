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

describe("clearMessageOutput", () => {
  test("clears a turn's output, keeps the message itself", () => {
    const conv = useStore.getState().createConversation()
    const msg = useStore.getState().addMessage({ role: "assistant", content: "" }, conv.id)
    const s = useStore.getState()
    s.appendToMessage(msg.id, "partial")
    s.appendToMessageReasoning(msg.id, "thinking")
    s.setMessageReasoningDuration(msg.id, 5)
    s.setMessageToolCalls(msg.id, [{ id: "t1", name: "webSearch", summary: "1 result" }])
    s.setMessageSuggestions(msg.id, ["more?"])
    s.setMessageRoutedModel(msg.id, "m")
    s.appendMessageGeneratedFiles(msg.id, [
      { id: "f1", name: "a", sizeBytes: 1, mimeType: "text/plain", url: "data:,", storagePath: null },
    ])
    s.setMessageError(msg.id, { code: "network" })
    s.clearMessageOutput(msg.id)
    const got = useStore.getState().conversations
      .find((c) => c.id === conv.id)?.messages
      .find((m) => m.id === msg.id)
    expect(got).toEqual({ id: msg.id, role: "assistant", content: "", timestamp: msg.timestamp })
  })
})

describe("addMessageWithId (a task's result, Q70)", () => {
  test("writes under the given id into the named conversation, once", () => {
    const conv = useStore.getState().createConversation()
    const id = "5d2c8a2e-0000-5000-8000-000000000001"
    const first = useStore.getState().addMessageWithId(id, { role: "assistant", content: "Result" }, conv.id)
    const again = useStore.getState().addMessageWithId(id, { role: "assistant", content: "Other" }, conv.id)
    expect(first?.id).toBe(id)
    expect(again).toBe(first)
    const messages = useStore.getState().conversations.find((c) => c.id === conv.id)!.messages
    expect(messages.filter((m) => m.id === id).map((m) => m.content)).toEqual(["Result"])
  })

  test("a conversation that isn't there gets nothing (no fallback to the active one)", () => {
    const active = useStore.getState().createConversation()
    useStore.getState().setActiveConversation(active.id)
    const before = useStore.getState().conversations.find((c) => c.id === active.id)!.messages.length
    const out = useStore
      .getState()
      .addMessageWithId("5d2c8a2e-0000-5000-8000-000000000002", { role: "assistant", content: "x" }, "deleted-conv")
    expect(out).toBeNull()
    expect(useStore.getState().conversations.find((c) => c.id === active.id)!.messages.length).toBe(before)
  })
})

describe("createDocumentWithId / createArtifactWithId", () => {
  test("idempotent on the id", () => {
    const conv = useStore.getState().createConversation()
    const s = useStore.getState()
    const doc = s.createDocumentWithId("doc-derived-1", conv.workspaceId, "Report", "body")
    expect(useStore.getState().createDocumentWithId("doc-derived-1", conv.workspaceId, "Other", "x")).toBe(doc)
    expect(useStore.getState().documents.filter((d) => d.id === "doc-derived-1")).toHaveLength(1)
    const art = s.createArtifactWithId("art-derived-1", { conversationId: conv.id, kind: "markdown", title: "R", content: "b" })
    expect(art.workspaceId).toBe(conv.workspaceId)
    expect(useStore.getState().createArtifactWithId("art-derived-1", { conversationId: conv.id, kind: "markdown", content: "c" })).toBe(art)
    expect(useStore.getState().artifacts.filter((a) => a.id === "art-derived-1")).toHaveLength(1)
  })
})
