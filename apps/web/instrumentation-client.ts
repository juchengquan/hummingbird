import { config } from "zod"

// Runs before hydration (Next.js `instrumentation-client` convention).
//
// Zod 4 probes for `eval` support (`Function("")`) and, when it's
// available, JIT-compiles object parsers with `new Function`. The
// strict CSP (`proxy.ts`) has no 'unsafe-eval': while Report-Only the
// probe succeeds and every compiled schema files a violation report;
// once enforced the probe fails over to the interpreter but still
// reports once per page. Opting out up front keeps the CSP report
// stream clean. Browser-only — server-side parsing keeps the JIT.
config({ jitless: true })
