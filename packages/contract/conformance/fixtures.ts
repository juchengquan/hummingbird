/**
 * A schema-valid request body for every operation that takes one. The
 * auth cases send these without (or with a bad) token, so the only reason
 * a backend can reject them is authentication. `tests/spec.test.ts`
 * checks each body against its operation's request schema and that every
 * operation with a request body has an entry here.
 */
export const validRequestBodies: Record<string, unknown> = {
  refreshImageUrl: {
    storage_path: "00000000-0000-4000-8000-000000000000/images/conformance.png",
  },
  refreshFileUrl: {
    storagePath: "00000000-0000-4000-8000-000000000000/files/conformance.csv",
  },
  createShare: {
    kind: "conversation",
    conversationId: "00000000-0000-4000-8000-000000000000",
  },
  extractTable: {
    reportText: "Conformance probe: the sky is blue [s1].",
    sources: [{ title: "Probe source", url: "https://example.com/sky", snippet: "The sky is blue." }],
    columnHints: ["Claim", { label: "Year", type: "number" }],
  },
  embedFile: {
    fileId: "00000000-0000-4000-8000-000000000000",
    text: "Conformance probe: a short paragraph to embed.",
  },
  extractMemory: {
    turnText: "User: I write Rust at work.\n\nAssistant: Noted.",
    conversationId: "00000000-0000-4000-8000-000000000000",
  },
  reportCspViolation: {
    "csp-report": {
      "document-uri": "https://app.example.com/dashboard",
      "effective-directive": "script-src-elem",
      "blocked-uri": "https://cdn.example.com/x.js",
      disposition: "report",
    },
  },
  // --- schedules ---
  createSchedule: {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    name: "Conformance probe",
    prompt: "Summarise the news.",
    cron: "0 8 * * *",
    timezone: "UTC",
  },
  updateSchedule: { enabled: false },
}

/**
 * A value for every path parameter the spec uses (`{name}` in a path).
 * `call` substitutes these, so an operation with a templated path is
 * exercised at a real-looking URL rather than a literal `{token}`.
 */
export const pathParams: Record<string, string> = {
  token: "conformance-unknown-share-token",
  id: "00000000-0000-4000-8000-0000000000aa",
}
