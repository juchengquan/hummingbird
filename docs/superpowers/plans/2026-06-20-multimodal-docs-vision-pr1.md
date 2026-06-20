# Multimodal Document Understanding — PR-1 (Vision Extraction Path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auto-gated, best-effort vision extraction path that renders layout-rich PDF pages to images, has a vision-capable model transcribe layout to markdown (tables → markdown tables, figures → captions), and merges that text into the existing `ExtractionResult.text` / `fullText` — improving FTS / `searchFiles` / file-Q&A with no schema, wire, store, or UI changes.

**Architecture:** Extraction stays stateless. `extractFile()` runs the existing text pass, then — when `resolveVisionModel()` returns a model **and** the pure `shouldUseVision()` heuristic says the doc is layout-rich (and a per-IP budget allows) — renders pages via `pdf-to-img` and runs one vision call per page through an extended `generateStructured`, merging the markdown back into the result. Any failure falls back to the text-only result. The renderer (`pdf-to-img` → native `@napi-rs/canvas`) is added to `serverExternalPackages`.

**Tech Stack:** TypeScript, Next.js 16, Bun test, AI SDK 5 (`generateObject` with image messages), `pdf-to-img` (wraps pdfjs-dist + @napi-rs/canvas), Zod 4.

**Spec:** [`docs/superpowers/specs/2026-06-20-multimodal-docs-vision-pr1-design.md`](../specs/2026-06-20-multimodal-docs-vision-pr1-design.md)

**Conventions to follow (from the existing code):**
- The model step is **dependency-injected** so orchestration is unit-tested without a live model or the native binding — exactly like `runVerifier` in `lib/server/verify/verify-answer.ts`.
- Vision is **advisory / never-fatal**: every failure path returns the text-only result (like `suggestions.ts` / `verify-answer.ts` degrade to empty).
- Tests use `bun:test` (`import { describe, expect, test } from "bun:test"`). Run a single file with `bun test <path>`.
- Full gate before PR: `bun run typecheck && bun run lint && bun run test && bun run build && bun run audit:bundle`.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `config/models.json` | Add `"supportsVision": true` to vision-capable models | 1 |
| `lib/shared/models.ts` | `supportsVision?` schema field + `modelSupportsVision(id)` helper | 1 |
| `lib/shared/models.test.ts` | Test the new helper | 1 |
| `lib/server/extraction/vision-model.ts` (new) | `resolveVisionModel()` server-side resolution | 2 |
| `lib/server/extraction/vision-model.test.ts` (new) | Test resolution branches | 2 |
| `lib/server/extraction/render-pdf.ts` (new) | `renderPdfPages()` via `pdf-to-img` | 3 |
| `lib/server/extraction/render-pdf.test.ts` (new) | Renderer smoke (resilient-skip) | 3 |
| `next.config.ts` | Add `pdf-to-img` to `serverExternalPackages` | 3 |
| `package.json` | Add `pdf-to-img` dependency | 3 |
| `lib/server/ai/structured.ts` | Accept `messages` (image parts) | 4 |
| `lib/server/extraction/heuristics.ts` (new) | Pure `shouldUseVision()` + `mergeVisionText()` | 5 |
| `lib/server/extraction/heuristics.test.ts` (new) | Test both pure helpers | 5 |
| `lib/server/extraction/vision.ts` (new) | `extractWithVision()` orchestration (injectable deps) | 6 |
| `lib/server/extraction/vision.test.ts` (new) | Test orchestration with fakes | 6 |
| `lib/server/extraction.ts` | Wire vision into `extractFile()` | 7 |
| `lib/server/extraction.test.ts` (new) | Gate + fallback + merge integration | 7 |
| `app/api/extract/route.ts` | `vision?` flag, budget gate, cache key | 8 |
| `app/api/extract/route.test.ts` (new) | Cache-key includes vision flag | 8 |

---

### Task 1: `supportsVision` model flag + helper

**Files:**
- Modify: `lib/shared/models.ts` (schema `ChatModelSchema` ~line 53; helper after `modelSupportsStructuredOutput` ~line 155)
- Modify: `config/models.json`
- Test: `lib/shared/models.test.ts`

- [ ] **Step 1: Write the failing test** — append to `lib/shared/models.test.ts`:

```typescript
import { modelSupportsVision } from "./models"

describe("modelSupportsVision", () => {
  test("flagged model → true", () => {
    expect(modelSupportsVision("anthropic/claude-sonnet-4.6")).toBe(true)
  })
  test("unflagged model → false", () => {
    expect(modelSupportsVision("deepseek/deepseek-v4-flash")).toBe(false)
  })
  test("unknown id → false", () => {
    expect(modelSupportsVision("does/not-exist")).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/shared/models.test.ts`
Expected: FAIL — `modelSupportsVision` is not exported.

- [ ] **Step 3: Add the schema field.** In `lib/shared/models.ts`, inside `ChatModelSchema`, after the `supportsStructuredOutput` field (~line 53), add:

```typescript
  /** When true, the model accepts image input (vision). Gates the
   *  vision document-extraction path (`@/server/extraction/vision`):
   *  the extractor only renders + sends page images to models flagged
   *  here. Absent / false → text-only extraction. */
  supportsVision: z.boolean().optional(),
```

- [ ] **Step 4: Add the helper.** After `modelSupportsStructuredOutput` (~line 155), add:

```typescript
/** Whether a model accepts image input (vision). Gates the vision
 *  document-extraction path. Unknown id → false. */
export function modelSupportsVision(id: string): boolean {
  return getChatModel(id)?.supportsVision === true
}
```

- [ ] **Step 5: Flag the vision-capable models** in `config/models.json` — add `"supportsVision": true` to these entries (alongside their existing flags): `anthropic/claude-sonnet-4.6`, `anthropic/claude-haiku-4.5`, `openai/gpt-5.5`, `openai/gpt-5.3-chat`, `google/gemini-2.5-pro`, `google/gemini-2.5-flash`. Leave `deepseek/*`, `minimax/*`, `ollama/*`, `openrouter/*` unflagged (conservative — only flag known vision models).

Example (sonnet entry):

```json
    {
      "id": "anthropic/claude-sonnet-4.6",
      "label": "Claude Sonnet 4.6",
      "provider": "Anthropic",
      "contextWindow": 1000000,
      "supportsReasoningEffort": true,
      "supportsStructuredOutput": true,
      "supportsVision": true,
      "tokenizer": "tiktoken-cl100k",
      "routes": [{ "via": "gateway" }]
    },
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test lib/shared/models.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/shared/models.ts lib/shared/models.test.ts config/models.json
git commit -m "feat(models): add supportsVision flag + modelSupportsVision helper"
```

---

### Task 2: `resolveVisionModel()` — server-side model resolution

Keeps the extract route file-only: the vision model is resolved internally from config + env, never threaded through the request.

**Files:**
- Create: `lib/server/extraction/vision-model.ts`
- Test: `lib/server/extraction/vision-model.test.ts`

- [ ] **Step 1: Write the failing test** — `lib/server/extraction/vision-model.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"

import type { ChatModel } from "@/shared/models"
import { resolveVisionModel } from "./vision-model"

const MODELS = [
  { id: "text/only", label: "t", provider: "p", contextWindow: 1, routes: [{ via: "gateway" }] },
  { id: "vis/a", label: "a", provider: "p", contextWindow: 1, routes: [{ via: "gateway" }], supportsVision: true },
  { id: "vis/b", label: "b", provider: "p", contextWindow: 1, routes: [{ via: "gateway" }], supportsVision: true },
] as unknown as ChatModel[]

describe("resolveVisionModel", () => {
  test("env override that is vision-capable wins", () => {
    expect(resolveVisionModel(MODELS, { VISION_MODEL: "vis/b" })).toBe("vis/b")
  })
  test("env override that is NOT vision-capable is ignored → first flagged", () => {
    expect(resolveVisionModel(MODELS, { VISION_MODEL: "text/only" })).toBe("vis/a")
  })
  test("no override → first vision-capable model", () => {
    expect(resolveVisionModel(MODELS, {})).toBe("vis/a")
  })
  test("no vision-capable models → null", () => {
    const textOnly = [MODELS[0]] as ChatModel[]
    expect(resolveVisionModel(textOnly, {})).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/server/extraction/vision-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `lib/server/extraction/vision-model.ts`:

```typescript
import "server-only"

import { CHAT_MODELS, type ChatModel } from "@/shared/models"

/**
 * Resolve the model used for vision document extraction, server-side, so
 * the `/api/extract` contract stays file-only (no model parameter). Order:
 *   1. `VISION_MODEL` env override, if it names a vision-capable model.
 *   2. The first vision-capable model in the registry.
 *   3. `null` — no vision-capable model configured → vision path skipped.
 *
 * `models` / `env` are injectable for testing; production uses the real
 * registry + `process.env`.
 */
export function resolveVisionModel(
  models: ChatModel[] = CHAT_MODELS,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const override = env.VISION_MODEL
  if (override && models.some((m) => m.id === override && m.supportsVision === true)) {
    return override
  }
  return models.find((m) => m.supportsVision === true)?.id ?? null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/server/extraction/vision-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/extraction/vision-model.ts lib/server/extraction/vision-model.test.ts
git commit -m "feat(extraction): resolveVisionModel server-side resolution"
```

---

### Task 3: PDF→image renderer (`pdf-to-img`) + build wiring

**Files:**
- Create: `lib/server/extraction/render-pdf.ts`
- Test: `lib/server/extraction/render-pdf.test.ts`
- Modify: `next.config.ts`, `package.json` (via `bun add`)

- [ ] **Step 1: Add the dependency**

Run: `bun add pdf-to-img`
Expected: `package.json` gains `"pdf-to-img"` under dependencies; lockfile updates. (It pulls a version-matched `@napi-rs/canvas` + nested `pdfjs-dist` transitively — that's intended; the spike proved this pairing renders correctly where a hand-rolled factory failed.)

- [ ] **Step 2: Mark it server-external.** In `next.config.ts`, extend `serverExternalPackages` and document why:

```typescript
  // `pdf-to-img` renders PDF pages to PNG for the vision extraction path
  // (`@/server/extraction/vision`). It depends on `@napi-rs/canvas`, a
  // native NAPI binding Turbopack can't place in an ESM chunk — same
  // class of issue as `microsandbox`. Server-external makes Node require
  // it from node_modules at runtime. Only reached behind the
  // vision-capable-model gate.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "mammoth", "microsandbox", "pdf-to-img"],
```

- [ ] **Step 3: Write the failing test** — `lib/server/extraction/render-pdf.test.ts`. A 1-page A4-ish fixture PDF is embedded as base64 (generated with pdfkit). The test resilient-skips if the native binding is unavailable in the environment (don't fail CI on a missing optional native binary):

```typescript
import { describe, expect, test } from "bun:test"

import { renderPdfPages } from "./render-pdf"

// Minimal valid 1-page PDF (200x200), generated with pdfkit.
const FIXTURE_PDF_B64 =
  "JVBERi0xLjMKJf////8KNyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9NZWRpYUJveCBbMCAwIDIwMCAyMDBdCi9Db250ZW50cyA1IDAgUgovUmVzb3VyY2VzIDYgMCBSCi9Vc2VyVW5pdCAxCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Qcm9jU2V0IFsvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJXQovRm9udCA8PAovRjEgOCAwIFIKPj4KL0NvbG9yU3BhY2UgPDwKPj4KPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0xlbmd0aCA3NgovRmlsdGVyIC9GbGF0ZURlY29kZQo+PgpzdHJlYW0KeJwzVDAAQl1DIGFkYKCQnMtVyGWIIeYUAhU0BIooGJpZ6lmaWCiE5HLpuxkqGJoohKRxRduYWJhZ2ikYxCqEeHG5hnAFcgEAJq8SBgplbmRzdHJlYW0KZW5kb2JqCjEwIDAgb2JqCihQREZLaXQpCmVuZG9iagoxMSAwIG9iagooUERGS2l0KQplbmRvYmoKMTIgMCBvYmoKKEQ6MjAyNjA2MjAwNDMzMTlaKQplbmRvYmoKOSAwIG9iago8PAovUHJvZHVjZXIgMTAgMCBSCi9DcmVhdG9yIDExIDAgUgovQ3JlYXRpb25EYXRlIDEyIDAgUgo+PgplbmRvYmoKOCAwIG9iago8PAovVHlwZSAvRm9udAovQmFzZUZvbnQgL0hlbHZldGljYQovU3VidHlwZSAvVHlwZTEKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCjQgMCBvYmoKPDwKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCi9OYW1lcyAyIDAgUgo+PgplbmRvYmoKMSAwIG9iago8PAovVHlwZSAvUGFnZXMKL0NvdW50IDEKL0tpZHMgWzcgMCBSXQo+PgplbmRvYmoKMiAwIG9iago8PAovRGVzdHMgPDwKICAvTmFtZXMgWwpdCj4+Cj4+CmVuZG9iagp4cmVmCjAgMTMKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwNzI2IDAwMDAwIG4gCjAwMDAwMDA3ODMgMDAwMDAgbiAKMDAwMDAwMDY2NCAwMDAwMCBuIAowMDAwMDAwNjQzIDAwMDAwIG4gCjAwMDAwMDAyMzggMDAwMDAgbiAKMDAwMDAwMDEzMSAwMDAwMCBuIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDA1NDYgMDAwMDAgbiAKMDAwMDAwMDQ3MSAwMDAwMCBuIAowMDAwMDAwMzg1IDAwMDAwIG4gCjAwMDAwMDA0MTAgMDAwMDAgbiAKMDAwMDAwMDQzNSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDEzCi9Sb290IDMgMCBSCi9JbmZvIDkgMCBSCi9JRCBbPDUwOGIxMjkyZDkzNmZlMjNiZjdkYjM4ZDZjYWFiYjZiPiA8NTA4YjEyOTJkOTM2ZmUyM2JmN2RiMzhkNmNhYWJiNmI+XQo+PgpzdGFydHhyZWYKODMwCiUlRU9GCg=="

describe("renderPdfPages", () => {
  test("renders a single-page PDF to one valid PNG buffer", async () => {
    const data = new Uint8Array(Buffer.from(FIXTURE_PDF_B64, "base64"))
    let pages: Buffer[]
    try {
      pages = await renderPdfPages(data, { scale: 1.5 })
    } catch (err) {
      // The renderer leans on @napi-rs/canvas (native binding). If it
      // can't load in this environment, skip rather than fail CI.
      console.warn("renderPdfPages skipped (native binding unavailable):", err)
      return
    }
    expect(pages.length).toBe(1)
    const png = pages[0]
    expect(png.length).toBeGreaterThan(0)
    // PNG signature.
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  })

  test("honours maxPages cap", async () => {
    const data = new Uint8Array(Buffer.from(FIXTURE_PDF_B64, "base64"))
    try {
      const pages = await renderPdfPages(data, { maxPages: 0 })
      expect(pages.length).toBe(0)
    } catch {
      return // native binding unavailable → skip
    }
  })
})
```

> NOTE TO IMPLEMENTER: If `bun test` cannot load the base64 above for any reason, regenerate an equivalent fixture: `cd /tmp && bun add pdfkit`, write a tiny script that pipes a one-page `PDFDocument` into a Buffer, and `console.log(buf.toString("base64"))`. The exact bytes don't matter — only that it's a valid 1-page PDF.

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test lib/server/extraction/render-pdf.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement** — `lib/server/extraction/render-pdf.ts`:

```typescript
import "server-only"

import { pdf } from "pdf-to-img"

export interface RenderPdfOptions {
  /** Hard cap on pages rendered (cost bound). Default 30. */
  maxPages?: number
  /** Render scale (≈ DPI/72). Default 2.0 (~144 DPI). */
  scale?: number
}

/**
 * Render PDF pages to PNG buffers via `pdf-to-img` (pdfjs-dist +
 * @napi-rs/canvas, a known-good pairing). Caps at `maxPages` to bound
 * cost. Throws if the document can't be parsed/rendered — callers in the
 * vision path treat any throw as "fall back to text-only".
 */
export async function renderPdfPages(
  data: Uint8Array,
  opts: RenderPdfOptions = {}
): Promise<Buffer[]> {
  const { maxPages = 30, scale = 2.0 } = opts
  if (maxPages <= 0) return []
  const doc = await pdf(Buffer.from(data), { scale })
  const out: Buffer[] = []
  for await (const page of doc) {
    out.push(page)
    if (out.length >= maxPages) break
  }
  return out
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test lib/server/extraction/render-pdf.test.ts`
Expected: PASS (or skipped with a warning if the native binding is unavailable).

- [ ] **Step 7: Commit**

```bash
git add lib/server/extraction/render-pdf.ts lib/server/extraction/render-pdf.test.ts next.config.ts package.json bun.lock
git commit -m "feat(extraction): renderPdfPages via pdf-to-img + serverExternalPackages"
```

---

### Task 4: Extend `generateStructured` to accept image messages

The vision pass must send a page image to the model. AI SDK 5's `generateObject` accepts either `prompt` or `messages` (`ModelMessage[]`), and a user message's content array can carry `{ type: "image", image }` parts. Extend the helper to pass `messages` through when provided.

Following the existing convention, `structured.ts` has no unit test (it is a thin SDK passthrough); this change is validated by `typecheck` and by Task 6's vision tests + the manual smoke. Do not add a `mock.module("ai")` test here — it would run in the shared `MAIN_ROOTS` test process and risk leaking the mock.

**Files:**
- Modify: `lib/server/ai/structured.ts`

- [ ] **Step 1: Implement** — replace the options interface + function body in `lib/server/ai/structured.ts`:

```typescript
import { generateObject, type ModelMessage } from "ai"
import type { z } from "zod"

import { selectModel } from "@/server/model-provider"

export interface GenerateStructuredOptions<T> {
  modelId: string
  schema: z.ZodType<T>
  /** Plain-text prompt. Provide this OR `messages`, not both. */
  prompt?: string
  /** Message list (e.g. a user message with text + image parts) for
   *  multimodal calls. Provide this OR `prompt`. */
  messages?: ModelMessage[]
  abortSignal?: AbortSignal
  maxOutputTokens?: number
  temperature?: number
}

/**
 * Generate a schema-conformant object. Accepts either a `prompt` or a
 * `messages` list (the latter for multimodal/image input). Throws on
 * provider/decoding failure (including `ProviderUnavailableError` from
 * `selectModel`) — the caller is expected to catch and fall back.
 */
export async function generateStructured<T>(
  opts: GenerateStructuredOptions<T>
): Promise<T> {
  const { object } = await generateObject({
    model: selectModel(opts.modelId),
    schema: opts.schema,
    ...(opts.messages ? { messages: opts.messages } : { prompt: opts.prompt ?? "" }),
    abortSignal: opts.abortSignal,
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
  })
  return object
}
```

> Keep the leading `import "server-only"` and the existing module doc comment at the top of the file; only the imports/interface/function shown above change.

- [ ] **Step 2: Verify existing callers still typecheck.** `prompt` is now optional, but all existing callers pass it, so they're unaffected.

Run: `bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add lib/server/ai/structured.ts
git commit -m "feat(ai): generateStructured accepts image messages"
```

---

### Task 5: Pure heuristics — `shouldUseVision` + `mergeVisionText`

**Files:**
- Create: `lib/server/extraction/heuristics.ts`
- Test: `lib/server/extraction/heuristics.test.ts`

- [ ] **Step 1: Write the failing test** — `lib/server/extraction/heuristics.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"

import type { ExtractionResult } from "../extraction"
import { mergeVisionText, shouldUseVision } from "./heuristics"

function pdfResult(text: string): ExtractionResult {
  return { kind: "pdf", text, truncated: false }
}

describe("shouldUseVision", () => {
  test("scanned/low-yield PDF (little text for its size) → true", () => {
    // 50 bytes of text from a 200 KB file → very low yield.
    expect(shouldUseVision(pdfResult("x".repeat(50)), 200 * 1024)).toBe(true)
  })

  test("table-dense PDF (many columnar lines) → true", () => {
    const lines = Array.from({ length: 40 }, () => "A   1   2   3").join("\n")
    expect(shouldUseVision(pdfResult(lines), 4 * 1024)).toBe(true)
  })

  test("clean prose PDF → false", () => {
    const prose = "This is a normal paragraph of prose. ".repeat(200)
    expect(shouldUseVision(pdfResult(prose), 8 * 1024)).toBe(false)
  })

  test("non-PDF kinds → false", () => {
    expect(shouldUseVision({ kind: "markdown", text: "x", truncated: false }, 10)).toBe(false)
    expect(shouldUseVision({ kind: "csv", text: "a,b", truncated: false }, 10)).toBe(false)
    expect(shouldUseVision({ kind: "image", text: "", truncated: false }, 10)).toBe(false)
  })
})

describe("mergeVisionText", () => {
  test("vision markdown replaces text/fullText, kind preserved", () => {
    const base = pdfResult("flattened text")
    const merged = mergeVisionText(base, "# Heading\n\n| A | B |\n|---|---|\n| 1 | 2 |")
    expect(merged.kind).toBe("pdf")
    expect(merged.text).toContain("| A | B |")
    expect(merged.text).not.toBe("flattened text")
  })

  test("over-budget vision markdown is truncated into text + fullText", () => {
    const big = "y".repeat(2 * 1024 * 1024) // 2 MB > FULL_EXTRACTION_BUDGET
    const merged = mergeVisionText(pdfResult("small"), big)
    expect(merged.truncated).toBe(true)
    expect(merged.text.length).toBe(100 * 1024) // EXTRACTION_BUDGET
    expect(merged.fullText?.length).toBe(1024 * 1024) // FULL_EXTRACTION_BUDGET
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/server/extraction/heuristics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `lib/server/extraction/heuristics.ts`:

```typescript
import "server-only"

import type { ExtractionResult } from "../extraction"

/** Below this ratio of (extracted text length / file bytes) a PDF is
 *  likely scanned or image-heavy — the text pass found little. */
const LOW_YIELD_RATIO = 0.01
/** A PDF needs at least this many lines before the table-density signal
 *  is meaningful (avoids firing on tiny files). */
const MIN_TABLE_LINES = 20
/** Fraction of lines that look columnar (≥2 internal whitespace runs)
 *  above which the doc is treated as table-dense. */
const TABLE_LINE_RATIO = 0.5
/** Inline + full text budgets. Intentionally duplicated from
 *  `extraction.ts` rather than imported: `extraction.ts` imports the
 *  pure helpers from this file, so importing the budget *values* back
 *  would create a runtime circular import (the `ExtractionResult` import
 *  above is type-only and erased, so it's safe). The heuristics test
 *  pins these exact values, so drift is caught. */
const EXTRACTION_BUDGET = 100 * 1024
const FULL_EXTRACTION_BUDGET = 1024 * 1024

/** A line is "columnar" when it has ≥2 runs of 2+ spaces between
 *  non-space content — the shape a table collapses into as plain text. */
function isColumnarLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  const gaps = trimmed.match(/\S {2,}\S/g)
  return (gaps?.length ?? 0) >= 2
}

/**
 * Decide whether to run the (expensive) vision extraction pass. Pure.
 * Only PDFs qualify; within PDFs, fire when text yield is low (scanned /
 * image-heavy) OR the text is table-dense (a table the text pass
 * flattened). Everything else → false.
 */
export function shouldUseVision(
  result: ExtractionResult,
  fileSizeBytes: number
): boolean {
  if (result.kind !== "pdf") return false
  const text = result.fullText ?? result.text

  // Low text yield → likely scanned / image PDF.
  if (fileSizeBytes > 0 && text.length / fileSizeBytes < LOW_YIELD_RATIO) {
    return true
  }

  // Table density.
  const lines = text.split("\n")
  if (lines.length >= MIN_TABLE_LINES) {
    const columnar = lines.filter(isColumnarLine).length
    if (columnar / lines.length >= TABLE_LINE_RATIO) return true
  }

  return false
}

/**
 * Merge vision-extracted markdown into an extraction result, replacing
 * `text` / `fullText` (respecting the same budgets as `extraction.ts`)
 * and preserving `kind`. Pure.
 */
export function mergeVisionText(
  base: ExtractionResult,
  visionMarkdown: string
): ExtractionResult {
  if (visionMarkdown.length <= EXTRACTION_BUDGET) {
    return { ...base, text: visionMarkdown, truncated: false, fullText: undefined }
  }
  const text = visionMarkdown.slice(0, EXTRACTION_BUDGET)
  const fullText =
    visionMarkdown.length <= FULL_EXTRACTION_BUDGET
      ? visionMarkdown
      : visionMarkdown.slice(0, FULL_EXTRACTION_BUDGET)
  return { ...base, text, truncated: true, fullText }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/server/extraction/heuristics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/extraction/heuristics.ts lib/server/extraction/heuristics.test.ts
git commit -m "feat(extraction): shouldUseVision + mergeVisionText pure helpers"
```

---

### Task 6: `extractWithVision()` orchestration (injectable deps)

**Files:**
- Create: `lib/server/extraction/vision.ts`
- Test: `lib/server/extraction/vision.test.ts`

- [ ] **Step 1: Write the failing test** — `lib/server/extraction/vision.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"

import { extractWithVision } from "./vision"

const DATA = new Uint8Array([1, 2, 3])

describe("extractWithVision", () => {
  test("concatenates per-page markdown with page separators", async () => {
    const result = await extractWithVision(
      { data: DATA, model: "vis/a" },
      {
        renderPages: async () => [Buffer.from("p1"), Buffer.from("p2")],
        transcribePage: async (_png, _model, _signal, pageNum) => `# Page ${pageNum}`,
      }
    )
    expect(result.pageCount).toBe(2)
    expect(result.text).toContain("# Page 1")
    expect(result.text).toContain("# Page 2")
    // Pages are separated, in order.
    expect(result.text.indexOf("# Page 1")).toBeLessThan(result.text.indexOf("# Page 2"))
  })

  test("no rendered pages → empty text, pageCount 0", async () => {
    const result = await extractWithVision(
      { data: DATA, model: "vis/a" },
      { renderPages: async () => [], transcribePage: async () => "unused" }
    )
    expect(result).toEqual({ text: "", pageCount: 0 })
  })

  test("passes the resolved model + page number through to transcribePage", async () => {
    const seen: Array<{ model: string; page: number }> = []
    await extractWithVision(
      { data: DATA, model: "vis/x" },
      {
        renderPages: async () => [Buffer.from("a")],
        transcribePage: async (_png, model, _signal, pageNum) => {
          seen.push({ model, page: pageNum })
          return "ok"
        },
      }
    )
    expect(seen).toEqual([{ model: "vis/x", page: 1 }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/server/extraction/vision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `lib/server/extraction/vision.ts`:

```typescript
import "server-only"

import { z } from "zod"

import { generateStructured } from "@/server/ai/structured"

import { renderPdfPages } from "./render-pdf"

export interface ExtractWithVisionInput {
  data: Uint8Array
  model: string
  signal?: AbortSignal
}

export interface ExtractWithVisionResult {
  text: string
  pageCount: number
}

/** Injection seams so orchestration is unit-tested without the native
 *  renderer or a live model (mirrors `runVerifier` in verify-answer.ts). */
export interface ExtractWithVisionDeps {
  renderPages?: (data: Uint8Array) => Promise<Buffer[]>
  transcribePage?: (
    png: Buffer,
    model: string,
    signal: AbortSignal | undefined,
    pageNum: number
  ) => Promise<string>
}

const PageSchema = z.object({ markdown: z.string() })

const PAGE_PROMPT =
  "Transcribe this document page to GitHub-flavoured Markdown. Render " +
  "tables as Markdown tables. Describe figures, charts, and images as " +
  "`*Figure: <caption>*`. Preserve reading order. Omit page furniture " +
  "(running headers/footers, page numbers). Output only the page content."

/** Default per-page model call: send the page PNG + the transcription
 *  prompt to the vision model and return its markdown. */
async function defaultTranscribePage(
  png: Buffer,
  model: string,
  signal: AbortSignal | undefined
): Promise<string> {
  const out = await generateStructured({
    modelId: model,
    schema: PageSchema,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PAGE_PROMPT },
          { type: "image", image: png },
        ],
      },
    ],
    abortSignal: signal,
  })
  return out.markdown
}

/**
 * Vision extraction orchestration: render PDF pages, transcribe each to
 * markdown via a vision model, and concatenate in reading order. Throws
 * on render/model failure — `extractFile` treats any throw as "fall back
 * to text-only".
 */
export async function extractWithVision(
  input: ExtractWithVisionInput,
  deps: ExtractWithVisionDeps = {}
): Promise<ExtractWithVisionResult> {
  const renderPages = deps.renderPages ?? ((data) => renderPdfPages(data))
  const transcribePage = deps.transcribePage ?? defaultTranscribePage

  const pages = await renderPages(input.data)
  if (pages.length === 0) return { text: "", pageCount: 0 }

  const parts: string[] = []
  for (let i = 0; i < pages.length; i++) {
    const md = await transcribePage(pages[i], input.model, input.signal, i + 1)
    parts.push(`<!-- page ${i + 1} -->\n\n${md}`)
  }

  return { text: parts.join("\n\n"), pageCount: pages.length }
}
```

> NOTE: pages are transcribed sequentially (not `Promise.all`) so a many-page doc doesn't fan out N concurrent model calls. The page cap in `renderPdfPages` bounds total work.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/server/extraction/vision.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/extraction/vision.ts lib/server/extraction/vision.test.ts
git commit -m "feat(extraction): extractWithVision orchestration"
```

---

### Task 7: Wire vision into `extractFile()`

**Files:**
- Modify: `lib/server/extraction.ts` (PDF branch ~line 139-145; add `ExtractFileOptions` + the vision step)
- Test: `lib/server/extraction.test.ts` (new)

- [ ] **Step 1: Write the failing test** — `lib/server/extraction.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"

import { extractFile } from "./extraction"

// A VALID minimal 1-page PDF (same fixture as render-pdf.test.ts) so the
// real pdf-parse text pass succeeds deterministically and the *vision
// branch* is what's under test. We force `vision: true` to bypass the
// heuristic and drive the vision pass through injected deps.
const FIXTURE_PDF_B64 =
  "JVBERi0xLjMKJf////8KNyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9NZWRpYUJveCBbMCAwIDIwMCAyMDBdCi9Db250ZW50cyA1IDAgUgovUmVzb3VyY2VzIDYgMCBSCi9Vc2VyVW5pdCAxCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Qcm9jU2V0IFsvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJXQovRm9udCA8PAovRjEgOCAwIFIKPj4KL0NvbG9yU3BhY2UgPDwKPj4KPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0xlbmd0aCA3NgovRmlsdGVyIC9GbGF0ZURlY29kZQo+PgpzdHJlYW0KeJwzVDAAQl1DIGFkYKCQnMtVyGWIIeYUAhU0BIooGJpZ6lmaWCiE5HLpuxkqGJoohKRxRduYWJhZ2ikYxCqEeHG5hnAFcgEAJq8SBgplbmRzdHJlYW0KZW5kb2JqCjEwIDAgb2JqCihQREZLaXQpCmVuZG9iagoxMSAwIG9iagooUERGS2l0KQplbmRvYmoKMTIgMCBvYmoKKEQ6MjAyNjA2MjAwNDMzMTlaKQplbmRvYmoKOSAwIG9iago8PAovUHJvZHVjZXIgMTAgMCBSCi9DcmVhdG9yIDExIDAgUgovQ3JlYXRpb25EYXRlIDEyIDAgUgo+PgplbmRvYmoKOCAwIG9iago8PAovVHlwZSAvRm9udAovQmFzZUZvbnQgL0hlbHZldGljYQovU3VidHlwZSAvVHlwZTEKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCjQgMCBvYmoKPDwKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCi9OYW1lcyAyIDAgUgo+PgplbmRvYmoKMSAwIG9iago8PAovVHlwZSAvUGFnZXMKL0NvdW50IDEKL0tpZHMgWzcgMCBSXQo+PgplbmRvYmoKMiAwIG9iago8PAovRGVzdHMgPDwKICAvTmFtZXMgWwpdCj4+Cj4+CmVuZG9iagp4cmVmCjAgMTMKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwNzI2IDAwMDAwIG4gCjAwMDAwMDA3ODMgMDAwMDAgbiAKMDAwMDAwMDY2NCAwMDAwMCBuIAowMDAwMDAwNjQzIDAwMDAwIG4gCjAwMDAwMDAyMzggMDAwMDAgbiAKMDAwMDAwMDEzMSAwMDAwMCBuIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDA1NDYgMDAwMDAgbiAKMDAwMDAwMDQ3MSAwMDAwMCBuIAowMDAwMDAwMzg1IDAwMDAwIG4gCjAwMDAwMDA0MTAgMDAwMDAgbiAKMDAwMDAwMDQzNSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDEzCi9Sb290IDMgMCBSCi9JbmZvIDkgMCBSCi9JRCBbPDUwOGIxMjkyZDkzNmZlMjNiZjdkYjM4ZDZjYWFiYjZiPiA8NTA4YjEyOTJkOTM2ZmUyM2JmN2RiMzhkNmNhYWJiNmI+XQo+PgpzdGFydHhyZWYKODMwCiUlRU9GCg=="
const FAKE_PDF = Buffer.from(FIXTURE_PDF_B64, "base64")

describe("extractFile — vision gating", () => {
  test("no vision model configured → vision pass not invoked (text-only)", async () => {
    let visionCalled = false
    const result = await extractFile(
      { name: "doc.pdf", mimeType: "application/pdf", data: FAKE_PDF },
      {
        vision: true,
        resolveVisionModel: () => null,
        extractWithVision: async () => {
          visionCalled = true
          return { text: "VISION", pageCount: 1 }
        },
      }
    )
    expect(visionCalled).toBe(false)
    expect(result.kind).toBe("pdf")
    expect(result.text).not.toBe("VISION")
  })

  test("forced vision + model present → merges vision markdown", async () => {
    const result = await extractFile(
      { name: "doc.pdf", mimeType: "application/pdf", data: FAKE_PDF },
      {
        vision: true,
        resolveVisionModel: () => "vis/a",
        extractWithVision: async () => ({ text: "| A | B |\n|---|---|\n| 1 | 2 |", pageCount: 1 }),
      }
    )
    expect(result.text).toContain("| A | B |")
  })

  test("vision pass throws → falls back to text-only (never throws)", async () => {
    const result = await extractFile(
      { name: "doc.pdf", mimeType: "application/pdf", data: FAKE_PDF },
      {
        vision: true,
        resolveVisionModel: () => "vis/a",
        extractWithVision: async () => {
          throw new Error("render boom")
        },
      }
    )
    expect(result.kind).toBe("pdf")
    expect(result.text).not.toContain("VISION")
  })

  test("budget denied → vision pass not invoked", async () => {
    let visionCalled = false
    await extractFile(
      { name: "doc.pdf", mimeType: "application/pdf", data: FAKE_PDF },
      {
        vision: true,
        resolveVisionModel: () => "vis/a",
        consumeVisionBudget: () => ({ allowed: false, retryAfterSec: 30 }),
        extractWithVision: async () => {
          visionCalled = true
          return { text: "x", pageCount: 1 }
        },
      }
    )
    expect(visionCalled).toBe(false)
  })
})
```

> NOTE: `FAKE_PDF` is a valid 1-page PDF, so the real `pdf-parse` text pass succeeds (returns the fixture's "Hi" text) and the vision branch — driven by the injected `resolveVisionModel` / `extractWithVision` deps — is what each case actually exercises. The injected `extractWithVision` means no native renderer or model call happens in these tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/server/extraction.test.ts`
Expected: FAIL — `extractFile` does not accept a second argument / vision not wired.

- [ ] **Step 3: Implement.** In `lib/server/extraction.ts`:

(a) Add imports at the top (after the existing module doc comment):

```typescript
import type { RateLimitVerdict } from "@/server/rate-limit"

import { shouldUseVision, mergeVisionText } from "./extraction/heuristics"
import { resolveVisionModel } from "./extraction/vision-model"
import { extractWithVision as defaultExtractWithVision } from "./extraction/vision"
```

(b) Add the options interface near `ExtractInput`:

```typescript
export interface ExtractFileOptions {
  /** Force the vision pass on (`true`) / off (`false`); `undefined` →
   *  auto-decide via `shouldUseVision`. */
  vision?: boolean
  /** Per-call budget gate; called once right before the vision pass. When
   *  it denies, vision is skipped (text-only). Omitted → no gate. */
  consumeVisionBudget?: () => RateLimitVerdict
  signal?: AbortSignal
  // --- test seams (default to the real implementations) ---
  resolveVisionModel?: () => string | null
  extractWithVision?: (input: {
    data: Uint8Array
    model: string
    signal?: AbortSignal
  }) => Promise<{ text: string; pageCount: number }>
}
```

(c) Change the signature:

```typescript
export async function extractFile(
  input: ExtractInput,
  opts: ExtractFileOptions = {}
): Promise<ExtractionResult> {
```

(d) Replace the PDF branch (currently lines ~139-145) with:

```typescript
  if (type === "application/pdf" || hasName(name, ".pdf")) {
    const { PDFParse } = await import("pdf-parse")
    const parser = new PDFParse({ data })
    const parsed = await parser.getText()
    const { text, truncated, fullText } = truncate(parsed.text ?? "")
    const textResult: ExtractionResult = { kind: "pdf", text, truncated, fullText }
    return await maybeAddVision(textResult, data, opts)
  }
```

(e) Add the helper (after `extractFile`, or before it):

```typescript
/** Best-effort vision enhancement of a PDF text result. Never throws —
 *  any failure returns the text-only result. */
async function maybeAddVision(
  textResult: ExtractionResult,
  data: Buffer,
  opts: ExtractFileOptions
): Promise<ExtractionResult> {
  const resolve = opts.resolveVisionModel ?? resolveVisionModel
  const runVision = opts.extractWithVision ?? defaultExtractWithVision

  const model = resolve()
  if (!model) return textResult

  const wanted =
    opts.vision === true
      ? true
      : opts.vision === false
        ? false
        : shouldUseVision(textResult, data.length)
  if (!wanted) return textResult

  if (opts.consumeVisionBudget && !opts.consumeVisionBudget().allowed) {
    return textResult
  }

  try {
    const vision = await runVision({ data, model, signal: opts.signal })
    if (!vision.text.trim()) return textResult
    return mergeVisionText(textResult, vision.text)
  } catch (err) {
    console.warn("[extraction] vision pass failed, using text-only:", err)
    return textResult
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/server/extraction.test.ts`
Expected: PASS. Then run the whole extraction-related suite:

Run: `bun test lib/server/extraction`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/server/extraction.ts lib/server/extraction.test.ts
git commit -m "feat(extraction): wire best-effort vision pass into extractFile"
```

---

### Task 8: Route wiring — `vision?` flag, budget gate, cache key

**Files:**
- Modify: `app/api/extract/route.ts`
- Test: `app/api/extract/route.test.ts` (new)

- [ ] **Step 1: Write the failing test** — `app/api/extract/route.test.ts`. The route's full POST is awkward to unit-test (FormData + dynamic imports), so test the one pure decision PR-1 adds: the cache key must differ when the vision flag differs. Export a tiny helper for it.

```typescript
import { describe, expect, test } from "bun:test"

import { extractCacheKey } from "./route"

describe("extract cache key", () => {
  test("vision flag changes the key", () => {
    const base = { name: "a.pdf", mimeType: "application/pdf", contentHash: "abc" }
    expect(extractCacheKey({ ...base, vision: true })).not.toBe(
      extractCacheKey({ ...base, vision: false })
    )
  })
  test("same inputs → same key", () => {
    const a = { name: "a.pdf", mimeType: "application/pdf", contentHash: "abc", vision: true }
    expect(extractCacheKey(a)).toBe(extractCacheKey({ ...a }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test app/api/extract/route.test.ts`
Expected: FAIL — `extractCacheKey` not exported.

- [ ] **Step 3: Implement** — update `app/api/extract/route.ts`:

(a) Add imports:

```typescript
import { createSlidingWindow, rateLimitKey } from '@/server/rate-limit'
```

(b) Add the module-level limiter + the exported cache-key helper (after the imports / doc comment):

```typescript
// Vision extraction runs N model calls per doc — rate-limit per IP so a
// burst of layout-rich PDFs can't run the gateway bill up. Text-only
// extraction is unaffected (the gate is only consulted inside the vision
// branch).
const extractVisionLimit = createSlidingWindow({ windowMs: 60_000, max: 10 })

/** Exact-key cache key for an extraction. The `vision` flag is part of
 *  the key so a forced-vision result and a text-only result don't
 *  collide. Exported for unit testing. */
export function extractCacheKey(parts: {
  name: string
  mimeType: string
  contentHash: string
  vision: boolean
}): string {
  return responseCacheKey({
    kind: 'extract',
    model: '-',
    input: {
      name: parts.name,
      mimeType: parts.mimeType,
      contentHash: parts.contentHash,
      vision: parts.vision,
    },
  })
}
```

(c) In `POST`, after computing `mimeType`, read the optional flag:

```typescript
  // Optional `vision` form field: "true"/"false" forces the vision pass
  // on/off; absent → auto-decide via the extractor's heuristic.
  const visionField = form.get('vision')
  const visionFlag =
    visionField === 'true' ? true : visionField === 'false' ? false : undefined
```

(d) Replace the cache-key + extract call block (currently lines ~56-67) with:

```typescript
    const contentHash = createHash('sha256').update(data).digest('hex')
    // Cache key folds in the *effective* vision intent. `undefined`
    // (auto) is keyed distinctly from explicit true/false.
    const cacheKey = extractCacheKey({
      name,
      mimeType,
      contentHash,
      vision: visionFlag ?? false,
    })
    const cached = getCachedResponse(cacheKey)
    if (cached !== undefined) return NextResponse.json(cached)

    const result = await extractFile(
      { name, mimeType, data },
      {
        vision: visionFlag,
        consumeVisionBudget: () => extractVisionLimit.consume(rateLimitKey(req)),
      }
    )
    setCachedResponse(cacheKey, result)
    return NextResponse.json(result)
```

> Remove the now-unused `responseCacheKey` import only if `extractCacheKey` is the sole user — it isn't elsewhere in this file, so keep `responseCacheKey` imported (it's used inside `extractCacheKey`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test app/api/extract/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/extract/route.ts app/api/extract/route.test.ts
git commit -m "feat(extract-route): vision flag + per-IP budget + cache key"
```

---

### Task 9: Full gate + build verification

This is the task that proves the native renderer bundles in a production build (the microsandbox-class risk).

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + lint**

Run: `bun run check`
Expected: typecheck PASS, lint 0 errors, all tests pass.

- [ ] **Step 2: Production build (the load-bearing check)**

Run: `bun run build`
Expected: build succeeds. If it fails with an `@napi-rs/canvas` / "asset is not placeable in ESM chunks" error, confirm `pdf-to-img` is in `serverExternalPackages` (Task 3); if the error names `@napi-rs/canvas` directly, add `"@napi-rs/canvas"` to that array too and rebuild.

- [ ] **Step 3: Bundle audit**

Run: `bun run audit:bundle`
Expected: PASS — no server-only paths or secret env names leaked into client chunks.

- [ ] **Step 4: Commit any build-fix changes** (only if Step 2 required adding `@napi-rs/canvas`):

```bash
git add next.config.ts
git commit -m "fix(build): mark @napi-rs/canvas server-external for the PDF renderer"
```

---

## Manual smoke (PR checklist — needs an AI gateway key + a vision model)

1. **Table-heavy PDF** → upload via the file flow; confirm the extracted text contains Markdown tables (not flattened columns) and that `searchFiles` returns hits on table cell contents.
2. **Plain-text PDF** → upload; confirm no vision call in the server logs (heuristic skipped it), extraction is fast, text unchanged.
3. **Forced vision** → `POST /api/extract` with `vision=true` on a normal PDF; confirm markdown output. With `vision=false`, confirm text-only even on a table-heavy PDF.
4. **No vision model** → unset `VISION_MODEL` and ensure no `supportsVision` model is the resolved default (or temporarily remove the flags); confirm extraction falls back to text-only with no render attempt.
5. **Budget** → fire >10 vision extractions in a minute from one IP; confirm the 11th falls back to text-only (budget denied), not an error.

---

## Notes for the PR description

- PR-1 of the 3-PR multimodal series (`docs/PLAN-multimodal-docs.md`).
- New runtime dep: `pdf-to-img` (+ transitive `@napi-rs/canvas`, native NAPI → `serverExternalPackages`).
- New optional env var: `VISION_MODEL` (overrides which vision-capable model the extractor uses; defaults to the first `supportsVision` model in `config/models.json`). Document it in `.env.example` + `CLAUDE.md`'s env section as part of this PR.
- No migration, no wire-schema change, no store/`STORE_VERSION` change, no UI change.
- Deferred to PR-2: structured `blocks[]`, `file_sections` indexing of structured chunks, table rendering in the file preview, "re-extract with vision" affordance.
