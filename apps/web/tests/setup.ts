// Test-time setup. Preloaded before any test file via `bunfig.toml`.
//
// Stubs the two runtime-barrier packages so test files can import either
// server-only or client-only modules without `bun test` blowing up at
// module-load time:
//
//   - `server-only` throws under default conditions (Node), used by
//     `lib/server/**`
//   - `client-only` throws under `react-server` condition, used by
//     `lib/client/**`
//
// In tests we don't care about the runtime — we just want to exercise
// the module's pure logic. Replacing both with empty modules lets us
// import freely. Production builds are unaffected: Next.js never sees
// these stubs because they only register on the `bun test` process.

import { mock } from "bun:test"

mock.module("server-only", () => ({}))
mock.module("client-only", () => ({}))

// `@/client/files/local-store` calls `indexedDB` at module top-level
// inside its blob helpers. We never want to touch IDB in tests, so
// stub the module surface with no-op functions and never let the
// IDB code path run.
mock.module("@/client/files/local-store", () => ({
  deleteBlob: async () => {},
  clearAll: async () => {},
  storeBlob: async () => {},
  loadBlob: async () => null,
  hasBlob: async () => false,
}))
