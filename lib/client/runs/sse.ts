import "client-only"

/**
 * Incremental SSE parser for run streams — the part `@ag-ui/client`'s own
 * `parseSSEStream` drops: it ignores the `id:` field, and the `id:` is the
 * replay cursor (RUN_EVENTS.md § 6.1/6.2).
 *
 * Follows the WHATWG event-stream rules that matter here: lines end in
 * `\n`, `\r\n` or `\r`; `data:` lines join with `\n`; one optional space
 * after the colon is dropped; `:` lines are comments (agent-py's
 * keep-alives); a blank line dispatches. Unlike a browser `EventSource`,
 * `id` is reported only for a message that carries one — run streams send
 * `RUN_STARTED`, a `gap` and the closing events without an id, and those
 * must not inherit the previous event's cursor.
 *
 * Pure (no I/O).
 */

export interface SseMessage {
  /** The message's own `id:` field, when it has one. */
  id?: string
  data: string
}

export class SseParser {
  private buffer = ""
  private data: string[] = []
  private id: string | undefined
  private pendingCR = false

  /** Feed decoded text; returns every message it completed. */
  push(chunk: string): SseMessage[] {
    let text = chunk
    // A `\r\n` split across chunks: the `\r` already ended the line.
    if (this.pendingCR && text.startsWith("\n")) text = text.slice(1)
    this.pendingCR = false
    this.buffer += text
    const out: SseMessage[] = []
    let start = 0
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i]
      if (ch !== "\n" && ch !== "\r") continue
      this.line(this.buffer.slice(start, i), out)
      if (ch === "\r") {
        if (i + 1 === this.buffer.length) this.pendingCR = true
        else if (this.buffer[i + 1] === "\n") i++
      }
      start = i + 1
    }
    this.buffer = this.buffer.slice(start)
    return out
  }

  /** End of stream: a message without its blank line is dropped (per
   *  spec) — the caller treats the stream as cut short. */
  end(): void {
    this.buffer = ""
    this.data = []
    this.id = undefined
  }

  private line(line: string, out: SseMessage[]): void {
    if (line === "") {
      if (this.data.length > 0) {
        out.push(
          this.id === undefined
            ? { data: this.data.join("\n") }
            : { id: this.id, data: this.data.join("\n") },
        )
      }
      this.data = []
      this.id = undefined
      return
    }
    if (line.startsWith(":")) return
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") this.data.push(value)
    else if (field === "id" && !value.includes("\0")) this.id = value
  }
}

/** Every message of a complete SSE body (tests, fixtures). */
export function parseSseBody(body: string): SseMessage[] {
  const parser = new SseParser()
  const out = parser.push(body)
  parser.end()
  return out
}
