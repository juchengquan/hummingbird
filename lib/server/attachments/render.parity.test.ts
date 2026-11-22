/**
 * Attachment-prompt parity fixture for agent-py's port of this renderer.
 *
 * agent-py renders a run's attachments (`services/agent-py/src/agent_py/runs/context.py`)
 * the way the Next chat route does (`render.ts`): same budget, ordering,
 * truncation notes, meta-only footer and RAG / `searchFiles` notes with
 * file ids (Q47). This test runs the real TS renderer over a fixed table of
 * cases and compares the output with the committed fixture
 * `services/agent-py/tests/fixtures/attachments_render_parity.json`, which
 * `services/agent-py/tests/test_run_context_render.py` replays against the
 * Python port.
 *
 * A failure here means the renderer (or the case table) changed:
 * regenerate the fixture, then make the Python test pass again.
 *
 *   ATTACHMENTS_PARITY_WRITE=1 bun test lib/server/attachments/render.parity.test.ts
 *
 * Texts are ASCII / BMP only: JS measures the budget in UTF-16 code units,
 * Python in code points, so they differ past the BMP (emoji).
 */

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "bun:test"

import { renderAttachmentsPrompt, renderMetaOnlyFilesPrompt, type ResolvedAttachment } from "./render"

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../services/agent-py/tests/fixtures/attachments_render_parity.json", import.meta.url),
)

interface ParityCase {
  name: string
  budget: number
  searchFilesEnabled: boolean
  attachments: ResolvedAttachment[]
}

const ID = "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c"
const ID2 = "c9f0f895-fb98-4b9e-8a1d-0e1f2a3b4c5d"
const lorem = (n: number, seed = "lorem ipsum dolor sit amet, ") => seed.repeat(Math.ceil(n / seed.length)).slice(0, n)

function cases(): ParityCase[] {
  return [
    { name: "empty", budget: 1000, searchFilesEnabled: false, attachments: [] },
    {
      name: "one inline file",
      budget: 10_000,
      searchFilesEnabled: false,
      attachments: [{ kind: "file", summary: { name: "a.txt", size: 5, type: "text/plain", text: "hello" } }],
    },
    {
      name: "cloud file id in the header, with kind and extraction truncation",
      budget: 10_000,
      searchFilesEnabled: false,
      attachments: [
        { kind: "file", summary: { id: ID, name: "r.pdf", size: 9, type: "application/pdf", kind: "pdf", text: "page one", truncated: true } },
        { kind: "file", summary: { id: ID2, name: "notes", size: 3, type: "text/plain", text: "abc" } },
      ],
    },
    {
      name: "truncated cloud file is searchable when searchFiles is on",
      budget: 10_000,
      searchFilesEnabled: true,
      attachments: [
        { kind: "file", summary: { id: ID, name: "r.pdf", size: 9, type: "application/pdf", kind: "pdf", text: "page one", truncated: true } },
        { kind: "file", summary: { name: "local.txt", size: 3, type: "text/plain", text: "xyz", truncated: true } },
        { kind: "file", summary: { id: ID2, name: "whole.txt", size: 3, type: "text/plain", text: "all of it" } },
      ],
    },
    {
      name: "budget cut of a cloud file with searchFiles on",
      budget: 600,
      searchFilesEnabled: true,
      attachments: [{ kind: "file", summary: { id: ID, name: "big.txt", size: 9000, type: "text/plain", text: lorem(2000) } }],
    },
    {
      name: "RAG file with id, inline file, and a RAG file without id",
      budget: 10_000,
      searchFilesEnabled: true,
      attachments: [
        { kind: "file", summary: { id: ID, name: "huge.pdf", size: 5_000_000, type: "application/pdf", kind: "pdf", retrievalMode: "rag" } },
        { kind: "file", summary: { name: "small.md", size: 1, type: "text/markdown", kind: "markdown", text: "hello inline" } },
        { kind: "file", summary: { name: "anon.pdf", size: 7, type: "application/pdf", retrievalMode: "rag" } },
      ],
    },
    {
      name: "meta-only files (no text) next to text files",
      budget: 10_000,
      searchFilesEnabled: false,
      attachments: [
        { kind: "file", summary: { name: "ok.txt", size: 1, type: "text/plain", text: "fine" } },
        { kind: "file", summary: { name: "scan.png", size: 2_345_678, type: "image/png", kind: "image" } },
        { kind: "file", summary: { name: "blank.txt", size: 0, type: "", text: "   " } },
        { kind: "file", summary: { name: "z.bin", size: 1536, type: "application/octet-stream" } },
      ],
    },
    {
      name: "meta-only sizes (formatBytes rounding, ties round up)",
      budget: 10_000,
      searchFilesEnabled: false,
      attachments: [1, 1023, 1024, 1280, 1331, 1_572_864, 123_456_789, 5_000_000_000].map((size) => ({
        kind: "file" as const,
        summary: { name: `s${size}`, size, type: "application/octet-stream" },
      })),
    },
    {
      name: "only meta-only files",
      budget: 10_000,
      searchFilesEnabled: false,
      attachments: [{ kind: "file", summary: { name: "broken.bin", size: 1_048_576, type: "application/octet-stream" } }],
    },
    {
      name: "mixed kinds out of order",
      budget: 10_000,
      searchFilesEnabled: false,
      attachments: [
        { kind: "url_bookmark", title: "Page", url: "https://x.example/", content: "URL content", truncated: false, fetchedAt: "2026-05-21T00:00:00.000Z" },
        { kind: "mcp_resource", serverName: "GitHub", resourceName: "README.md", text: "# Repo" },
        { kind: "file", summary: { name: "f.txt", size: 5, type: "text/plain", text: "FILE content" } },
        { kind: "mcp_resource", serverName: "GitHub", resourceName: "gone.md", error: "timed out" },
        { kind: "mcp_resource", serverName: "Docs", resourceName: "empty", text: "" },
        { kind: "url_bookmark", title: "No date", url: "https://y.example/", content: "", truncated: true },
      ],
    },
    {
      name: "files overflow the budget — omitted footer",
      budget: 2000,
      searchFilesEnabled: false,
      attachments: [
        { kind: "file", summary: { name: "a.txt", size: 5000, type: "text/plain", text: lorem(5000) } },
        { kind: "file", summary: { name: "b.txt", size: 5000, type: "text/plain", text: lorem(5000, "b") } },
      ],
    },
    {
      name: "budget shared across sections",
      budget: 1200,
      searchFilesEnabled: false,
      attachments: [
        { kind: "file", summary: { name: "a.txt", size: 700, type: "text/plain", text: lorem(700) } },
        { kind: "mcp_resource", serverName: "S", resourceName: "R", text: lorem(300, "m") },
        { kind: "mcp_resource", serverName: "S", resourceName: "bad", error: "connection failed" },
        { kind: "url_bookmark", title: "T", url: "https://t/", content: lorem(400, "u"), truncated: false },
      ],
    },
    {
      name: "budget smaller than an intro",
      budget: 50,
      searchFilesEnabled: false,
      attachments: [
        { kind: "file", summary: { name: "a.txt", size: 5, type: "text/plain", text: "hello" } },
        { kind: "url_bookmark", title: "T", url: "https://t/", content: "c", truncated: false },
      ],
    },
    {
      name: "bookmark truncation with fetched marker",
      budget: 500,
      searchFilesEnabled: false,
      attachments: [
        { kind: "url_bookmark", title: "T", url: "https://x", content: lorem(10_000, "x"), truncated: true, fetchedAt: "2026-05-21T00:00:00Z" },
      ],
    },
    {
      name: "non-ASCII text (BMP)",
      budget: 400,
      searchFilesEnabled: false,
      attachments: [{ kind: "file", summary: { name: "日本.txt", size: 9, type: "text/plain", text: lorem(800, "こんにちは、世界。") } }],
    },
  ]
}

interface Expected {
  attachments: string | null
  metaOnly: string | null
}

function evaluate(c: ParityCase): Expected {
  const files = c.attachments.flatMap((a) => (a.kind === "file" ? [a.summary] : []))
  return {
    attachments: renderAttachmentsPrompt(c.attachments, c.budget, { searchFilesEnabled: c.searchFilesEnabled }),
    metaOnly: renderMetaOnlyFilesPrompt(files),
  }
}

function build() {
  return {
    note: "Generated by lib/server/attachments/render.parity.test.ts from the TS renderer. Do not edit; regenerate with ATTACHMENTS_PARITY_WRITE=1 bun test lib/server/attachments/render.parity.test.ts.",
    cases: cases().map((c) => ({ ...c, expected: evaluate(c) })),
  }
}

describe("attachments render parity fixture", () => {
  test("matches the committed fixture", () => {
    const built = build()
    if (process.env.ATTACHMENTS_PARITY_WRITE === "1") {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(built, null, 1)}\n`)
    }
    const committed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))
    expect(committed).toEqual(built)
  })
})
