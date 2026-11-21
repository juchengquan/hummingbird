/**
 * Whether the share pages read from the backend (`GET /v1/share/{token}`
 * in the browser) or resolve server-side with the service-role key.
 *
 * Backend when `NEXT_PUBLIC_AGENT_PY_URL` is configured — an absolute URL
 * or `/` for same origin (see `resolveBackendBaseUrl`). Unset → today's
 * server path, unchanged (PLAN-frontend-backend-split Q4: nothing is
 * removed until Phase 5). Pure; the env value is passed in so both the
 * Server Component and tests can call it.
 */
import { resolveBackendBaseUrl } from "@/shared/backend-base-url"

export function shareReadsFromBackend(agentPyUrl: string | undefined | null): boolean {
  return resolveBackendBaseUrl(agentPyUrl).configured
}
