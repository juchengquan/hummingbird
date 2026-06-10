"use client"
import "client-only"

/**
 * Renders the `Message.uiParts` array on an assistant message bubble.
 * Each entry resolves through the client registry; unknown kinds and
 * parts whose props fail schema validation drop silently so a stale
 * server can't crash the bubble.
 */

import { getUiKindDef } from "@/client/chat/generative-ui/registry"
import type { PersistedUiPart } from "@/shared/generative-ui/schemas"

export function MessageUiParts({ parts }: { parts: readonly PersistedUiPart[] }) {
  return (
    <div className="flex flex-col gap-2">
      {parts.map((part) => {
        const def = getUiKindDef(part.kind)
        if (!def) return null
        const parsed = def.schema.safeParse(part.props)
        if (!parsed.success) return null
        const Component = def.Component
        // v1 ships only `info-table` (read-only) → `inert` is always
        // true. Commit 2 flips the flag based on `answeredAt` for the
        // interactive kinds.
        return (
          <Component
            key={part.id}
            props={parsed.data}
            inert={!!part.answeredAt}
          />
        )
      })}
    </div>
  )
}
