/**
 * Resolve the backend base URL env value (`NEXT_PUBLIC_AGENT_PY_URL`) into
 * the prefix the API client puts in front of `/v1/...`.
 *
 * Three shapes:
 *
 * - **Absolute URL** (`http://localhost:8000`, `https://api.example.com/`)
 *   → that origin/path with trailing slashes stripped. Cross-origin.
 * - **Same origin** — `/` (or a path prefix such as `/backend`) → the
 *   backend sits behind the same reverse proxy as the frontend
 *   (`PLAN-frontend-backend-split.md` Q21), so requests go to
 *   `/v1/...` on the page's own origin. `/` resolves to the empty
 *   prefix, which is why "configured" is tracked separately from the
 *   prefix: an empty `baseUrl` no longer means "unset".
 * - **Unset / blank** → not configured; callers fall through to the
 *   in-Next routes.
 *
 * Pure so both runtimes (and tests) can share it.
 */

export interface BackendBaseUrl {
  /** Whether the backend is available as a dispatch target at all. */
  configured: boolean
  /** Prefix for `${baseUrl}/v1/...`. `""` for same origin (`/`) and
   *  for unset — check `configured` to tell them apart. */
  baseUrl: string
  /** True when requests stay on the page's own origin (relative URL). */
  sameOrigin: boolean
}

const UNSET: BackendBaseUrl = { configured: false, baseUrl: "", sameOrigin: false }

export function resolveBackendBaseUrl(raw: string | undefined | null): BackendBaseUrl {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return UNSET
  // A single leading slash = path on the current origin. `//host` is a
  // protocol-relative URL (another origin), so it takes the absolute
  // branch below.
  const sameOrigin = trimmed.startsWith("/") && !trimmed.startsWith("//")
  return {
    configured: true,
    baseUrl: trimmed.replace(/\/+$/, ""),
    sameOrigin,
  }
}
