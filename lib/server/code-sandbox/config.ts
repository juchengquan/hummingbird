import "server-only"

/** Wall-clock cap per run (ms). Env override: CODE_SANDBOX_TIMEOUT_MS. */
export const RUN_TIMEOUT_MS = Number(process.env.CODE_SANDBOX_TIMEOUT_MS) || 30_000
/** stdout/stderr char cap. */
export const STDOUT_CAP = Number(process.env.CODE_SANDBOX_STDOUT_CAP) || 256_000
/** Total result bytes cap (sum of image payloads). */
export const RESULT_CAP = Number(process.env.CODE_SANDBOX_RESULT_CAP) || 10_000_000
/** microVM resources. */
export const MEM_MIB = Number(process.env.CODE_SANDBOX_MEM_MIB) || 512
export const CPUS = Number(process.env.CODE_SANDBOX_CPUS) || 1

/** True when a local/remote sandbox runtime is configured. Mirrors the
 *  model-provider.ts custom-base-URL gating: absent → the skill is never
 *  registered (no mock — code execution has no meaningful mock). */
export function hasSandboxConfig(): boolean {
  return !!process.env.CODE_SANDBOX_BASE_URL
}

export function sandboxConfig(): { baseUrl: string; apiKey: string | undefined } | null {
  const baseUrl = process.env.CODE_SANDBOX_BASE_URL
  if (!baseUrl) return null
  return { baseUrl, apiKey: process.env.CODE_SANDBOX_API_KEY }
}
