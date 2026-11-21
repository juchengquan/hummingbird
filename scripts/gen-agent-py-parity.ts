#!/usr/bin/env bun
/**
 * Parity fixtures for agent-py's ports of TypeScript logic
 * (`docs/PLAN-frontend-backend-split.md`, wave 2): the expected outputs
 * come from running the TS originals, and agent-py's pytest suite checks
 * its ports produce exactly the same.
 *
 *   chunk_parity.json          lib/server/embeddings/chunk.ts  ↔ agent_py.chunk
 *   memory_parity.json         lib/server/memory/{prompt,merge}.ts ↔ agent_py.memory_extract
 *   csp_report_parity.json     lib/server/security/csp-report.ts ↔ agent_py.csp_report
 *
 * Written to services/agent-py/tests/fixtures/. Run:
 *   bun run codegen:agent-py-parity            # write
 *   bun run codegen:agent-py-parity --check    # exit 1 on drift
 * `scripts/__tests__/agent-py-parity.test.ts` runs the check in
 * `bun run test`, so a change to a TS original fails until the fixtures
 * are regenerated (and the agent-py port then has to match them).
 *
 * `--conditions react-server` (in the package.json script) lets the
 * `server-only` fence resolve to its empty module outside Next.
 */

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { chunkText, type ChunkOptions } from "@/server/embeddings/chunk"
import { mergeFacts } from "@/server/memory/merge"
import { buildMemoryExtractPrompt } from "@/server/memory/prompt"
import type { FactOp, MemoryFact } from "@/server/memory/types"
import { parseCspReports, sanitizeReportedUrl } from "@/server/security/csp-report"

export const FIXTURE_DIR = path.join(
  import.meta.dir,
  "..",
  "services",
  "agent-py",
  "tests",
  "fixtures",
)

// --- Deterministic text generation ----------------------------------------

/** mulberry32 — a tiny seeded PRNG so the inputs are stable across runs. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = [
  "embedding", "vector", "chunk", "overlap", "paragraph", "retrieval", "the", "a",
  "of", "and", "search", "semantic", "lexical", "hybrid", "window", "boundary",
  "token", "model", "index", "section", "document", "Supabase", "Postgres", "row",
]

function sentence(rand: () => number, words: number): string {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)])
  const s = out.join(" ")
  return `${s[0].toUpperCase()}${s.slice(1)}.`
}

function paragraph(rand: () => number, sentences: number): string {
  const out: string[] = []
  for (let i = 0; i < sentences; i++) out.push(sentence(rand, 4 + Math.floor(rand() * 14)))
  return out.join(" ")
}

function longDoc(seed: number, paras: number, maxSentences: number): string {
  const rand = prng(seed)
  const out: string[] = []
  for (let i = 0; i < paras; i++) out.push(paragraph(rand, 1 + Math.floor(rand() * maxSentences)))
  return out.join("\n\n")
}

function table(rows: number, cellWidth: number): string {
  const header = "| Name | Value | Notes |"
  const sep = "|------|:-----:|-------|"
  const body: string[] = []
  for (let i = 0; i < rows; i++) {
    body.push(`| item-${i} | ${i * 7} | ${"n".repeat(cellWidth)}${i} |`)
  }
  return [header, sep, ...body].join("\n")
}

// --- Chunker cases ---------------------------------------------------------

interface ChunkCase {
  name: string
  text: string
  opts?: ChunkOptions
}

function chunkCases(): ChunkCase[] {
  const para = (n: number, ch = "x") => ch.repeat(n)
  return [
    { name: "empty", text: "" },
    { name: "whitespace only", text: "  \n\n\t \n " },
    { name: "short", text: "Hello world" },
    { name: "short, trimmed", text: "\n\n   Hello world.  \n" },
    { name: "exactly max (fits)", text: para(1500) },
    { name: "max + 1 (single paragraph, hard split)", text: para(1501) },
    { name: "long single paragraph", text: para(5000, "y") },
    { name: "long document (default sizes)", text: longDoc(1, 40, 12) },
    { name: "long document, larger paragraphs", text: longDoc(2, 25, 30) },
    { name: "long document, small window", text: longDoc(3, 30, 6), opts: { maxChars: 300, overlapChars: 50 } },
    { name: "long document, no overlap", text: longDoc(4, 30, 10), opts: { overlapChars: 0 } },
    {
      name: "overlap clamped to maxChars - 1",
      text: longDoc(5, 3, 2),
      opts: { maxChars: 200, overlapChars: 500 },
    },
    {
      name: "markdown headings",
      text: [
        "# Title",
        longDoc(6, 3, 10),
        "## Section one",
        longDoc(7, 4, 12),
        "### Subsection",
        "- bullet one\n- bullet two\n- bullet three",
        "## Section two",
        longDoc(8, 5, 12),
      ].join("\n\n"),
    },
    { name: "oversized markdown table (row split)", text: `Intro paragraph.\n\n${table(80, 20)}\n\nOutro paragraph.` },
    {
      name: "table whose first row does not fit (hard split)",
      text: `| h1 | h2 |\n|---|---|\n| ${"z".repeat(1600)} | 1 |\n| a | b |`,
    },
    { name: "small table that fits", text: `${longDoc(9, 6, 10)}\n\n${table(5, 4)}\n\n${longDoc(10, 6, 10)}` },
    {
      name: "prose with pipes (not a table)",
      text: `${"a | b | c ".repeat(200)}\nsecond line | with pipe\n\n${longDoc(11, 3, 5)}`,
    },
    {
      name: "table-like block without separator",
      text: Array.from({ length: 120 }, (_, i) => `| r${i} | v${i} | ${"w".repeat(10)} |`).join("\n"),
    },
    {
      name: "unicode: CJK paragraphs",
      text: Array.from({ length: 12 }, (_, i) => `第${i}段。${"嵌入向量检索".repeat(30 + i * 3)}`).join("\n\n"),
    },
    {
      name: "unicode: emoji hard split cuts surrogate pairs",
      text: `a${"😀".repeat(1200)}`,
      opts: { maxChars: 301, overlapChars: 40 },
    },
    {
      name: "unicode: emoji paragraphs (default sizes)",
      text: Array.from({ length: 30 }, (_, i) => `${"🎉🚀".repeat(20 + i)} paragraph ${i} ✓ é ü ñ`).join("\n\n"),
    },
    {
      name: "unicode: combining marks and ZWJ sequences",
      text: Array.from({ length: 40 }, (_, i) => `é́ 👩‍👩‍👧‍👦 ${i} ${"ñ".repeat(60)}`).join("\n\n"),
      opts: { maxChars: 400, overlapChars: 60 },
    },
    {
      name: "JS-only whitespace (U+FEFF, NBSP, U+2028) in separators and trim",
      text: `﻿  ${para(900, "p")}\n﻿  \n${para(900, "q")}\n 　\n${para(900, "r")}﻿`,
    },
    {
      name: "Python-only whitespace (U+001C, U+0085) is not a separator",
      text: `${para(900, "s")}\n\u001c\n${para(900, "t")}\n\u0085\n${para(900, "u")}\u0085`,
    },
    {
      name: "CRLF line endings",
      text: longDoc(12, 20, 10).replaceAll("\n", "\r\n"),
    },
    {
      name: "runs of blank lines with spaces and tabs",
      text: longDoc(13, 15, 12).replaceAll("\n\n", "\n \t \n\n\t\n"),
    },
    {
      name: "exact boundary: buf + para == max",
      // 1000 + 2 + 498 = 1500 → packs; the next paragraph overflows.
      text: [para(1000, "a"), para(498, "b"), para(10, "c")].join("\n\n"),
    },
    {
      name: "exact boundary: buf + para == max + 1",
      text: [para(1000, "a"), para(499, "b"), para(10, "c")].join("\n\n"),
    },
    {
      name: "overlap tail + paragraph overflow drops the tail",
      text: [para(1400, "a"), para(1400, "b"), para(1350, "c")].join("\n\n"),
    },
    {
      name: "oversized paragraph between small ones",
      text: [para(300, "a"), para(4000, "b"), para(300, "c"), para(300, "d")].join("\n\n"),
    },
  ]
}

// --- Memory cases ------------------------------------------------------------

interface PromptCase {
  name: string
  turn: string
  existing: MemoryFact[]
}

interface MergeCase {
  name: string
  existing: MemoryFact[]
  ops: FactOp[]
}

function memoryPromptCases(): PromptCase[] {
  return [
    { name: "no existing facts", turn: "User: I write Rust at work.\n\nAssistant: Noted!", existing: [] },
    {
      name: "existing facts",
      turn: "User: I switched from Rust to Go.\n\nAssistant: Got it.",
      existing: [
        { id: "11111111-1111-4111-8111-111111111111", fact: "Writes Rust at work", category: "tech" },
        { id: "22222222-2222-4222-8222-222222222222", fact: "Lives in Berlin", category: null },
      ],
    },
    {
      name: "unicode + multi-line turn",
      turn: "User: 我叫小明 — I prefer *dark mode* 🌙\nand short answers.\n\nAssistant: 好的。",
      existing: [{ id: "f-1", fact: "Prefers concise replies — always", category: "pref" }],
    },
  ]
}

function memoryMergeCases(): MergeCase[] {
  const facts = (n: number): MemoryFact[] =>
    Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, fact: `fact ${i}`, category: null }))
  return [
    {
      name: "adds and a valid update",
      existing: facts(2),
      ops: [
        { op: "add", fact: "Uses Neovim", category: "tools" },
        { op: "update", id: "id-1", fact: "fact 1, revised" },
      ],
    },
    {
      name: "update with an unknown or missing id is dropped",
      existing: facts(1),
      ops: [
        { op: "update", id: "nope", fact: "x" },
        { op: "update", fact: "no id" },
      ],
    },
    {
      name: "adds stop at the 100-fact cap",
      existing: facts(98),
      ops: [
        { op: "add", fact: "a" },
        { op: "add", fact: "b", category: "c" },
        { op: "add", fact: "c" },
        { op: "update", id: "id-5", fact: "still updates at the cap" },
      ],
    },
  ]
}

// --- CSP report cases ----------------------------------------------------

function cspUrlCases(): string[] {
  return [
    "",
    "inline",
    "eval",
    "wasm-eval",
    "trusted-types-sink",
    "https://cdn.example.com/x.js?token=secret#frag",
    "HTTPS://Example.COM:443/A/./b/../c?q",
    "http://localhost:3000/share/conversation/abc123/more?x=1",
    "https://app.example.com/share/document/tok_9/",
    "wss://rt.example.com:8443/realtime/v1?apikey=x",
    "data:image/png;base64,AAAA",
    "blob:https://app.example.com/1234",
    "about:srcdoc",
    "about:blank",
    "chrome-extension://abcdef/script.js",
    "not a url",
    "/relative/path",
    `https://example.com/${"p".repeat(300)}`,
    "https://user:pass@example.com/path",
    "https://example.com",
    'https://a.com/a^b|c`d{e}f g"h<i>j',
    "https:example.com/x",
    "https:/x.com/y",
    "https://x.com\\a\\b",
    "https://ex.com:80/",
    "http://ex.com:80/a",
    "https://ex.com:/a",
    "https://ex.com:99999/",
    "https://exämple.com/ü",
    "https://[::1]:3000/a",
    "https://[0:0:0:0:0:0:0:1]/",
    "  https://x.com/a  ",
    "ht\ttps://x.com/a\nb",
    "https://",
    "https:///x",
    "ftp://x.com/a",
    "HTTP://X.COM/%2e%2E/a/./%2e",
    "https://x.com/a/b/..",
    "https://x.com/a/b/.",
    "https://x.com/\u007f",
    "file:///etc/passwd",
    "ws://h/a?b",
    "https://x.com#frag",
    "https://a b.com/",
    "https://x.com/%zz",
    "mailto:a@b.c",
    "javascript:alert(1)",
    "https://@x.com/",
    "https://x.com/share/conversation/",
    "https://x.com/a/share/document/t/b/share/conversation/u",
    "ABOUT:srcdoc",
    "about:srcdoc#x",
  ]
}

function cspPayloadCases(): Array<{ name: string; payload: unknown }> {
  return [
    {
      name: "legacy report-uri",
      payload: {
        "csp-report": {
          "document-uri": "https://app.example.com/dashboard?tab=1",
          "effective-directive": "script-src-elem",
          "violated-directive": "script-src",
          "blocked-uri": "https://cdn.example.com/x.js?sig=abc",
          "source-file": "https://app.example.com/_next/static/chunks/a.js",
          "line-number": 12.9,
          "column-number": 345,
          disposition: "report",
          "script-sample": "alert(document.cookie)",
        },
      },
    },
    {
      name: "legacy, violated-directive fallback + srcdoc",
      payload: {
        "csp-report": {
          "document-uri": "about:srcdoc",
          "violated-directive": "style-src-elem 'self'",
          "blocked-uri": "inline",
          disposition: "enforce",
        },
      },
    },
    {
      name: "legacy, odd field types",
      payload: {
        "csp-report": {
          "document-uri": 42,
          "effective-directive": "",
          "blocked-uri": null,
          "line-number": "12",
          "column-number": Number.MAX_SAFE_INTEGER,
          disposition: "monitor",
        },
      },
    },
    {
      name: "reporting API batch",
      payload: [
        {
          type: "csp-violation",
          age: 3,
          url: "https://app.example.com/",
          body: {
            documentURL: "https://app.example.com/share/conversation/tok/x",
            effectiveDirective: "img-src",
            blockedURL: "https://tracker.example.com/p.gif?id=1",
            sourceFile: "https://app.example.com/a.js",
            lineNumber: 1,
            columnNumber: 2,
            disposition: "report",
          },
        },
        { type: "deprecation", body: { id: "x" } },
        { type: "csp-violation", body: "not an object" },
        "junk",
        { type: "csp-violation", body: { effectiveDirective: `${"d".repeat(300)} extra` } },
      ],
    },
    {
      name: "reporting API batch over the entry cap",
      payload: Array.from({ length: 25 }, (_, i) => ({
        type: "csp-violation",
        body: { effectiveDirective: `img-src`, blockedURL: `https://e${i}.example.com/` },
      })),
    },
    { name: "unknown shape", payload: { hello: "world" } },
    { name: "array of junk", payload: [1, 2, 3] },
    { name: "null", payload: null },
    { name: "csp-report not an object", payload: { "csp-report": [1] } },
  ]
}

// --- Build -----------------------------------------------------------------

export function buildFixtures(): Record<string, unknown> {
  return {
    "chunk_parity.json": {
      source: "lib/server/embeddings/chunk.ts",
      cases: chunkCases().map((c) => ({
        name: c.name,
        text: c.text,
        opts: c.opts ?? {},
        chunks: chunkText(c.text, c.opts),
      })),
    },
    "memory_parity.json": {
      source: "lib/server/memory/prompt.ts + lib/server/memory/merge.ts",
      prompts: memoryPromptCases().map((c) => ({
        ...c,
        prompt: buildMemoryExtractPrompt(c.turn, c.existing),
      })),
      merges: memoryMergeCases().map((c) => ({ ...c, plan: mergeFacts(c.existing, c.ops) })),
    },
    "csp_report_parity.json": {
      source: "lib/server/security/csp-report.ts",
      urls: cspUrlCases().map((raw) => ({ raw, sanitized: sanitizeReportedUrl(raw) })),
      payloads: cspPayloadCases().map((c) => ({ ...c, logs: parseCspReports(c.payload) })),
    },
  }
}

export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`
}

if (import.meta.main) {
  const check = process.argv.includes("--check")
  let drift = false
  for (const [name, value] of Object.entries(buildFixtures())) {
    const file = path.join(FIXTURE_DIR, name)
    const next = serialize(value)
    if (check) {
      let current = ""
      try {
        current = readFileSync(file, "utf8")
      } catch {
        // missing → drift
      }
      if (current !== next) {
        console.error(`drift: ${path.relative(process.cwd(), file)}`)
        drift = true
      }
    } else {
      writeFileSync(file, next)
      console.log(`→ Wrote ${path.relative(process.cwd(), file)}`)
    }
  }
  if (drift) {
    console.error("Run `bun run codegen:agent-py-parity` and make agent-py match.")
    process.exit(1)
  }
}
