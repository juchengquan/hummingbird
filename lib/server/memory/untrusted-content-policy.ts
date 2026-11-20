import "server-only"

/**
 * Prompt-injection → persistent-memory guard for one chat turn.
 *
 * `rememberFact` writes to long-term memory that is injected into EVERY
 * future conversation. If the model has, earlier in the same turn, read
 * attacker-controllable content (a fetched page, search results, an MCP
 * tool's output, a file/sandbox read), that content could instruct it to
 * "remember" something — a persistent injection. Policy: once any
 * untrusted-content tool has executed in a turn, later `rememberFact`
 * calls in that turn are refused with a tool result telling the model to
 * have the user ask explicitly in a fresh message.
 *
 * Safe-by-default: every tool counts as untrusted EXCEPT the short
 * allowlist below (tools whose results are produced by us, not read from
 * outside). A newly added skill or MCP tool therefore taints the turn
 * without anyone having to remember to list it.
 */

export const REMEMBER_FACT_TOOL = "rememberFact"

/** Tools whose results carry no third-party content. */
const TRUSTED_TOOLS: ReadonlySet<string> = new Set([
  "rememberFact",
  "forgetFact",
  "renderUI", // echoes the model's own structured UI spec
  "generateImage", // returns a URL to an image we generated
])

/** True when executing `toolName` may put untrusted content in context. */
export function isUntrustedContentTool(toolName: string): boolean {
  return !TRUSTED_TOOLS.has(toolName)
}

export interface TurnTaint {
  /** First untrusted tool that ran this turn, or null. */
  taintedBy: string | null
}

export function createTurnTaint(): TurnTaint {
  return { taintedBy: null }
}

/** Tool result returned instead of saving. Phrased for the model to relay. */
export function rememberRefusal(taintedBy: string) {
  return {
    ok: false,
    refused: true,
    error:
      `Not saved: this turn already read external content (via \`${taintedBy}\`), ` +
      "and memory can't be written in the same turn as web, file or tool lookups " +
      "(protection against prompt injection from that content). Tell the user the " +
      "fact was NOT remembered, and that they can ask you to remember it in a new " +
      "message if they want it saved.",
  }
}

type ExecFn = (this: unknown, ...args: unknown[]) => unknown

/**
 * Return a copy of `tools` with the policy applied for one turn:
 *  - each untrusted tool's `execute` marks `taint` before running (so a
 *    `rememberFact` issued in a later step — or in parallel in the same
 *    step — sees it), then delegates unchanged;
 *  - `rememberFact`'s `execute` returns `rememberRefusal` once tainted.
 * Tools without an `execute` are passed through untouched.
 */
export function applyMemoryWritePolicy<T extends Record<string, unknown>>(
  tools: T,
  taint: TurnTaint
): T {
  const out: Record<string, unknown> = {}
  for (const [name, tool] of Object.entries(tools)) {
    const execute =
      tool && typeof tool === "object"
        ? (tool as { execute?: unknown }).execute
        : undefined
    if (typeof execute !== "function") {
      out[name] = tool
      continue
    }
    const original = execute as ExecFn
    if (name === REMEMBER_FACT_TOOL) {
      out[name] = {
        ...(tool as object),
        execute: (...args: unknown[]) =>
          taint.taintedBy !== null
            ? rememberRefusal(taint.taintedBy)
            : original.apply(tool, args),
      }
    } else if (isUntrustedContentTool(name)) {
      out[name] = {
        ...(tool as object),
        execute: (...args: unknown[]) => {
          taint.taintedBy ??= name
          return original.apply(tool, args)
        },
      }
    } else {
      out[name] = tool
    }
  }
  return out as T
}
