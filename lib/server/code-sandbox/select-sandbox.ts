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
