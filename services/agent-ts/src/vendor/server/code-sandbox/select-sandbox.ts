// VENDORED from `lib/server/code-sandbox/select-sandbox.ts` (Next app) at commit afc33009135d6166adb4196598350638a8aafc3f.
// Frozen copy — agent-ts is frozen (docs/PLAN-frontend-backend-split.md Q11); do not extend.
// Fixes to the original no longer propagate here. Only import specifiers were rewritten
// (`@/server/*` / `@/shared/*` → relative, `@/config/*` → `@config/*`) unless a
// "VENDOR DEVIATION" note below says otherwise.

import "server-only"

import { hasSandboxConfig } from "./config"
import { createMicrosandboxClient } from "./microsandbox-client"
import type { CodeSandbox } from "./types"

/** Pick the configured sandbox backend, or null when none is configured.
 *  microsandbox is the only backend today; the env seam
 *  (CODE_SANDBOX_BASE_URL) keeps E2B / others droppable without touching
 *  call sites — mirrors model-provider.ts. */
export function selectSandbox(): CodeSandbox | null {
  if (!hasSandboxConfig()) return null
  return createMicrosandboxClient()
}
