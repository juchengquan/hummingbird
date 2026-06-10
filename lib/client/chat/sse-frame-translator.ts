"use client"
import "client-only"

/**
 * SSE frame translator — re-shapes AI SDK v5 UI message stream frames
 * (`text-delta`, `reasoning-delta`, `tool-input-available`,
 * `tool-output-available`, `data-tool-image`, `data-suggestions`,
 * `error`, plus lifecycle frames) into the small internal envelope
 * `use-chat-send.ts` consumes.
 *
 * Pure — no React, no Zustand, no fetch. Lives in `lib/client/chat/`
 * (rather than `lib/shared/`) only because the chat panel is the
 * sole caller; promote to `lib/shared/` if anything else ever needs
 * to consume SSE frames the same way.
 *
 * PLAN-useChat-adoption.md Phase B.2.
 */

/** Shape the chat-send hook reads. The translator below re-shapes
 *  AI SDK v5 frames into this internal envelope so the handler block
 *  stays small. The legacy custom format on the wire was retired in
 *  B.3 of PLAN-useChat-adoption.md. */
export interface NormalisedFrame {
  type?: string
  value?: string
  values?: string[]
  code?: string
  message?: string
  id?: string
  name?: string
  args?: unknown
  summary?: string
  results?: Array<{ title?: string; url?: string; snippet?: string }>
  mode?: string
  images?: unknown[]
  /** Generative-UI part kind (info-table in v1). Carried on
   *  `type: "ui_part"` frames. The render-side validates against the
   *  shared `UiPartSchema` before render — invalid parts drop silently. */
  kind?: string
  /** Per-kind props for a `ui_part` frame, validated client-side
   *  against the shared schema before render. */
  props?: unknown
}

/** Decode one SSE payload (the JSON between `data: ` and `\n\n`) and
 *  translate it into our internal shape. Returns null when the frame
 *  is one of the AI SDK lifecycle no-ops (start, start-step,
 *  text-start/end, reasoning-start/end, finish-step, finish) or
 *  when the payload doesn't parse — the handler ignores it. */
export function translateFrame(payload: string): NormalisedFrame | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(payload)
  } catch {
    return null
  }
  const t = raw.type
  if (typeof t !== "string") return null

  // AI SDK error frames carry the human-readable text on
  // `errorText`. Re-shape into the internal `{type:"error",message}`
  // envelope the handler block expects. The optional `code` rides
  // alongside so the consumer can render a typed inline error bubble
  // (rate_limit / auth / context_window / provider …) — services
  // emit it from their provider-error categoriser.
  if (t === "error" && typeof raw.errorText === "string") {
    const out: NormalisedFrame = { type: "error", message: raw.errorText }
    if (typeof raw.code === "string") out.code = raw.code
    return out
  }

  // AI SDK v5 frame types. Re-shape into the internal logical
  // envelope the handler block expects.
  if (t === "text-delta" && typeof raw.delta === "string") {
    return { type: "text", value: raw.delta }
  }
  if (t === "reasoning-delta" && typeof raw.delta === "string") {
    return { type: "reasoning", value: raw.delta }
  }
  if (t === "tool-input-available") {
    const toolCallId = raw.toolCallId
    const toolName = raw.toolName
    if (typeof toolCallId === "string" && typeof toolName === "string") {
      return {
        type: "tool_call",
        id: toolCallId,
        name: toolName,
        args: raw.input,
      }
    }
    return null
  }
  if (t === "tool-output-available") {
    const toolCallId = raw.toolCallId
    if (typeof toolCallId !== "string") return null
    // `output` is a JSON-stringified `{summary, results?}` object per
    // `lib/server/chat/sse-emitter.ts`. Parse it back so we can pull
    // the summary + sources strip results.
    let summary: string | undefined
    let results:
      | Array<{ title?: string; url?: string; snippet?: string }>
      | undefined
    if (typeof raw.output === "string") {
      try {
        const out = JSON.parse(raw.output) as {
          summary?: unknown
          results?: unknown
        }
        if (typeof out.summary === "string") summary = out.summary
        if (Array.isArray(out.results)) {
          results = out.results.filter(
            (r): r is { title?: string; url?: string; snippet?: string } =>
              typeof r === "object" && r !== null,
          )
        }
      } catch {
        // ignore — summary stays undefined and the pill shows "done"
      }
    }
    // The emitter also sends `errorText` on the AI SDK side when
    // `isError` was true on the source frame. Surface as summary so
    // the pill shows it.
    if (typeof raw.errorText === "string" && !summary) summary = raw.errorText
    return {
      type: "tool_result",
      id: toolCallId,
      summary,
      results,
    }
  }
  if (t === "data-tool-image") {
    const data = raw.data as
      | { id?: unknown; mode?: unknown; images?: unknown }
      | undefined
    if (!data || typeof data !== "object") return null
    return {
      type: "tool_image",
      id: typeof data.id === "string" ? data.id : undefined,
      mode: typeof data.mode === "string" ? data.mode : undefined,
      images: Array.isArray(data.images) ? data.images : undefined,
    }
  }
  if (t === "data-suggestions") {
    const data = raw.data as { values?: unknown } | undefined
    if (!data || !Array.isArray(data.values)) return null
    return {
      type: "suggestions",
      values: data.values.filter((v): v is string => typeof v === "string"),
    }
  }
  if (t === "data-ui") {
    // Generative UI part — emitted by the server-side `renderUI` tool
    // after it validates `{ kind, props }` against the shared schema.
    // The send-pipeline re-validates with `parsePersistedUiPart` before
    // appending to `Message.uiParts`, so a malformed in-flight payload
    // is still rejected safely. See `docs/PLAN-generative-ui-parts.md`.
    const data = raw.data as
      | { id?: unknown; kind?: unknown; props?: unknown }
      | undefined
    if (!data || typeof data !== "object") return null
    if (typeof data.id !== "string" || typeof data.kind !== "string") return null
    return {
      type: "ui_part",
      id: data.id,
      kind: data.kind,
      props: data.props,
    }
  }
  // Lifecycle frames the handler doesn't need to act on.
  if (
    t === "start" ||
    t === "start-step" ||
    t === "text-start" ||
    t === "text-end" ||
    t === "reasoning-start" ||
    t === "reasoning-end" ||
    t === "finish-step" ||
    t === "finish"
  ) {
    return null
  }

  // Unknown frame type — ignore.
  return null
}
