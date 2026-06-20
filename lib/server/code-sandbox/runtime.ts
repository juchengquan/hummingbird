import "server-only"

import { JS_IMAGE, PYTHON_IMAGE } from "./config"

/** Languages `runCode` can execute. */
export type CodeSandboxLanguage = "python" | "javascript"

/** Per-language microsandbox runtime: which image to boot, the exec command,
 *  and the inline-code flag. The image is env-overridable (see config.ts) —
 *  the Python default carries numpy/pandas/matplotlib because the sandbox is
 *  airgapped and cannot pip-install at run time. Unknown input defaults to
 *  python (the route's Zod enum already rejects bad values; belt-and-suspenders). */
export function runtimeFor(
  language: CodeSandboxLanguage,
): { image: string; cmd: string; flag: string } {
  if (language === "javascript") {
    return { image: JS_IMAGE, cmd: "node", flag: "-e" }
  }
  return { image: PYTHON_IMAGE, cmd: "python3", flag: "-c" }
}
