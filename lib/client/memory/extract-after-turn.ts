import "client-only"

/**
 * Best-effort, post-turn extraction trigger.
 *
 * Fires `POST /api/memory/extract` for the just-finished turn and never
 * throws — extraction is opportunistic background work, so any failure
 * (offline, route 5xx, malformed body) is swallowed. The caller does not
 * await this; it's `void`-returned by design so a chat turn never waits
 * on (or is broken by) memory upkeep.
 *
 * Gating lives at the call site (signed-in + `memoryEnabled`) and again
 * server-side in `extractFacts` (sign-in + `profiles.memory_enabled`),
 * so this helper itself stays dumb.
 */
export function extractAfterTurn(turnText: string, conversationId: string): void {
  void fetch("/api/memory/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnText, conversationId }),
  }).catch(() => {})
}
