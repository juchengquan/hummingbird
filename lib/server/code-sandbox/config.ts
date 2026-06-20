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
/** Max microVMs booting/running at once across the process. Each holds
 *  ~MEM_MIB of guest RAM, so this caps memory on a small self-host VM when
 *  several runCode calls arrive together; excess runs queue for a slot. */
export const MAX_CONCURRENT = Number(process.env.CODE_SANDBOX_MAX_CONCURRENT) || 2

/** OCI image for the Python runtime. It MUST already contain the
 *  scientific stack (numpy/pandas/matplotlib): the sandbox runs airgapped
 *  (`.disableNetwork()`), so there is no `pip install` at run time. Default
 *  is the Jupyter scipy image — verified to boot under microsandbox with the
 *  stack importable and `matplotlib.savefig` working. It is large (~GBs);
 *  point CODE_SANDBOX_PYTHON_IMAGE at a slimmer self-hosted image to trim it. */
export const PYTHON_IMAGE = process.env.CODE_SANDBOX_PYTHON_IMAGE || "jupyter/scipy-notebook"
/** OCI image for the JavaScript runtime. Stock Node — JS promises no libs. */
export const JS_IMAGE = process.env.CODE_SANDBOX_JS_IMAGE || "node"

/** Per-mounted-file decoded byte cap. */
export const MOUNT_FILE_MAX = Number(process.env.CODE_SANDBOX_MOUNT_FILE_MAX) || 10_000_000
/** Total decoded bytes across all mounted files in one run. */
export const MOUNT_TOTAL_MAX = Number(process.env.CODE_SANDBOX_MOUNT_TOTAL_MAX) || 20_000_000
/** Max number of mounted files in one run. */
export const MOUNT_COUNT_MAX = Number(process.env.CODE_SANDBOX_MOUNT_COUNT_MAX) || 10
/** Guest directory mounted files land in. */
export const MOUNT_DIR = "/mnt/files"

/** Rich-table caps (runCode PR-3). Over-cap → truncated + a note. */
export const TABLE_MAX_COLS = Number(process.env.CODE_SANDBOX_TABLE_MAX_COLS) || 50
export const TABLE_MAX_ROWS = Number(process.env.CODE_SANDBOX_TABLE_MAX_ROWS) || 1000
export const TABLE_CELL_MAX = Number(process.env.CODE_SANDBOX_TABLE_CELL_MAX) || 500

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
