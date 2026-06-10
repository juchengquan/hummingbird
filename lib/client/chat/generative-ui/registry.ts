"use client"
import "client-only"

/**
 * Client-side generative-UI registry.
 *
 * Each entry binds a `UiKind` to:
 *   1. The same Zod `schema` the server validated with — used here
 *      as a defensive re-validation gate before render, so a future
 *      server emitting a stale shape (e.g. across a deployment skew
 *      window) silently drops instead of crashing the message bubble.
 *   2. The React `Component` that renders the validated props.
 *
 * v1 ships only `info-table`. Interactive kinds (choice, confirm,
 * mini-form) land in commit 2 of `PLAN-generative-ui-parts.md`.
 *
 * Pure client component module — `client-only` fence. The Zod
 * schemas come from `@/shared/generative-ui/schemas` (isomorphic).
 */

import { z } from "zod"

import {
  InfoTablePropsSchema,
  type UiKind,
} from "@/shared/generative-ui/schemas"

import { InfoTable } from "@/components/chat/generative-ui/info-table"

export interface UiKindDef {
  /** The kind's props Zod schema. The renderer calls
   *  `schema.safeParse(props)` before invoking `Component`. */
  schema: z.ZodTypeAny
  /** Renders the validated part. Receives the validated props +
   *  whether the part has been answered (always false in v1; flips
   *  for interactive kinds in commit 2). */
  Component: React.ComponentType<{ props: unknown; inert: boolean }>
}

export const UI_KINDS: Record<UiKind, UiKindDef> = {
  "info-table": {
    schema: InfoTablePropsSchema,
    Component: InfoTable,
  },
}

/** Lookup with a kind-string of arbitrary provenance (e.g. directly
 *  from `Message.uiParts`). Returns null on unknown kind so the
 *  renderer can silently skip the part. */
export function getUiKindDef(kind: string): UiKindDef | null {
  if (!(kind in UI_KINDS)) return null
  return UI_KINDS[kind as UiKind]
}
