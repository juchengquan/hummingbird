/**
 * URL allowlist checks for HTML we build ourselves and inject via
 * `dangerouslySetInnerHTML` / `innerHTML` (markdown preview, docx
 * preview). React's own `javascript:` URL blocking does not apply to
 * those sinks, so every user/model-controlled href or src has to pass
 * through here first.
 *
 * Allowlist, not blocklist:
 *   - links:  http:, https:, mailto:, and scheme-less (relative,
 *             protocol-relative, fragment, query) URLs.
 *   - images: http:, https:, scheme-less, and raster
 *             `data:image/(png|jpeg|gif|webp)` (never SVG).
 *
 * The scheme is read from a *normalized* copy of the URL that is at
 * least as decoded as what the browser sees: HTML character references
 * (`java&#x09;script:`, `&colon;`), percent-encoding (`%6Aavascript:`),
 * and every whitespace / control / invisible char are removed before
 * the check. Over-decoding only ever makes us stricter (a URL the
 * browser would treat as a harmless relative path may be rejected),
 * never laxer.
 */

const LINK_SCHEMES = new Set(["http", "https", "mailto"])
const IMAGE_SCHEMES = new Set(["http", "https"])
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp)[;,]/

/** Named references that decode to chars relevant to scheme parsing. */
const NAMED_ENTITIES: Record<string, string> = {
  colon: ":",
  tab: "\t",
  newline: "\n",
  nbsp: "\u00a0",
  period: ".",
  plus: "+",
  sol: "/",
  num: "#",
  quest: "?",
  amp: "&",
  percnt: "%",
}

// Numeric refs are decoded by browsers with or without the trailing `;`.
const NUMERIC_ENTITY_RE = /&#(?:x([0-9a-f]+)|(\d+));?/gi
const NAMED_ENTITY_RE = /&([a-z]+);/gi
const PERCENT_RE = /%([0-9a-f]{2})/gi
// C0 controls + space, DEL + C1 controls, and common invisible chars
// (soft hyphen, zero-width, bidi marks, line/paragraph separators, BOM).
const STRIP_RE = /[\u0000-\u0020\u007f-\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/g

const MAX_DECODE_PASSES = 8

function decodeOnce(input: string): string {
  return input
    .replace(NUMERIC_ENTITY_RE, (_, hex: string | undefined, dec: string | undefined) => {
      const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec ?? "", 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ""
      try {
        return String.fromCodePoint(code)
      } catch {
        return ""
      }
    })
    .replace(NAMED_ENTITY_RE, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
    .replace(PERCENT_RE, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * Decode entities + percent-encoding to a fixed point (bounded), strip
 * whitespace/control/invisible chars everywhere, and lowercase.
 */
export function normalizeUrlForSchemeCheck(raw: string): string {
  let s = raw
  for (let i = 0; i < MAX_DECODE_PASSES; i++) {
    const next = decodeOnce(s)
    if (next === s) break
    s = next
  }
  return s.replace(STRIP_RE, "").toLowerCase()
}

/**
 * The scheme of a normalized URL, or `null` when it has none (relative,
 * protocol-relative, fragment, query). Any `:` before the first `/`,
 * `?` or `#` counts as a scheme delimiter -- even if the prefix isn't a
 * syntactically valid scheme -- so odd prefixes fail closed against the
 * allowlist rather than slipping through as "relative".
 */
function schemeOf(normalized: string): string | null {
  const m = /^([^/?#]*?):/.exec(normalized)
  return m ? m[1] : null
}

/** True when `url` is safe to emit as an `<a href>`. */
export function isSafeLinkUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string") return false
  const scheme = schemeOf(normalizeUrlForSchemeCheck(url))
  return scheme === null || LINK_SCHEMES.has(scheme)
}

/** True when `url` is safe to emit as an `<img src>`. */
export function isSafeImageUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string") return false
  const normalized = normalizeUrlForSchemeCheck(url)
  const scheme = schemeOf(normalized)
  if (scheme === null || IMAGE_SCHEMES.has(scheme)) return true
  return scheme === "data" && SAFE_DATA_IMAGE_RE.test(normalized)
}

/**
 * True for absolute http(s) links (including protocol-relative `//host`)
 * -- the ones that should carry `rel="noopener noreferrer"`.
 */
export function isExternalHttpUrl(url: string): boolean {
  const normalized = normalizeUrlForSchemeCheck(url)
  const scheme = schemeOf(normalized)
  if (scheme === "http" || scheme === "https") return true
  return scheme === null && /^[/\\]{2}/.test(normalized)
}
