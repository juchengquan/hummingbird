import "client-only"

import { apiClient } from "@/client/api-client"

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
 * so this helper itself stays dumb — except for `tainted`: a turn the
 * server flagged as having read third-party content (attachments, web /
 * MCP / file tools) is skipped outright, so injected text can't become
 * a durable memory through extraction.
 */
export function extractAfterTurn(
  turnText: string,
  conversationId: string,
  opts?: { tainted?: boolean },
): void {
  if (opts?.tainted) return
  // `apiClient.memory.extract` never rejects (failures resolve `false`).
  void apiClient.memory.extract({ turnText, conversationId })
}
