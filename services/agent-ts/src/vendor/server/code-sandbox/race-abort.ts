// VENDORED from `lib/server/code-sandbox/race-abort.ts` (Next app) at commit afc33009135d6166adb4196598350638a8aafc3f.
// Frozen copy — agent-ts is frozen (docs/PLAN-frontend-backend-split.md Q11); do not extend.
// Fixes to the original no longer propagate here. Only import specifiers were rewritten
// (`@/server/*` / `@/shared/*` → relative, `@/config/*` → `@config/*`) unless a
// "VENDOR DEVIATION" note below says otherwise.

import "server-only"

/** Sentinel returned by `raceAbort` when the signal fires before the promise
 *  settles. */
export const ABORTED = Symbol("aborted")

/**
 * Resolve as soon as EITHER `promise` settles OR `signal` aborts:
 * - signal aborts first → resolves with the `ABORTED` sentinel (and attaches a
 *   no-op `catch` to `promise` so its later rejection isn't "unhandled").
 * - `promise` resolves first → resolves with its value.
 * - `promise` rejects first → the rejection propagates.
 * - no signal → just awaits `promise`.
 *
 * Pure (no I/O) so it unit-tests without booting anything.
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T | typeof ABORTED> {
  if (!signal) return promise
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.resolve(ABORTED)
  }
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {})
      resolve(ABORTED)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener("abort", onAbort)
        reject(e)
      },
    )
  })
}
