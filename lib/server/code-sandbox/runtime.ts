import "server-only"

/** Languages `runCode` can execute. */
export type CodeSandboxLanguage = "python" | "javascript"

/** Per-language microsandbox runtime: which image to boot, the exec
 *  command, and the inline-code flag. Spike-verified (2026-06-19): the
 *  `node` image runs JS; the `python` image has no node. Pure. Unknown
 *  input defaults to python (the route's Zod enum already rejects bad
 *  values; this is belt-and-suspenders). */
export function runtimeFor(
  language: CodeSandboxLanguage,
): { image: string; cmd: string; flag: string } {
  if (language === "javascript") {
    return { image: "node", cmd: "node", flag: "-e" }
  }
  return { image: "python", cmd: "python3", flag: "-c" }
}
