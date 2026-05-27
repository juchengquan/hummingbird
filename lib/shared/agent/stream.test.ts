import { describe, expect, test } from "bun:test"

import type { TaskEvent } from "./events"
import { projectRun } from "./project"
import { decodeTaskEventStream } from "./stream"
import { toDataPart } from "./wire"

/** Build an SSE response body from raw frame strings, chunked at the
 *  given byte boundaries to exercise the buffering across reads. */
function sseStream(frames: string[], chunkSize = Infinity): ReadableStream<Uint8Array> {
  const text = frames.map((f) => `data: ${f}\n\n`).join("") + "data: [DONE]\n\n"
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize))
      }
      controller.close()
    },
  })
}

function evt(seq: number, body: Partial<TaskEvent> & { kind: TaskEvent["kind"] }): TaskEvent {
  return {
    runId: "r1",
    seq,
    step: 1,
    createdAt: new Date(seq).toISOString(),
    ...body,
  } as TaskEvent
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<TaskEvent[]> {
  const out: TaskEvent[] = []
  for await (const e of decodeTaskEventStream(stream)) out.push(e)
  return out
}

describe("decodeTaskEventStream", () => {
  test("decodes agent-event frames and skips [DONE]", async () => {
    const events: TaskEvent[] = [
      evt(1, { kind: "status", status: "running", step: 0 }),
      evt(2, { kind: "token", text: "hello" }),
      evt(3, { kind: "result", status: "done" }),
    ]
    const frames = events.map((e) => JSON.stringify(toDataPart(e)))
    const got = await collect(sseStream(frames))
    expect(got).toEqual(events)
  })

  test("reassembles events split across read boundaries", async () => {
    const events: TaskEvent[] = [
      evt(1, { kind: "token", text: "abc" }),
      evt(2, { kind: "token", text: "def" }),
    ]
    const frames = events.map((e) => JSON.stringify(toDataPart(e)))
    // 1-byte chunks force the \n\n delimiter to straddle reads.
    const got = await collect(sseStream(frames, 1))
    const view = projectRun(got)
    expect(view.text).toBe("abcdef")
  })

  test("drops foreign / malformed frames without throwing", async () => {
    const valid = JSON.stringify(toDataPart(evt(1, { kind: "token", text: "ok" })))
    const frames = [
      JSON.stringify({ type: "start" }), // SDK control frame
      "{ not json",
      JSON.stringify({ type: "data-agent-event", data: { kind: "bogus" } }),
      valid,
    ]
    const got = await collect(sseStream(frames))
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ kind: "token", text: "ok" })
  })
})
