/**
 * Shared types of the runs client (`lib/client/runs/`). Isomorphic and
 * type-only, so `backend-resolver.ts` and `api-client.ts` can name them
 * without pulling the runs transport into their bundles.
 */

/** Where a run request goes — `resolveRunsTarget()` in
 *  `lib/client/api/backend-resolver.ts`. */
export interface RunsTarget {
  /** agent-py's base URL (`""` = same origin, Q21). */
  baseUrl: string
  /** The Supabase session JWT (`Authorization: Bearer`), or `null` for an
   *  anonymous run, addressed by its `X-Run-Token` (Q20/Q34). */
  authToken: string | null
}
