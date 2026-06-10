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

import { z } from "zod"

/** Allow-list of generative UI kinds. Adding a new kind: extend this
 *  enum + the discriminated union below + register a component in
 *  `lib/client/chat/generative-ui/registry.ts`. */
export const UI_KIND_VALUES = ["info-table"] as const
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

// --- Discriminated union over all kinds -------------------------------------

/** The wire shape of a generative UI part. `kind` discriminates the
 *  props schema. Server validates before emit; client validates
 *  before render. */
export const UiPartSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("info-table"),
    props: InfoTablePropsSchema,
  }),
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
   *  `info-table` (read-only); set by the interactive-kind path in
   *  commit 2. Absent = unanswered. */
  answeredAt?: string
}

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
  return {
    id: obj.id,
    kind: parsed.data.kind,
    props: parsed.data.props,
    ...(typeof obj.answeredAt === "string"
      ? { answeredAt: obj.answeredAt }
      : {}),
  }
}
