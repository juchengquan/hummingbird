import "server-only"

const norm = (s: string) => s.trim().toLowerCase()

/** Pick which fact ids a forget request targets. Exact (normalized) match
 *  wins; otherwise any fact that contains the text or is contained by it;
 *  otherwise none. Pure. */
export function matchFactsToForget(
  facts: { id: string; fact: string }[],
  text: string,
): string[] {
  const t = norm(text)
  if (!t) return []
  const exact = facts.filter((f) => norm(f.fact) === t).map((f) => f.id)
  if (exact.length) return exact
  return facts
    .filter((f) => {
      const nf = norm(f.fact)
      return nf.includes(t) || t.includes(nf)
    })
    .map((f) => f.id)
}

/** Offer the remember/forget tools only when memory is on for this turn. */
export function shouldOfferMemoryTools(opts: {
  enabled: boolean
  memoryBypass?: boolean
}): boolean {
  return opts.enabled && !opts.memoryBypass
}
