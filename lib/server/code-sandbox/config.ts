import "server-only"

/** Wall-clock cap per run (ms). Env override: CODE_SANDBOX_TIMEOUT_MS. */
export const RUN_TIMEOUT_MS = Number(process.env.CODE_SANDBOX_TIMEOUT_MS) || 30_000
/** stdout/stderr char cap. */
export const STDOUT_CAP = Number(process.env.CODE_SANDBOX_STDOUT_CAP) || 256_000
/** Total result-payload bytes cap (text + images + tables). */
export const RESULT_CAP = Number(process.env.CODE_SANDBOX_RESULT_CAP) || 10_000_000
/** Max result files (charts/tables) read back from /tmp per run — bounds
 *  memory before the marshaller applies RESULT_CAP. */
export const RESULT_FILE_MAX = Number(process.env.CODE_SANDBOX_RESULT_FILE_MAX) || 20
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

function isEnabled(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === "1" || s === "true" || s === "yes" || s === "on"
}

/** True when the runCode sandbox is enabled. microsandbox runs embedded (no
 *  URL), so `CODE_SANDBOX_ENABLED=1` is the canonical local switch;
 *  `CODE_SANDBOX_BASE_URL` also enables it and is reserved for a future remote
 *  backend (the local microVM runtime ignores the URL). Absent → the skill is
 *  never registered (no mock — code execution has no meaningful mock). */
export function hasSandboxConfig(): boolean {
  return isEnabled(process.env.CODE_SANDBOX_ENABLED) || !!process.env.CODE_SANDBOX_BASE_URL
}

/** Non-null when the sandbox is enabled. `baseUrl` is undefined for the default
 *  embedded microsandbox runtime; it's populated only for the reserved remote
 *  path. The client uses this purely as an enabled-gate. */
export function sandboxConfig(): { baseUrl: string | undefined; apiKey: string | undefined } | null {
  if (!hasSandboxConfig()) return null
  return { baseUrl: process.env.CODE_SANDBOX_BASE_URL, apiKey: process.env.CODE_SANDBOX_API_KEY }
}
