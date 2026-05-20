/**
 * Pure detection for the chat input's smart-paste chip.
 *
 * Takes a paste string, returns the highest-precedence match or `null`.
 * No external calls, no async, no React. Safe to call on every keystroke
 * if needed; the caller drives when to run it.
 *
 * Precedence (highest first):
 *   url      → single-token https(s) URL
 *   json     → starts with `{`/`[` and parses
 *   csv      → 3+ comma-separated lines with consistent column count
 *   code     → fenced block or 2+ syntax keywords
 *   longText → ≥ 500 chars and nothing else matched
 */

export type PasteKind = "url" | "json" | "csv" | "code" | "longText"

export interface PasteDetection {
  kind: PasteKind
  /** The pasted text, possibly trimmed at the edges. */
  snippet: string
  /** Character length of the snippet. */
  length: number
  /** Line count, useful for chip labels ("CSV · 12 rows"). */
  lineCount: number
  /** Detected language for code (extension-style). Undefined for non-code. */
  language?: string
  /** Detected URL string when kind === 'url'. */
  url?: string
}

// JSON.parse can be expensive on big inputs; only attempt below this size.
const JSON_MAX_BYTES = 1_000_000
// Minimum length to qualify as longText after no other match.
const LONG_TEXT_MIN = 500

const CODE_KEYWORDS = [
  "function ",
  "const ",
  "let ",
  "var ",
  "import ",
  "export ",
  "def ",
  "class ",
  "public ",
  "private ",
  "async ",
  "await ",
  "return ",
  "=> ",
  "type ",
  "interface ",
  "#include",
  "package ",
]

const URL_RE = /^https?:\/\/[^\s]+$/i

export function detectPasteKind(input: string): PasteDetection | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const length = trimmed.length
  const lineCount = trimmed.split(/\r?\n/).length

  // 1. URL — most specific, must be a single token.
  if (URL_RE.test(trimmed) && !trimmed.includes("\n")) {
    return { kind: "url", snippet: trimmed, length, lineCount: 1, url: trimmed }
  }

  // 2. JSON — starts with { or [, parses cleanly.
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && length <= JSON_MAX_BYTES) {
    try {
      JSON.parse(trimmed)
      return { kind: "json", snippet: trimmed, length, lineCount }
    } catch {
      /* fall through */
    }
  }

  // 3. Code — explicit fence wins outright.
  const hasFence = trimmed.includes("```")
  // 4. CSV — only when not obviously code.
  if (!hasFence && looksLikeCSV(trimmed, lineCount)) {
    return { kind: "csv", snippet: trimmed, length, lineCount }
  }

  // 5. Code keywords / fence.
  if (hasFence || hasCodeKeywords(trimmed)) {
    return {
      kind: "code",
      snippet: trimmed,
      length,
      lineCount,
      language: guessLanguage(trimmed),
    }
  }

  // 6. Long prose fallback.
  if (length >= LONG_TEXT_MIN) {
    return { kind: "longText", snippet: trimmed, length, lineCount }
  }

  return null
}

function looksLikeCSV(text: string, totalLines: number): boolean {
  if (totalLines < 3) return false
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 3) return false
  // Inspect first 5 lines for consistent comma counts.
  const sample = lines.slice(0, 5).map((l) => countCommasOutsideQuotes(l))
  const first = sample[0]
  if (first < 1) return false
  return sample.every((c) => Math.abs(c - first) <= 1)
}

function countCommasOutsideQuotes(line: string): number {
  let count = 0
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === "," && !inQuotes) count++
  }
  return count
}

function hasCodeKeywords(text: string): boolean {
  let hits = 0
  for (const kw of CODE_KEYWORDS) {
    if (text.includes(kw)) {
      hits++
      if (hits >= 2) return true
    }
  }
  return false
}

/**
 * Cheap language guess based on a few signature tokens. Returns the
 * extension-style label the chat-route's existing system prompt
 * understands ('typescript', 'python', etc.). Undefined when ambiguous.
 */
function guessLanguage(text: string): string | undefined {
  // Strip a leading fence to look at the actual code.
  const stripped = text.replace(/^```[a-z]*\n/, "").replace(/\n```$/, "")
  if (/\b(def |import .*from |if __name__ ==)/.test(stripped)) return "python"
  if (/\b(interface |type |const .*:\s*\w|=>\s*\(?[^)]*\)?)/.test(stripped)) {
    if (/\bReact\.|<\w+\s|tsx\b/.test(stripped)) return "tsx"
    return "typescript"
  }
  if (/\b(function |var |let )/.test(stripped) && /\b(console\.log|require\()/.test(stripped)) {
    return "javascript"
  }
  if (/\b(package |func |fmt\.)/.test(stripped)) return "go"
  if (/\b(fn |let mut |impl )/.test(stripped)) return "rust"
  if (/\b(public class |System\.out)/.test(stripped)) return "java"
  if (/\b(SELECT |INSERT |UPDATE |DELETE )/i.test(stripped)) return "sql"
  return undefined
}
