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
  // --- runs ---
  // A background run: without a token it can only be refused (background
  // runs require sign-in), so the auth cases get their 401 even though
  // `startRun` also admits anonymous interactive callers.
  startRun: {
    threadId: "00000000-0000-4000-8000-000000000000",
    runId: "00000000-0000-4000-8000-0000000000bb",
    messages: [{ id: "m1", role: "user", content: "Conformance probe: say hi." }],
    forwardedProps: { mode: "background", goal: "Conformance probe", maxSteps: 1 },
  },
  // --- editor (0.6.0, Q104) ---
  // Both admit anonymous callers, so only the malformed / non-Bearer token
  // cases apply (`ANONYMOUS_OK` in auth.test.ts).
  editorAiCommand: {
    messages: [{ role: "user", parts: [{ type: "text", text: "Conformance probe: say hi." }] }],
    document: { isSelecting: false, generateContext: null, edit: null, commentContext: "" },
    toolName: "generate",
  },
  editorAiComplete: { blockText: "Conformance probe" },
  // --- 0.8.0 (wave 12): extraction, summaries, bookmarks, MCP ---
  // Anonymous callers may use all but upsertMcpServer, so for those only
  // the malformed / non-Bearer token cases apply in auth.test.ts.
  // `extractFile` is multipart: these are its form fields (`file` a text
  // file's content — see `formBody`).
  extractFile: { file: "Conformance probe: a short text file." },
  summarize: { mode: "file", name: "probe.txt", text: "Conformance probe: the sky is blue." },
  fetchUrl: { url: "https://example.com/" },
  // A link-local endpoint: every MCP outbound policy refuses it, so even a
  // signed-in or anonymous caller that got past auth never reaches it.
  mcpProxy: { server: { id: "conformance-mcp", name: "Probe", url: "http://169.254.169.254/mcp" } },
  upsertMcpServer: {
    id: "conformance-mcp",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    name: "Probe",
    url: "https://example.com/mcp",
    credentials: { headers: { Authorization: "Bearer probe" } },
  },
  // In-place answer to a sub-agent run's question (0.5.0, Q59).
  answerRun: {
    resume: [{ interruptId: "conformance-question", status: "resolved", payload: { approved: false } }],
  },
}

/**
 * A value for every path parameter the spec uses (`{name}` in a path).
 * `call` substitutes these, so an operation with a templated path is
 * exercised at a real-looking URL rather than a literal `{token}`.
 */
export const pathParams: Record<string, string> = {
  token: "conformance-unknown-share-token",
  id: "00000000-0000-4000-8000-0000000000aa",
  runId: "00000000-0000-4000-8000-0000000000cc",
  serverId: "conformance-mcp",
  action: "discover",
}
