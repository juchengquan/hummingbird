import { describe, expect, test } from "bun:test"
import type { Artifact } from "@/shared/types"

import {
  AUTO_ARCHIVE_MAX_PER_MESSAGE,
  AUTO_ARCHIVE_MIN_LINES,
  autoArchiveCodeBlocks,
} from "./auto-archive-code-blocks"

/** A stub `createArtifact` that records calls and synthesises a row.
 *  Mirrors the store mutator's signature closely enough that the
 *  helper's call shape is exercised. */
function makeStubCreate() {
  const calls: Array<Parameters<Parameters<typeof autoArchiveCodeBlocks>[1]>[0]> =
    []
  const fn = ((input) => {
    calls.push(input)
    const a: Artifact = {
      id: `art-${calls.length}`,
      workspaceId: "ws-1",
      conversationId: input.conversationId,
      messageId: input.messageId ?? null,
      kind: input.kind,
      language: input.language ?? null,
      title: input.title ?? "Untitled",
      content: input.content,
      storagePath: input.storagePath ?? null,
      pinned: false,
      createdAt: new Date(),
    }
    return a
  }) as Parameters<typeof autoArchiveCodeBlocks>[1]
  return { fn, calls }
}

function block(lang: string, lines: number, body = "x"): string {
  const lineArr = Array.from({ length: lines }, (_, i) => `${body}-${i}`)
  return ["```" + lang, ...lineArr, "```"].join("\n")
}

describe("autoArchiveCodeBlocks", () => {
  test("does nothing when there are no code blocks", () => {
    const { fn, calls } = makeStubCreate()
    const created = autoArchiveCodeBlocks(
      { content: "Just text, no code.", messageId: "m1", conversationId: "c1" },
      fn
    )
    expect(created).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test("archives a code block long enough to pass the line threshold", () => {
    const { fn, calls } = makeStubCreate()
    const created = autoArchiveCodeBlocks(
      {
        content: block("python", AUTO_ARCHIVE_MIN_LINES + 2),
        messageId: "m1",
        conversationId: "c1",
      },
      fn
    )
    expect(created).toHaveLength(1)
    expect(calls[0].language).toBe("python")
    expect(calls[0].kind).toBe("code")
    expect(calls[0].conversationId).toBe("c1")
    expect(calls[0].messageId).toBe("m1")
  })

  test("skips a short block whose language is not renderable", () => {
    const { fn } = makeStubCreate()
    const created = autoArchiveCodeBlocks(
      { content: block("python", 5), messageId: "m1", conversationId: "c1" },
      fn
    )
    expect(created).toEqual([])
  })

  test("archives a SHORT block when its language is renderable (jsx/tsx/html/svg/mermaid)", () => {
    const { fn, calls } = makeStubCreate()
    const created = autoArchiveCodeBlocks(
      {
        content: block("tsx", 6, "export const X = () => <div />"),
        messageId: "m1",
        conversationId: "c1",
      },
      fn
    )
    expect(created).toHaveLength(1)
    expect(calls[0].language).toBe("tsx")
  })

  test("caps the number of artifacts per message", () => {
    const longBlocks = Array.from(
      { length: AUTO_ARCHIVE_MAX_PER_MESSAGE + 2 },
      () => block("python", AUTO_ARCHIVE_MIN_LINES + 1)
    ).join("\n\n")
    const { fn, calls } = makeStubCreate()
    autoArchiveCodeBlocks(
      { content: longBlocks, messageId: "m1", conversationId: "c1" },
      fn
    )
    expect(calls).toHaveLength(AUTO_ARCHIVE_MAX_PER_MESSAGE)
  })

  test("json blocks get the `json` artifact kind, others get `code`", () => {
    const { fn, calls } = makeStubCreate()
    const content = [
      block("json", AUTO_ARCHIVE_MIN_LINES + 1),
      block("python", AUTO_ARCHIVE_MIN_LINES + 1),
    ].join("\n\n")
    autoArchiveCodeBlocks(
      { content, messageId: "m1", conversationId: "c1" },
      fn
    )
    expect(calls.map((c) => c.kind)).toEqual(["json", "code"])
  })

  test("multi-block titles are numbered, single-block titles are not", () => {
    const { fn: f1, calls: c1 } = makeStubCreate()
    autoArchiveCodeBlocks(
      {
        content: block("python", AUTO_ARCHIVE_MIN_LINES + 1),
        messageId: "m1",
        conversationId: "c1",
      },
      f1
    )
    expect(c1[0].title).toBe("Code (python)")

    const { fn: f2, calls: c2 } = makeStubCreate()
    autoArchiveCodeBlocks(
      {
        content: [
          block("python", AUTO_ARCHIVE_MIN_LINES + 1),
          block("python", AUTO_ARCHIVE_MIN_LINES + 1),
        ].join("\n\n"),
        messageId: "m1",
        conversationId: "c1",
      },
      f2
    )
    expect(c2[0].title).toBe("Code 1 (python)")
    expect(c2[1].title).toBe("Code 2 (python)")
  })
})
