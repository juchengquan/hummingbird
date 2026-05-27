/**
 * Client-side decoder for the agent wire format — the consumer half of
 * `wire.ts`. The task route streams the AI-SDK UI message stream over
 * SSE (`data: <json>\n\n` frames, terminated by `data: [DONE]`); each
 * frame is one stream part. We pull the `data-agent-event` parts out
 * and hand back `TaskEvent`s to fold through `reduceRun`.
 *
 * `fromDataPart` returns null for the SDK's own control frames (start /
 * finish) and the `[DONE]` sentinel, so those are skipped without a
 * special case here. Isomorphic: only Web-standard `ReadableStream` /
 * `TextDecoder`, so it's unit-testable without a browser.
 */

import type { TaskEvent } from "./events"
import { fromDataPart } from "./wire"

/** Pull the JSON payload out of one SSE event block, or null for the
 *  `[DONE]` sentinel / a block carrying no `data:` line / malformed
 *  JSON. */
function parseSseData(block: string): unknown {
  const dataLines: string[] = []
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  const joined = dataLines.join("\n")
  if (joined === "[DONE]") return null
  try {
    return JSON.parse(joined)
  } catch {
    return null
  }
}

/**
 * Decode an SSE response body into a stream of `TaskEvent`s. Drops any
 * frame that isn't a well-formed `data-agent-event` part (graceful
 * degradation, per the wire-codec contract) — never throws on bad input.
 */
export async function* decodeTaskEventStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<TaskEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const data = parseSseData(block)
        if (data == null) continue
        const event = fromDataPart(data)
        if (event) yield event
      }
    }
    // A final frame may arrive without its trailing blank line.
    buffer += decoder.decode()
    if (buffer.trim().length > 0) {
      const data = parseSseData(buffer)
      const event = data == null ? null : fromDataPart(data)
      if (event) yield event
    }
  } finally {
    reader.releaseLock()
  }
}
