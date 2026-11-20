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
 * The turn also starts tainted when the REQUEST already carries
 * third-party content (`requestTaint`): attached files, URL bookmarks or
 * MCP resources, uploaded images / files in the messages, or tool
 * results in the history. `forgetFact` is refused on a tainted turn too
 * (injected text could wipe memories just as well as plant them), and
 * the route reports the taint to the client in the stream's `finish`
 * frame so post-turn auto-extraction skips the turn.
 *
 * Safe-by-default: every tool counts as untrusted EXCEPT the short
 * allowlist below (tools whose results are produced by us, not read from
 * outside). A newly added skill or MCP tool therefore taints the turn
 * without anyone having to remember to list it.
 */

export const REMEMBER_FACT_TOOL = "rememberFact"
export const FORGET_FACT_TOOL = "forgetFact"

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

/** Fresh per-turn taint, optionally pre-seeded from `requestTaint`. */
export function createTurnTaint(initial: string | null = null): TurnTaint {
  return { taintedBy: initial }
}

/** Minimal message shape (wire `ModelMessage`) the request scan reads. */
interface RequestMessage {
  role: string
  content: unknown
}

/**
 * Third-party content the request itself puts in the model's context,
 * as a short label (or null when none). User-typed text and the
 * workspace prompt are user-authored; everything below is not:
 *  - attachments: uploaded files' extracted text, URL bookmarks' fetched
 *    pages, MCP resources (all read from outside);
 *  - `image` / `file` parts in user messages (uploaded content);
 *  - tool results after the latest user message (this turn's tool
 *    output replayed by the client) — any `tool`-role message, or a
 *    `tool-result` part from an untrusted tool.
 */
export function requestTaint(req: {
  attachments?: ReadonlyArray<{ kind: string }>
  messages: ReadonlyArray<RequestMessage>
}): string | null {
  for (const att of req.attachments ?? []) {
    if (att.kind === "file") return "an attached file"
    if (att.kind === "url_bookmark") return "an attached URL bookmark"
    if (att.kind === "mcp_resource") return "an attached MCP resource"
    return "an attachment"
  }
  let lastUser = -1
  req.messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i
  })
  for (const [i, m] of req.messages.entries()) {
    const parts = Array.isArray(m.content) ? (m.content as unknown[]) : []
    if (m.role === "user") {
      for (const p of parts) {
        const type = (p as { type?: unknown } | null)?.type
        if (type === "image" || type === "file") return "an uploaded image or file"
      }
    }
    if (i < lastUser) continue
    if (m.role === "tool") return "a tool result in the history"
    for (const p of parts) {
      const part = p as { type?: unknown; toolName?: unknown } | null
      if (
        part?.type === "tool-result" &&
        (typeof part.toolName !== "string" || isUntrustedContentTool(part.toolName))
      ) {
        return "a tool result in the history"
      }
    }
  }
  return null
}

/** Tool result returned instead of saving. Phrased for the model to relay. */
export function rememberRefusal(taintedBy: string) {
  return {
    ok: false,
    refused: true,
    error:
      `Not saved: this turn already includes external content (via ${taintedBy}), ` +
      "and memory can't be written in the same turn as attachments, web, file or " +
      "tool lookups (protection against prompt injection from that content). Tell " +
      "the user the fact was NOT remembered, and that they can ask you to remember " +
      "it in a new message without attachments if they want it saved.",
  }
}

/** `forgetFact` counterpart of `rememberRefusal`. */
export function forgetRefusal(taintedBy: string) {
  return {
    ok: false,
    refused: true,
    removed: 0,
    error:
      `Not removed: this turn already includes external content (via ${taintedBy}), ` +
      "and memory can't be changed in the same turn (protection against prompt " +
      "injection from that content). Tell the user nothing was forgotten, and that " +
      "they can ask again in a new message without attachments.",
  }
}

type ExecFn = (this: unknown, ...args: unknown[]) => unknown

/**
 * Return a copy of `tools` with the policy applied for one turn:
 *  - each untrusted tool's `execute` marks `taint` before running (so a
 *    `rememberFact` issued in a later step — or in parallel in the same
 *    step — sees it), then delegates unchanged;
 *  - `rememberFact` / `forgetFact` return their refusal once tainted.
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
    if (name === REMEMBER_FACT_TOOL || name === FORGET_FACT_TOOL) {
      const refuse = name === REMEMBER_FACT_TOOL ? rememberRefusal : forgetRefusal
      out[name] = {
        ...(tool as object),
        execute: (...args: unknown[]) =>
          taint.taintedBy !== null ? refuse(taint.taintedBy) : original.apply(tool, args),
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
