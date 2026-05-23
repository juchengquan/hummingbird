/**
 * Pure helpers for the prompt library's templating syntax.
 *
 * Templates are plain text with `{{variable}}` markers. Variable
 * names are user-visible labels (not identifiers) — any non-empty
 * trimmed string between the braces. The same variable can appear
 * multiple times and is filled once.
 *
 * No escape syntax in v1. If a user genuinely needs literal `{{`
 * in output, the workaround is `{ {` with a space; revisit if
 * anyone hits the limit.
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

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

/**
 * Walks the template once, splitting into text + variable segments
 * and collecting variable names in order. The regex matches a non-
 * greedy run of non-brace characters between `{{` and `}}`, with
 * whitespace tolerated inside the braces.
 *
 * Empty (`{{}}`), whitespace-only (`{{ }}`), and nested-brace cases
 * are treated as literal text — the regex's `[^{}]+?` class refuses
 * to match empty or to consume inner braces.
 */
export function parseTemplate(template: string): ParsedTemplate {
  const segments: TemplateSegment[] = []
  const seen = new Set<string>()
  const variables: string[] = []
  let cursor = 0
  // Reset lastIndex so repeated calls don't leak state via the
  // module-scoped regex.
  VAR_RE.lastIndex = 0
  for (const match of template.matchAll(VAR_RE)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const name = match[1].trim()
    // Whitespace-only / empty braces match the regex but yield an empty
    // name after trim. Skip without advancing the cursor — the surrounding
    // text emit on the next iteration (or the final tail slice) will
    // include the braces as literal text. Same behavior as not matching
    // at all.
    if (!name) continue
    if (start > cursor) {
      segments.push({ kind: "text", value: template.slice(cursor, start) })
    }
    segments.push({ kind: "var", name })
    if (!seen.has(name)) {
      seen.add(name)
      variables.push(name)
    }
    cursor = end
  }
  if (cursor < template.length) {
    segments.push({ kind: "text", value: template.slice(cursor) })
  }
  return { template, variables, segments }
}

/**
 * Substitutes the values from `fills` into a template. Missing
 * variables are left as `{{name}}` in the output so the user can
 * see what's still unfilled (the variable-fill modal makes this
 * impossible in practice, but the function tolerates it).
 *
 * Whitespace tolerance: a value that's `undefined` or `null`
 * leaves the marker in place; an empty string substitutes empty
 * (intentional — user may want to suppress a section).
 */
export function expandTemplate(
  template: string,
  fills: Record<string, string | undefined | null>
): string {
  return template.replace(VAR_RE, (match, raw) => {
    const name = String(raw).trim()
    // Whitespace-only braces are literal text — mirror parseTemplate's
    // behavior so `{{}}` and `{{ }}` round-trip consistently through
    // parse → expand.
    if (!name) return match
    const value = fills[name]
    if (value === undefined || value === null) return match
    return value
  })
}
