/**
 * Neutralize `w:sym` symbols in a parsed docx-preview document BEFORE it
 * is rendered.
 *
 * docx-preview (0.3.x) renders a symbol run as
 *
 *     span.innerHTML = `&#x${elem.char};`
 *
 * where `elem.char` is the raw, unvalidated `w:sym/@w:char` attribute.
 * A crafted .docx with `w:char="41;<img src=x onerror=…>"` therefore
 * injects live HTML into the app origin (the viewer renders into a plain
 * div, not an iframe). The renderer isn't exported, so instead of
 * patching it we fix the model it renders: every symbol whose `char` is
 * not a 1–6 digit hex code point gets U+FFFD instead. A valid hex value
 * can only ever produce a single character reference — `&#xD800;` or
 * `&#x110000;` parse to U+FFFD, never markup.
 *
 * The walk is generic (every object reachable from the document, minus
 * back-references and the zip package) so symbols in headers, footers,
 * footnotes, endnotes and comments are covered as well as the body.
 * `sanitize-symbols.test.ts` pins the docx-preview internals this relies
 * on (`type: "symbol"`, `char`, the `innerHTML` sink) so an upgrade that
 * changes them fails loudly instead of silently reopening the hole.
 */

const SAFE_SYMBOL_CHAR = /^[0-9a-fA-F]{1,6}$/
const REPLACEMENT_CHAR = "FFFD"

/** Keys never walked: back-references and the raw zip / parser state. */
function skipKey(key: string): boolean {
  return key === "parent" || key.startsWith("_")
}

/** Returns how many symbols were neutralized. Mutates `root` in place. */
export function neutralizeDocxSymbols(root: unknown): number {
  let fixed = 0
  const seen = new WeakSet<object>()
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (typeof node !== "object" || node === null) continue
    if (seen.has(node)) continue
    seen.add(node)
    if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) continue
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child)
      continue
    }
    const rec = node as Record<string, unknown>
    if (rec.type === "symbol" && "char" in rec) {
      const c = rec.char
      if (typeof c !== "string" || !SAFE_SYMBOL_CHAR.test(c)) {
        rec.char = REPLACEMENT_CHAR
        fixed++
      }
    }
    for (const key of Object.keys(rec)) {
      if (skipKey(key)) continue
      stack.push(rec[key])
    }
  }
  return fixed
}
