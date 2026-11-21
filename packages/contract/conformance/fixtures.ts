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
}
