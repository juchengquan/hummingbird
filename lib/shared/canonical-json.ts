/**
 * Deterministic JSON: object keys sorted at EVERY depth, so two values
 * that are deep-equal serialise identically regardless of insertion
 * order. Use for hashing / fingerprinting.
 *
 * (Not `JSON.stringify(v, Object.keys(v).sort())` — an array replacer is
 * a key whitelist applied to nested objects too, so nested keys not
 * present at the top level are silently dropped.)
 *
 * Follows `JSON.stringify` semantics otherwise: `undefined` / function
 * members are omitted from objects and become `null` in arrays,
 * `toJSON` (e.g. `Date`) is honoured.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value)) ?? ""
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  const maybeToJson = (value as { toJSON?: unknown }).toJSON
  if (typeof maybeToJson === "function") {
    return sortKeysDeep((maybeToJson as () => unknown).call(value))
  }
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
  }
  return out
}
