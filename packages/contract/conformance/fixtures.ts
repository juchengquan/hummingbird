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
}

/**
 * A value for every path parameter the spec uses (`{name}` in a path).
 * `call` substitutes these, so an operation with a templated path is
 * exercised at a real-looking URL rather than a literal `{token}`.
 */
export const pathParams: Record<string, string> = {
  token: "conformance-unknown-share-token",
}
