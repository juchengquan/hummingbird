// Runs once when the Next.js server starts (`instrumentation.ts`
// convention). Node runtime only: the checks below read deploy env.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  // Per-IP rate limits silently degrade when no reverse proxy sits in
  // front of `next start` — say so at boot (heuristic, see the helper).
  const { warnOnProxyConfig } = await import("@/server/rate-limit")
  warnOnProxyConfig()
}
