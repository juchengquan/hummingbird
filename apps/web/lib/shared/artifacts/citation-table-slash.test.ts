import { describe, expect, it } from "bun:test"

import type { Artifact } from "@/shared/types"

import { buildCitationTableSlashItems } from "./citation-table-slash"

function artifact(over: Partial<Artifact>): Artifact {
  return {
    id: "id",
    workspaceId: "ws",
    conversationId: null,
    messageId: null,
    kind: "table",
    language: null,
    title: "T",
    content: "{}",
    storagePath: null,
    pinned: false,
    createdAt: new Date(0),
    ...over,
  }
}

describe("buildCitationTableSlashItems", () => {
  it("keeps only kind:'table' and maps id->artifactId, title->label", () => {
    const items = buildCitationTableSlashItems([
      artifact({ id: "a", kind: "table", title: "Sales by region" }),
      artifact({ id: "b", kind: "code", title: "script.ts" }),
      artifact({ id: "c", kind: "markdown", title: "Notes" }),
      artifact({ id: "d", kind: "table", title: "Q3 pipeline" }),
    ])
    expect(items).toEqual([
      { artifactId: "a", label: "Sales by region" },
      { artifactId: "d", label: "Q3 pipeline" },
    ])
  })

  it("falls back to 'Untitled table' for an empty title", () => {
    const items = buildCitationTableSlashItems([
      artifact({ id: "a", kind: "table", title: "" }),
    ])
    expect(items).toEqual([{ artifactId: "a", label: "Untitled table" }])
  })

  it("preserves input order", () => {
    const items = buildCitationTableSlashItems([
      artifact({ id: "z", kind: "table", title: "Z" }),
      artifact({ id: "a", kind: "table", title: "A" }),
    ])
    expect(items.map((i) => i.artifactId)).toEqual(["z", "a"])
  })

  it("returns [] for no artifacts or no tables", () => {
    expect(buildCitationTableSlashItems([])).toEqual([])
    expect(
      buildCitationTableSlashItems([artifact({ kind: "image" })]),
    ).toEqual([])
  })
})
