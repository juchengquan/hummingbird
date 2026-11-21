import "client-only"

/**
 * Test support: the recorded agent-py run streams (`agent-py/*.sse`,
 * re-recorded by `bun run fixtures:runs`) and a model of the store
 * message they are applied to. Imported by tests only — never by app
 * code (it reads the filesystem).
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import type { NormalisedFrame } from "@/client/chat/sse-frame-translator"
import { finishToolCall, startToolCall } from "@/client/chat/tool-call-buffer"
import type { LiveToolCall } from "@/components/skills/tool-call-strip"

import type { RunSink } from "../session"
import { parseSseBody } from "../sse"
import type { AgUiEvent } from "../types"

const DIR = join(import.meta.dir, "agent-py")

export interface RecordedStream {
  name: string
  body: string
  items: Array<{ cursor: string | null; event: AgUiEvent }>
}

export function fixtureNames(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sse"))
    .map((f) => f.slice(0, -4))
    .sort()
}

export function loadFixture(name: string): RecordedStream {
  const body = readFileSync(join(DIR, `${name}.sse`), "utf8")
  const items = parseSseBody(body).map((m) => ({
    cursor: m.id ?? null,
    event: JSON.parse(m.data) as AgUiEvent,
  }))
  return { name, body, items }
}

/** What an assistant message holds after frames are applied — the store
 *  fields `use-chat-send` writes, with the same per-frame semantics
 *  (append text / reasoning; the tool-call buffer; parts appended, or set
 *  for suggestions / verification / routed model; ui / mcp parts
 *  idempotent on id). */
export interface ModelMessage {
  content: string
  reasoning: string
  toolCalls: LiveToolCall[]
  images: unknown[]
  files: unknown[]
  codeResults: unknown[]
  uiParts: Array<{ id: string }>
  mcpApps: Array<{ id: string }>
  suggestions?: string[]
  verification?: unknown
  routedModel?: string
}

export function emptyMessage(): ModelMessage {
  return {
    content: "",
    reasoning: "",
    toolCalls: [],
    images: [],
    files: [],
    codeResults: [],
    uiParts: [],
    mcpApps: [],
  }
}

export class ModelSink implements RunSink {
  message: ModelMessage = emptyMessage()
  clears = 0

  frame(f: NormalisedFrame): void {
    const m = this.message
    switch (f.type) {
      case "text":
        m.content += f.value ?? ""
        break
      case "reasoning":
        m.reasoning += f.value ?? ""
        break
      case "tool_call":
        if (f.id && f.name) m.toolCalls = startToolCall(m.toolCalls, { id: f.id, name: f.name, args: f.args })
        break
      case "tool_result":
        if (f.id) m.toolCalls = finishToolCall(m.toolCalls, { id: f.id, summary: f.summary, results: f.results })
        break
      case "tool_image":
        m.images.push(...(f.images ?? []))
        break
      case "tool_file":
        m.files.push(...(f.files ?? []))
        break
      case "code_result":
        m.codeResults.push({ id: f.id, stdout: f.stdout, stderr: f.stderr, results: f.codeCells })
        break
      case "ui_part":
        if (f.id && !m.uiParts.some((p) => p.id === f.id)) m.uiParts.push({ id: f.id })
        break
      case "mcp_app":
        if (f.id && !m.mcpApps.some((p) => p.id === f.id)) m.mcpApps.push({ id: f.id })
        break
      case "suggestions":
        m.suggestions = f.values
        break
      case "verification":
        m.verification = f.verification
        break
      case "routed_model":
        m.routedModel = f.value
        break
    }
  }

  clear(): void {
    this.clears += 1
    this.message = emptyMessage()
  }
}

/** A message built by applying `frames` to an empty placeholder. */
export function messageOf(frames: readonly NormalisedFrame[]): ModelMessage {
  const sink = new ModelSink()
  for (const f of frames) sink.frame(f)
  return sink.message
}

/** A `fetch` serving SSE bodies by URL (path + query), recording calls. */
export interface FakeCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

export function fakeFetch(
  routes: (call: FakeCall, index: number) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError")
    const call: FakeCall = {
      url: input.toString(),
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return routes(call, calls.length - 1)
  }) as typeof fetch
  return { fetch: f, calls }
}

export function sseResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", ...headers },
  })
}

/** A Map-backed `localStorage` stand-in. */
export function memoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}
