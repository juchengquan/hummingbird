import "client-only"

/**
 * Mutate a rehydrated store snapshot in place to convert every known
 * date-bearing field from its persisted ISO-string form back to a
 * real `Date` object.
 *
 * Zustand-persist serializes state via `JSON.stringify` which turns
 * `Date` into `"…ISO 8601…"`. `JSON.parse` keeps the string. Nothing
 * in the store revives them, so post-rehydrate every field typed as
 * `Date` in `@/shared/types` is actually a `string` at runtime — the
 * TS type lies. Any caller that reaches for a `Date`-only method
 * like `.toISOString()` crashes (the bug fixed defensively in PR #6
 * + #7).
 *
 * This helper runs once at `onRehydrateStorage` time, walks every
 * persisted slice + its known date fields, and replaces strings with
 * real Dates. After it returns, the TS types match runtime truth
 * and the defensive `toISO()` helper at wire boundaries becomes a
 * pure pass-through.
 *
 * Adding a fourth date-bearing slice (or a new date field on an
 * existing one) only needs an edit to `DATE_FIELDS_BY_SLICE`.
 */

/** Slice name (a key on the partialized store) → date-typed fields
 *  on its row shape. Optional Date fields (`deletedAt?: Date`) are
 *  still listed — the conversion no-ops on fields that are missing
 *  or already a non-string value. */
const DATE_FIELDS_BY_SLICE: Record<string, readonly string[]> = {
  workspaces: ["createdAt", "updatedAt"],
  conversations: ["createdAt", "updatedAt"],
  files: ["uploadedAt", "deletedAt"],
  resources: ["addedAt"],
  conversationFiles: ["addedAt"],
  mcpServers: ["createdAt", "updatedAt", "deletedAt"],
  mcpResources: ["addedAt", "deletedAt"],
  mcpResourceBindings: ["addedAt"],
  conversationMcpResources: ["addedAt"],
  urlBookmarks: ["fetchedAt", "createdAt", "updatedAt", "deletedAt"],
  conversationUrlBookmarks: ["addedAt"],
  notes: ["createdAt", "updatedAt"],
  artifacts: ["createdAt"],
  documents: ["createdAt", "updatedAt"],
  prompts: ["createdAt", "updatedAt", "deletedAt"],
}

export function reviveDates(state: Record<string, unknown>): void {
  for (const [slice, fields] of Object.entries(DATE_FIELDS_BY_SLICE)) {
    const rows = state[slice]
    if (!Array.isArray(rows)) continue
    for (const row of rows as Array<Record<string, unknown>>) {
      if (!row || typeof row !== "object") continue
      for (const field of fields) {
        const v = row[field]
        if (typeof v === "string") row[field] = new Date(v)
      }
    }
  }

  // Messages live nested on each conversation, not their own slice.
  // `Message.timestamp: Date` carries the same string-vs-Date hazard.
  const conversations = state.conversations
  if (Array.isArray(conversations)) {
    for (const c of conversations as Array<Record<string, unknown>>) {
      const messages = c?.messages
      if (!Array.isArray(messages)) continue
      for (const m of messages as Array<Record<string, unknown>>) {
        if (!m || typeof m !== "object") continue
        if (typeof m.timestamp === "string") m.timestamp = new Date(m.timestamp)
      }
    }
  }
}
