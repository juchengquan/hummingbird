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
].join(" ")

export const codeInterpreterSkill: ServerSkill = {
  id: "codeInterpreter",
  toolName: "runCode",
  buildTool(_requestEntry, ctx) {
    if (!hasSandboxConfig()) return null
    return tool({
      description:
        "Run Python in a sandboxed microVM and return stdout/stderr plus charts (matplotlib). No network.",
      inputSchema: z.object({ code: z.string().min(1).max(50_000) }),
      execute: async ({ code }, { abortSignal }) => {
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
        return sandbox.run({
          code,
          language: "python",
          timeoutMs: RUN_TIMEOUT_MS,
          signal: abortSignal,
        })
      },
    })
  },
  promptFragment() {
    return PROMPT
  },
}
