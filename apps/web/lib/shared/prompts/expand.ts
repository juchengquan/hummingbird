/**
 * Pure helpers for the prompt library's templating syntax.
 *
 * Templates are plain text with `{variable}` markers. Variable
 * names are user-visible labels (not identifiers) — any non-empty
 * trimmed string between the braces. The same variable can appear
 * multiple times and is filled once.
 *
 * Escape: `{{` produces a literal `{`, `}}` produces a literal `}`.
 * This way users can include braces in their output by doubling
 * them — a single `{` always introduces a variable marker.
 */

export interface ParsedTemplate {
  /** Original template, verbatim. */
  template: string
  /** Variable names in first-appearance order, deduplicated. */
  variables: string[]
  /** Segment stream for rendering / inline highlights. */
  segments: TemplateSegment[]
}

export type TemplateSegment =
  | { kind: "text"; value: string }
  | { kind: "var"; name: string }

/** Sentinel for escaped `{{` → `{`. Must be a single char that never
 *  appears in user input (null byte). */
const ESC_OPEN = "\x00"
/** Sentinel for escaped `}}` → `}`. */
const ESC_CLOSE = "\x01"

const VAR_RE = /\{([^{}]+)\}/g

/**
 * Walks the template once, splitting into text + variable segments
 * and collecting variable names in order. Handles `{{` / `}}`
 * escape sequences first so literal braces aren't picked up as
 * variable markers.
 *
 * `{name}` → variable (name trimmed, 1+ non-brace chars).
 * `{{` → literal `{`.
 * `}}` → literal `}`.
 * Unmatched `{` without matching `}` → literal text.
 */
export function parseTemplate(template: string): ParsedTemplate {
  // First pass: replace escape sequences with sentinels so the
  // variable regex doesn't mistake `{{hello}}` for a variable.
  const escaped = template.replace(/\{\{/g, ESC_OPEN).replace(/\}\}/g, ESC_CLOSE)

  const segments: TemplateSegment[] = []
  const seen = new Set<string>()
  const variables: string[] = []
  let cursor = 0

  for (const match of escaped.matchAll(VAR_RE)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const name = match[1].trim()
    if (!name) continue
    if (start > cursor) {
      segments.push({ kind: "text", value: unescape(escaped.slice(cursor, start)) })
    }
    segments.push({ kind: "var", name })
    if (!seen.has(name)) {
      seen.add(name)
      variables.push(name)
    }
    cursor = end
  }
  if (cursor < escaped.length) {
    segments.push({ kind: "text", value: unescape(escaped.slice(cursor)) })
  }
  return { template, variables, segments }
}

/**
 * Substitutes the values from `fills` into a template. Missing
 * variables are left as `{name}` in the output so the user can
 * see what's still unfilled.
 *
 * Whitespace tolerance: a value that's `undefined` or `null`
 * leaves the marker in place; an empty string substitutes empty
 * (intentional — user may want to suppress a section).
 */
export function expandTemplate(
  template: string,
  fills: Record<string, string | undefined | null>
): string {
  // Escape literal brace pairs before substitution.
  let result = template.replace(/\{\{/g, ESC_OPEN).replace(/\}\}/g, ESC_CLOSE)
  result = result.replace(VAR_RE, (match, raw) => {
    const name = String(raw).trim()
    if (!name) return match
    const value = fills[name]
    if (value === undefined || value === null) return match
    return value
  })
  return unescape(result)
}

function unescape(s: string): string {
  return s.replace(new RegExp(ESC_OPEN, "g"), "{").replace(new RegExp(ESC_CLOSE, "g"), "}")
}
