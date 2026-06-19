import "server-only"

import { tool } from "ai"
import { z } from "zod"

import { RUN_TIMEOUT_MS, hasSandboxConfig } from "@/server/code-sandbox/config"
import { selectSandbox } from "@/server/code-sandbox/select-sandbox"
import type { ServerSkill } from "@/server/skills/registry"

const PROMPT = [
  "You have a `runCode` tool: it runs Python in a sandboxed microVM and",
  "returns stdout/stderr plus any charts. Prefer it for real computation,",
  "data analysis, and plotting instead of guessing numeric answers.",
  "pandas, numpy, and matplotlib are available. There is no network access.",
  "Print results you want shown (the sandbox is not a notebook — only stdout",
  "is captured). For charts, save figures to /tmp, e.g.",
  "`plt.savefig('/tmp/plot.png')` — saved PNG/SVG files are returned as images.",
  "If you pass `files`, they are mounted at `/mnt/files/<name>` — read them",
  "there (e.g. `pd.read_csv('/mnt/files/data.csv')`).",
  "To return a table, write JSON to a /tmp/<name>.table.json file as",
  '`{"columns": [...], "rows": [[...], ...]}` — or with pandas',
  "`df.to_json('/tmp/out.table.json', orient='split')`. It renders as a grid.",
  "Set `language: 'javascript'` to run Node.js instead of Python (default).",
  "For JavaScript use `console.log` for output; the file conventions are the",
  "same (mounted files at /mnt/files/<name>, tables to /tmp/<name>.table.json).",
  "Charts via matplotlib `savefig` are Python-only.",
].join(" ")

export const codeInterpreterSkill: ServerSkill = {
  id: "codeInterpreter",
  toolName: "runCode",
  buildTool(_requestEntry, ctx) {
    if (!hasSandboxConfig()) return null
    return tool({
      description:
        "Run Python or JavaScript (Node.js) in a sandboxed microVM and return stdout/stderr plus charts/tables. No network.",
      inputSchema: z.object({
        code: z.string().min(1).max(50_000),
        language: z.enum(["python", "javascript"]).optional(),
        files: z.array(z.string().max(500)).max(10).optional(),
      }),
      execute: async ({ code, files, language }, { abortSignal }) => {
        const gate = ctx.consumeBudget?.()
        if (gate && !gate.allowed) {
          return {
            ok: false,
            stdout: "",
            stderr: "",
            results: [],
            error: {
              code: "budget" as const,
              message: `Rate limited. Retry in ${gate.retryAfterSec}s.`,
            },
          }
        }
        // Resolve any model-named files to sandbox mount specs. The
        // resolver (provided by the chat route only for this skill) is
        // best-effort: it never throws, and folds any per-file failures
        // into `notes` we surface to the model via stderr.
        let mountFiles: { path: string; bytes: Uint8Array }[] | undefined
        const mountNotes: string[] = []
        if (files?.length && ctx.resolveMountFiles) {
          const resolved = await ctx.resolveMountFiles(files)
          mountFiles = resolved.files
          mountNotes.push(...resolved.notes)
        }
        const sandbox = selectSandbox()
        if (!sandbox) {
          return {
            ok: false,
            stdout: "",
            stderr: "",
            results: [],
            error: {
              code: "upstream" as const,
              message: "Sandbox unavailable.",
            },
          }
        }
        const result = await sandbox.run({
          code,
          language: language ?? "python",
          timeoutMs: RUN_TIMEOUT_MS,
          signal: abortSignal,
          ...(mountFiles ? { files: mountFiles } : {}),
        })
        // Surface mount notes so the model can adapt (prepend to stderr).
        if (mountNotes.length) {
          return {
            ...result,
            stderr: [...mountNotes, result.stderr].filter(Boolean).join("\n"),
          }
        }
        return result
      },
    })
  },
  promptFragment() {
    return PROMPT
  },
}
