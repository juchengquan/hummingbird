"use client"
import "client-only"

import type { CodeResultCell } from "@/shared/types"
import {
  parseVerificationFrame,
  type VerificationResult,
} from "@/shared/verify"

/**
 * Frame helpers for chat on runs (`lib/client/runs/reducer.ts`): re-shape
 * a `data-*` part (`data-tool-image`, `data-suggestions`, `data-ui`, …)
 * or a tool result's content into the small internal envelope the turn
 * writer consumes.
 *
 * Pure — no React, no Zustand, no fetch.
 */

/** The internal envelope the turn writer reads. */
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
  /** MCP App (`mcp_app` frame): the producing server id + the bundled
   *  HTML read from its `ui://` resource. */
  serverId?: string
  html?: string
  /** MCP App (`mcp_app` frame, phase 3): the source `ui://` resource
   *  uri (so the refresh button can re-read it) + a truncation flag
   *  the renderer reads to swap in the "UI too large" stub. */
  resourceUri?: string
  truncated?: boolean
  /** Citation verification (`verification` frame): per-claim grounding
   *  verdicts + the confidence summary. See PLAN-citation-verifiability.md. */
  verification?: VerificationResult
  /** Code-interpreter result cells (`code_result` frame): stdout/stderr
   *  ride on `value`-less dedicated fields; the inline text/table cells
   *  live here. Named `codeCells` (not `results`) because `results`
   *  above already carries the search-tool result shape. See
   *  `docs/superpowers/plans/2026-06-19-code-interpreter-microsandbox.md`. */
  stdout?: string
  stderr?: string
  codeCells?: CodeResultCell[]
  /** Tool-file frame (`data-tool-file`): the producing call id + the
   *  bundled files returned by the tool. Carries id and files array. */
  files?: unknown[]
}

/** A tool result's `{summary, results}`, from the JSON string a runs
 *  `TOOL_CALL_RESULT.content` carries (RUN_EVENTS.md § 3.2). `errorText`
 *  (a failed tool) stands in for a missing summary. */
export function parseToolOutput(
  output: unknown,
  errorText?: unknown,
): Pick<NormalisedFrame, "summary" | "results"> {
  let summary: string | undefined
  let results:
    | Array<{ title?: string; url?: string; snippet?: string }>
    | undefined
  if (typeof output === "string") {
    try {
      const out = JSON.parse(output) as {
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
  // A failed tool's error text surfaces as the summary so the pill
  // shows it.
  if (typeof errorText === "string" && !summary) summary = errorText
  return { summary, results }
}

/**
 * Translate one AI SDK `data-*` part (`type` the frame type, `data` its
 * payload) into the internal envelope: a runs `ACTIVITY_SNAPSHOT.content`
 * is exactly the `data` object of such a part (RUN_EVENTS.md § 3.3,
 * mapped by `lib/client/runs/reducer.ts`). Null for an unknown type or a
 * malformed payload.
 */
export function translateDataPart(
  type: string,
  rawData: unknown,
): NormalisedFrame | null {
  const t = type
  if (t === "data-tool-image") {
    const data = rawData as
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
  if (t === "data-tool-file") {
    const data = rawData as
      | { id?: unknown; files?: unknown }
      | undefined
    if (!data || typeof data !== "object") return null
    return {
      type: "tool_file",
      id: typeof data.id === "string" ? data.id : undefined,
      files: Array.isArray(data.files) ? data.files : undefined,
    }
  }
  if (t === "data-code-result") {
    const data = rawData as
      | { id?: unknown; stdout?: unknown; stderr?: unknown; results?: unknown }
      | undefined
    if (!data || typeof data !== "object") return null
    return {
      type: "code_result",
      id: typeof data.id === "string" ? data.id : undefined,
      stdout: typeof data.stdout === "string" ? data.stdout : "",
      stderr: typeof data.stderr === "string" ? data.stderr : "",
      codeCells: Array.isArray(data.results)
        ? (data.results as CodeResultCell[])
        : [],
    }
  }
  if (t === "data-mcp-app") {
    const data = rawData as
      | {
          id?: unknown
          serverId?: unknown
          html?: unknown
          resourceUri?: unknown
          truncated?: unknown
        }
      | undefined
    if (!data || typeof data !== "object") return null
    if (
      typeof data.id !== "string" ||
      typeof data.serverId !== "string" ||
      typeof data.html !== "string"
    ) {
      return null
    }
    return {
      type: "mcp_app",
      id: data.id,
      serverId: data.serverId,
      html: data.html,
      // Phase 3 — optional on the wire; absent on older-server emits.
      resourceUri:
        typeof data.resourceUri === "string" ? data.resourceUri : undefined,
      truncated: data.truncated === true ? true : undefined,
    }
  }
  if (t === "data-routed-model") {
    const data = rawData as { model?: unknown } | undefined
    if (!data || typeof data.model !== "string") return null
    return { type: "routed_model", value: data.model }
  }
  if (t === "data-suggestions") {
    const data = rawData as { values?: unknown } | undefined
    if (!data || !Array.isArray(data.values)) return null
    return {
      type: "suggestions",
      values: data.values.filter((v): v is string => typeof v === "string"),
    }
  }
  if (t === "data-verification") {
    const verification = parseVerificationFrame(rawData)
    if (!verification) return null
    return { type: "verification", verification }
  }
  if (t === "data-ui") {
    // Generative UI part — emitted by the server-side `renderUI` tool
    // after it validates `{ kind, props }` against the shared schema.
    // The send-pipeline re-validates with `parsePersistedUiPart` before
    // appending to `Message.uiParts`, so a malformed in-flight payload
    // is still rejected safely. See `docs/PLAN-generative-ui-parts.md`.
    const data = rawData as
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
  return null
}
