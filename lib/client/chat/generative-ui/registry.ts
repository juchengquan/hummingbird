"use client"
import "client-only"

/**
 * Client-side generative-UI registry.
 *
 * Each entry binds a `UiKind` to:
 *   1. The Zod `schema` the server validated with — used here as a
 *      defensive re-validation gate before render, so a stale server
 *      can't crash the message bubble across deploy skew.
 *   2. The React `Component` that renders the validated props.
 *
 * All components share the same `UiPartHostProps` so the renderer
 * (`message-ui-parts.tsx`) doesn't need to branch on kind — it passes
 * the same set of props (validated `props`, `inert`, optional
 * `answer`, `onResolve`) and each component picks what it needs.
 *
 * Pure client component module — `client-only` fence. The Zod
 * schemas come from `@/shared/generative-ui/schemas` (isomorphic).
 */

import { z } from "zod"

import {
  ChoicePropsSchema,
  ConfirmPropsSchema,
  DatePickerPropsSchema,
  InfoTablePropsSchema,
  MiniFormPropsSchema,
  type UiAnswer,
  type UiKind,
} from "@/shared/generative-ui/schemas"

import { ChoiceCard } from "@/components/chat/generative-ui/choice-card"
import { ConfirmCard } from "@/components/chat/generative-ui/confirm-card"
import { DatePickerCard } from "@/components/chat/generative-ui/date-picker-card"
import { InfoTable } from "@/components/chat/generative-ui/info-table"
import { MiniFormCard } from "@/components/chat/generative-ui/mini-form-card"

/** Props shape every kind's `Component` receives. The host handles
 *  schema validation; the component sees pre-validated `props`. The
 *  `onResolve` callback is wired by `message-ui-parts.tsx` to either
 *  the auto-send pipeline or the composer-prefill path, depending on
 *  the per-kind `defaultResolutionFor` default. */
export interface UiPartHostProps {
  /** Validated against the kind's schema by the registry caller. */
  props: unknown
  /** True once the part has been answered. Interactive controls
   *  inside the component disable themselves accordingly. */
  inert: boolean
  /** The answer the user previously gave, if any — survives reload
   *  via `Message.uiParts[].answer`. Lets the inert render show what
   *  was picked. */
  answer?: UiAnswer
  /** Fired when the user submits an answer. The host updates the
   *  store (`resolveMessageUiPart`) and dispatches to chat-send. */
  onResolve: (answer: UiAnswer) => void
}

export interface UiKindDef {
  /** The kind's props Zod schema. The renderer calls
   *  `schema.safeParse(props)` before invoking `Component`. */
  schema: z.ZodTypeAny
  /** Renders the validated part. */
  Component: React.ComponentType<UiPartHostProps>
}

export const UI_KINDS: Record<UiKind, UiKindDef> = {
  "info-table": { schema: InfoTablePropsSchema, Component: InfoTable },
  choice: { schema: ChoicePropsSchema, Component: ChoiceCard },
  confirm: { schema: ConfirmPropsSchema, Component: ConfirmCard },
  "mini-form": { schema: MiniFormPropsSchema, Component: MiniFormCard },
  "date-picker": { schema: DatePickerPropsSchema, Component: DatePickerCard },
}

/** Lookup with a kind-string of arbitrary provenance (e.g. directly
 *  from `Message.uiParts`). Returns null on unknown kind so the
 *  renderer can silently skip the part. */
export function getUiKindDef(kind: string): UiKindDef | null {
  if (!(kind in UI_KINDS)) return null
  return UI_KINDS[kind as UiKind]
}
