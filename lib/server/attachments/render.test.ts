import { describe, expect, test } from "bun:test"
import {
  renderAttachmentsPrompt,
  renderMetaOnlyFilesPrompt,
  type ResolvedAttachment,
} from "./render"

describe("renderAttachmentsPrompt", () => {
  test("empty list → null", () => {
    expect(renderAttachmentsPrompt([], 1000)).toBeNull()
  })

  test("file-only — content + header rendered", () => {
    const out = renderAttachmentsPrompt(
      [{ kind: "file", summary: { name: "a.txt", size: 12, type: "text/plain", text: "hello" } }],
      10_000
    )
    expect(out).toContain("hello")
    expect(out).toContain("a.txt")
  })

  test("PDF citation note appears when any file kind === pdf", () => {
    const out = renderAttachmentsPrompt(
      [
        { kind: "file", summary: { name: "doc.pdf", size: 1, type: "application/pdf", kind: "pdf", text: "p1" } },
        { kind: "file", summary: { name: "x.txt", size: 1, type: "text/plain", text: "y" } },
      ],
      10_000
    )
    expect(out).toContain("[p.N]")
    expect(out).toContain('"doc.pdf"')
  })

  test("MCP-only — header + content rendered", () => {
    const out = renderAttachmentsPrompt(
      [{ kind: "mcp_resource", serverName: "GitHub", resourceName: "README.md", text: "# Repo" }],
      10_000
    )
    expect(out).toContain("GitHub: README.md")
    expect(out).toContain("# Repo")
  })

  test("URL-only — header + content rendered", () => {
    const out = renderAttachmentsPrompt(
      [{ kind: "url_bookmark", title: "Example", url: "https://x.example.com", content: "Body text", truncated: false }],
      10_000
    )
    expect(out).toContain("Example")
    expect(out).toContain("Body text")
  })

  test("MCP error → inline placeholder, no body", () => {
    const out = renderAttachmentsPrompt(
      [{ kind: "mcp_resource", serverName: "GitHub", resourceName: "missing.md", error: "404" }],
      10_000
    )
    expect(out).toContain('[MCP resource "missing.md" unavailable — 404]')
  })

  test("mixed kinds — ordering is file → mcp → url", () => {
    const out = renderAttachmentsPrompt(
      [
        { kind: "url_bookmark", title: "Page", url: "https://x", content: "URL content", truncated: false },
        { kind: "mcp_resource", serverName: "S", resourceName: "R", text: "MCP content" },
        { kind: "file", summary: { name: "f.txt", size: 5, type: "text/plain", text: "FILE content" } },
      ],
      10_000
    )
    const fileIdx = out!.indexOf("FILE content")
    const mcpIdx = out!.indexOf("MCP content")
    const urlIdx = out!.indexOf("URL content")
    expect(fileIdx).toBeLessThan(mcpIdx)
    expect(mcpIdx).toBeLessThan(urlIdx)
  })

  test("budget overflow → omitted-list footer per section", () => {
    const big = "x".repeat(5000)
    const out = renderAttachmentsPrompt(
      [
        { kind: "file", summary: { name: "a.txt", size: 5000, type: "text/plain", text: big } },
        { kind: "file", summary: { name: "b.txt", size: 5000, type: "text/plain", text: big } },
      ],
      2000
    )
    expect(out).toContain("[Additional files omitted to fit budget: b.txt]")
  })

  test("file section with only meta-only files → returns null (intro suppressed)", () => {
    // Regression guard for PR #7 — the intro lies if it ships above zero
    // body blocks.
    const out = renderAttachmentsPrompt(
      [{ kind: "file", summary: { name: "broken.bin", size: 100, type: "application/octet-stream" } }],
      10_000
    )
    expect(out).toBeNull()
  })

  test("URL truncation + fetched marker", () => {
    const out = renderAttachmentsPrompt(
      [{
        kind: "url_bookmark",
        title: "T",
        url: "https://x",
        content: "x".repeat(10_000),
        truncated: true,
        fetchedAt: "2026-05-21T00:00:00Z",
      }],
      500
    )
    expect(out).toContain("fetched 2026-05-21T00:00:00Z")
    expect(out).toContain("[truncated to fit overall budget]")
  })
})

describe("renderMetaOnlyFilesPrompt", () => {
  test("lists files with no extracted text", () => {
    const out = renderMetaOnlyFilesPrompt([
      { name: "broken.bin", size: 1024, type: "application/octet-stream" },
    ])
    expect(out).toContain("broken.bin")
  })

  test("empty list → null", () => {
    expect(renderMetaOnlyFilesPrompt([])).toBeNull()
  })

  test("files that have text are NOT included", () => {
    const out = renderMetaOnlyFilesPrompt([
      { name: "ok.txt", size: 1, type: "text/plain", text: "hello" },
      { name: "missing.bin", size: 1, type: "application/octet-stream" },
    ])
    expect(out).toContain("missing.bin")
    expect(out).not.toContain("ok.txt")
  })
})
