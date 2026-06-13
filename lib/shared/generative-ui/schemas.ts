/**
 * Generative UI parts — shared kind registry.
 *
 * The single source of truth for each generative-UI `kind` and the
 * shape of the props that kind takes. Both halves of the round-trip
 * validate against the SAME schema:
 *
 *   1. Server-side `renderUI` tool — validates the model's tool
 *      arguments before emitting a `data-ui` part.
 *   2. Client-side registry — re-validates incoming parts before
 *      rendering, so a malformed part from a future server / a
 *      replay across versions never crashes the renderer.
 *
 * v1 ships a small allow-list (info-table only — read-only, the
 * structured-output case). Interactive kinds (choice, confirm,
 * mini-form) land in commit 2 of PLAN-generative-ui-parts.md; their
 * schemas slot into the same union below.
 *
 * Pure Zod, no I/O. Lives in `lib/shared/` per the fence rules so
 * both the client `client-only` registry and the server `server-only`
 * tool can import without violating the boundary.
 */

import { format, isValid, parseISO } from "date-fns"
import { z } from "zod"

/** Dates in generative UI are ISO `YYYY-MM-DD`, date-only (no time/zone). */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const IsoDate = z.string().regex(ISO_DATE_RE, "expected YYYY-MM-DD")

/** Human-readable form of an ISO date for the follow-up chat turn.
 *  Falls back to the raw string if it isn't a clean ISO date. */
function formatIsoHuman(iso: string): string {
  if (!ISO_DATE_RE.test(iso)) return iso
  const d = parseISO(iso)
  return isValid(d) ? format(d, "MMMM d, yyyy") : iso
}

/** Returns true only when `s` is a string that is both regex-valid
 *  (`YYYY-MM-DD`) AND represents a real calendar date. */
function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && ISO_DATE_RE.test(s) && isValid(parseISO(s))
}

/** Allow-list of generative UI kinds. Adding a new kind: extend this
 *  enum + the discriminated union below + register a component in
 *  `lib/client/chat/generative-ui/registry.ts`. */
export const UI_KIND_VALUES = [
  "info-table",
  "choice",
  "confirm",
  "mini-form",
  "date-picker",
] as const
export type UiKind = (typeof UI_KIND_VALUES)[number]

export const UiKindEnum = z.enum(UI_KIND_VALUES)

// --- info-table -------------------------------------------------------------

/** One row in an `info-table`. Two shapes share the row type so the
 *  component renderer can support both "key/value list" and "columnar
 *  table" layouts from one schema:
 *  - `columns` absent → row is a key/value pair (`key`, `value`).
 *  - `columns` present → row is an N-cell tuple keyed by column id.
 */
export const InfoTableRowSchema = z.record(
  z.string().min(1).max(80),
  z.string().max(500),
)

export const InfoTablePropsSchema = z.object({
  /** Optional table caption / heading. Rendered above the rows. */
  title: z.string().max(200).optional(),
  /** When set, the table renders as a multi-column grid; columns
   *  appear in declaration order. Each row must supply a string
   *  value for every column id. When absent, the table renders as a
   *  key/value list (the simpler case). */
  columns: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        label: z.string().min(1).max(80),
      }),
    )
    .min(1)
    .max(6)
    .optional(),
  /** Row data. Capped at 50 to keep the message bubble navigable —
   *  larger tables belong in an artifact, not inline. */
  rows: z.array(InfoTableRowSchema).max(50),
})
export type InfoTableProps = z.infer<typeof InfoTablePropsSchema>

// --- choice ----------------------------------------------------------------

export const ChoiceOptionSchema = z.object({
  /** Stable identifier sent back as part of the answer. Cleanly
   *  separates "which option the model meant" from the user-facing
   *  label, so a re-worded label doesn't shift the resolution. */
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(160),
})

export const ChoicePropsSchema = z.object({
  /** User-facing prompt above the option buttons. */
  prompt: z.string().min(1).max(500),
  /** Options the user picks from. 2–8 — fewer than 2 means it's a
   *  `confirm`, more than 8 reads better as prose. */
  options: z.array(ChoiceOptionSchema).min(2).max(8),
  /** When true, render as multi-select with a Submit button; when
   *  false / absent, single-click each option auto-resolves. */
  multiSelect: z.boolean().optional(),
})
export type ChoiceProps = z.infer<typeof ChoicePropsSchema>

// --- confirm ---------------------------------------------------------------

export const ConfirmPropsSchema = z.object({
  prompt: z.string().min(1).max(500),
  /** Button labels — defaults are picked client-side when absent. */
  confirmLabel: z.string().min(1).max(40).optional(),
  cancelLabel: z.string().min(1).max(40).optional(),
})
export type ConfirmProps = z.infer<typeof ConfirmPropsSchema>

// --- mini-form -------------------------------------------------------------

export const MiniFormFieldSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(120),
    placeholder: z.string().max(160).optional(),
    /** Optional max length for the user-typed value. */
    maxLength: z.number().int().min(1).max(2000).optional(),
  }),
  z.object({
    type: z.literal("number"),
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(120),
    placeholder: z.string().max(40).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    type: z.literal("select"),
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(120),
    options: z.array(ChoiceOptionSchema).min(2).max(8),
  }),
  z.object({
    type: z.literal("date"),
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(120),
    min: IsoDate.optional(),
    max: IsoDate.optional(),
  }),
])
export type MiniFormField = z.infer<typeof MiniFormFieldSchema>

export const MiniFormPropsSchema = z.object({
  /** Optional caption above the form. */
  prompt: z.string().max(500).optional(),
  /** 1–4 fields — keeps the form glance-able. */
  fields: z.array(MiniFormFieldSchema).min(1).max(4),
  submitLabel: z.string().min(1).max(40).optional(),
})
export type MiniFormProps = z.infer<typeof MiniFormPropsSchema>

// --- date-picker ------------------------------------------------------------

export const DatePickerPropsSchema = z
  .object({
    prompt: z.string().min(1).max(500),
    /** "single" → one day, auto-resolves on pick; "range" → from/to
     *  with a Submit button. */
    mode: z.enum(["single", "range"]).default("single"),
    /** Earliest / latest selectable day (ISO). Out-of-range days are
     *  disabled in the calendar. */
    min: IsoDate.optional(),
    max: IsoDate.optional(),
  })
  .refine((p) => !p.min || !p.max || p.min <= p.max, {
    message: "min must be <= max",
  })
export type DatePickerProps = z.infer<typeof DatePickerPropsSchema>

// --- Discriminated union over all kinds -------------------------------------

/** The wire shape of a generative UI part. `kind` discriminates the
 *  props schema. Server validates before emit; client validates
 *  before render. */
export const UiPartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("info-table"), props: InfoTablePropsSchema }),
  z.object({ kind: z.literal("choice"), props: ChoicePropsSchema }),
  z.object({ kind: z.literal("confirm"), props: ConfirmPropsSchema }),
  z.object({ kind: z.literal("mini-form"), props: MiniFormPropsSchema }),
  z.object({ kind: z.literal("date-picker"), props: DatePickerPropsSchema }),
])
export type UiPart = z.infer<typeof UiPartSchema>

/** Persisted shape on `Message.uiParts`. Adds a stable `id` (the
 *  tool-call id from the model) so React Flow / React lists can key
 *  by it; `answeredAt` lets the renderer flip into the inert
 *  resolved state for interactive kinds (info-table is always read-
 *  only, so `answeredAt` is unused for v1 but landed up front to
 *  avoid a migration when interactive kinds arrive in commit 2). */
export interface PersistedUiPart {
  id: string
  kind: UiKind
  props: unknown
  /** ISO timestamp of when the user answered the part. Unused for
   *  `info-table` (read-only). Absent = unanswered. */
  answeredAt?: string
  /** The user's answer — kept on the part so the inert render after
   *  reload can show what was picked. Shape varies by kind; the
   *  client renderer narrows via the kind discriminant. `null` for
   *  cancelled `confirm` parts. */
  answer?: UiAnswer
}

/** Per-kind answer shape. Discriminator matches `PersistedUiPart.kind`.
 *  Pure-data; no React, no UI primitives. Used by:
 *    - the store mutator (`resolveMessageUiPart`) to write the answer,
 *    - the `formatAnswerForChat` helper to render the follow-up user
 *      turn text from the answer + part shape,
 *    - the inert renderer to highlight what was chosen. */
export type UiAnswer =
  /** `info-table` is read-only — never produces an answer. Carried in
   *  the union so the discriminant is exhaustive. */
  | { kind: "info-table" }
  /** `choice` — picked option ids (single-select supplies a 1-element
   *  array; multi-select supplies N). */
  | { kind: "choice"; selectedIds: string[] }
  /** `confirm` — true on Confirm, false on Cancel. */
  | { kind: "confirm"; confirmed: boolean }
  /** `mini-form` — submitted values keyed by field id (string values
   *  for text/select; stringified number for `number` fields). */
  | { kind: "mini-form"; values: Record<string, string> }
  /** `date-picker` single — the ISO `YYYY-MM-DD` day the user picked. */
  | { kind: "date-picker"; date: string }
  /** `date-picker` range — inclusive start/end ISO days. */
  | { kind: "date-picker"; from: string; to: string }

/** Pure parser for one `PersistedUiPart` — validates the kind /
 *  props shape and returns null when the part is malformed. Used by
 *  the client renderer and the boundary parser when rehydrating from
 *  the persisted store / Supabase. */
export function parsePersistedUiPart(value: unknown): PersistedUiPart | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  if (typeof obj.id !== "string" || !obj.id) return null
  const parsed = UiPartSchema.safeParse({ kind: obj.kind, props: obj.props })
  if (!parsed.success) return null
  const out: PersistedUiPart = {
    id: obj.id,
    kind: parsed.data.kind,
    props: parsed.data.props,
  }
  if (typeof obj.answeredAt === "string") {
    out.answeredAt = obj.answeredAt
  }
  const answer = parseAnswerForKind(parsed.data.kind, obj.answer)
  if (answer) out.answer = answer
  return out
}

/** Boundary parser for a persisted answer. Returns null when the
 *  shape doesn't fit the kind — preserves the "malformed = drop, no
 *  throw" invariant the renderer relies on. */
function parseAnswerForKind(
  kind: UiKind,
  value: unknown,
): UiAnswer | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (kind === "choice") {
    if (!Array.isArray(v.selectedIds)) return null
    const ids = v.selectedIds.filter((x): x is string => typeof x === "string")
    return { kind: "choice", selectedIds: ids }
  }
  if (kind === "confirm") {
    if (typeof v.confirmed !== "boolean") return null
    return { kind: "confirm", confirmed: v.confirmed }
  }
  if (kind === "mini-form") {
    if (!v.values || typeof v.values !== "object" || Array.isArray(v.values)) {
      return null
    }
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v.values as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val
    }
    return { kind: "mini-form", values: out }
  }
  if (kind === "date-picker") {
    if (isIsoDate(v.date)) {
      return { kind: "date-picker", date: v.date }
    }
    if (isIsoDate(v.from) && isIsoDate(v.to) && v.from <= v.to) {
      return { kind: "date-picker", from: v.from, to: v.to }
    }
    return null
  }
  return null
}

// --- Answer → user-message-text formatter ----------------------------------

/** Pure helper: turn an answered part into the **text of a follow-up
 *  user turn** the chat-send pipeline can ship. The chat-message
 *  layer either auto-sends this (default for `confirm` / `choice`)
 *  or prefills the composer (default for `mini-form`) — but the
 *  formatting logic itself stays pure + unit-testable here.
 *
 *  Format rules:
 *    - `confirm` confirmed → `confirmLabel` (or "Yes" default).
 *    - `confirm` cancelled → `cancelLabel` (or "Cancel" default).
 *    - `choice` single → the option label.
 *    - `choice` multi → "Option A, Option B" (comma-joined labels).
 *    - `mini-form` → "Field Label: value, Field Label: value".
 *    - `date-picker` single → "June 20, 2026".
 *    - `date-picker` range  → "June 20, 2026 – June 25, 2026".
 *
 *  Returns the empty string when the answer can't be formatted
 *  (e.g. selectedIds reference an unknown option) — caller decides
 *  whether to surface that or silently swallow. */
export function formatAnswerForChat(
  part: { kind: UiKind; props: unknown },
  answer: UiAnswer,
): string {
  if (part.kind === "info-table" || answer.kind === "info-table") return ""

  if (part.kind === "confirm" && answer.kind === "confirm") {
    const p = part.props as ConfirmProps
    return answer.confirmed
      ? p.confirmLabel ?? "Yes"
      : p.cancelLabel ?? "Cancel"
  }

  if (part.kind === "choice" && answer.kind === "choice") {
    const p = part.props as ChoiceProps
    const byId = new Map(p.options.map((o) => [o.id, o.label]))
    const labels = answer.selectedIds
      .map((id) => byId.get(id))
      .filter((l): l is string => typeof l === "string")
    return labels.join(", ")
  }

  if (part.kind === "mini-form" && answer.kind === "mini-form") {
    const p = part.props as MiniFormProps
    const labelById = new Map(p.fields.map((f) => [f.id, f.label]))
    const fragments: string[] = []
    for (const f of p.fields) {
      const v = answer.values[f.id]
      if (typeof v !== "string" || v.length === 0) continue
      const label = labelById.get(f.id) ?? f.id
      fragments.push(`${label}: ${v}`)
    }
    return fragments.join(", ")
  }

  if (part.kind === "date-picker" && answer.kind === "date-picker") {
    if ("date" in answer) return formatIsoHuman(answer.date)
    return `${formatIsoHuman(answer.from)} – ${formatIsoHuman(answer.to)}`
  }

  return ""
}

/** Per-kind default for the resolution strategy. Picked from the
 *  plan's open question #1 — `confirm` / `choice` auto-send (sleeker;
 *  one click resolves); `mini-form` prefills the composer (forms
 *  usually want a review before sending). */
export function defaultResolutionFor(kind: UiKind): "auto-send" | "prefill" {
  return kind === "mini-form" ? "prefill" : "auto-send"
}

/** Build the `/api/tasks/:id/respond` body from a generative-UI
 *  answer (task-mode resolution; commit 3 of
 *  `PLAN-generative-ui-parts.md`).
 *
 *  Carries the structured `uiAnswer` AND populates one of the
 *  back-compat HITL fields (`selection` for choice, `value` for the
 *  formatted text on confirm/mini-form) so a runner that hasn't yet
 *  learned `requestKind: "ui-part"` can still consume the response
 *  via the existing askUser path. The runner's eventual native
 *  handling reads `uiAnswer` directly.
 *
 *  `requestId` is the `approvalId` from the pause event; the caller
 *  pulls it off `PendingInput.requestId`. */
export function respondBodyForUiAnswer(
  requestId: string,
  part: { kind: UiKind; props: unknown },
  answer: UiAnswer,
): {
  requestId: string
  uiAnswer: UiAnswer
  selection?: string[]
  value?: string
} {
  const body: {
    requestId: string
    uiAnswer: UiAnswer
    selection?: string[]
    value?: string
  } = { requestId, uiAnswer: answer }
  if (answer.kind === "choice") {
    body.selection = [...answer.selectedIds]
  }
  // For non-choice answers, fold the formatted text into `value` so an
  // input-style runner can still see something readable.
  const text = formatAnswerForChat(part, answer)
  if (text) body.value = text
  return body
}
