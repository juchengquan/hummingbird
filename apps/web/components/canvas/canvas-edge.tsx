"use client"

/**
 * Editable canvas edge — replaces the Phase-3 `window.prompt` label
 * affordance with an inline editor rendered at the edge midpoint.
 *
 * Double-clicking an edge (handled in the panel) sets `editingEdgeId`;
 * the matching edge renders a focused `<input>` instead of its label
 * chip. Enter / blur commits, Esc cancels. The panel threads
 * `editingEdgeId` + the commit/start callbacks into every edge's
 * `data`, mirroring how sticky-node onChange is injected.
 */

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react"

import { cn } from "@/shared/utils"

export interface EditableEdgeData {
  editingEdgeId?: string | null
  onStartEdit?: (id: string) => void
  onCommitLabel?: (id: string, label: string) => void
  [key: string]: unknown
}

export function EditableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  data,
  markerEnd,
  style,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  const d = (data ?? {}) as EditableEdgeData
  const editing = d.editingEdgeId === id
  const labelText = typeof label === "string" ? label : ""

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan absolute"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
          }}
        >
          {editing ? (
            <input
              autoFocus
              defaultValue={labelText}
              onBlur={(e) => d.onCommitLabel?.(id, e.target.value.trim())}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur()
                } else if (e.key === "Escape") {
                  // Revert then blur (blur reads the reverted value).
                  e.currentTarget.value = labelText
                  e.currentTarget.blur()
                }
                e.stopPropagation()
              }}
              placeholder="label"
              className={cn(
                "h-6 w-28 rounded border border-[var(--primary)]/50 bg-[var(--background)]",
                "px-1.5 text-[11px] outline-none focus:ring-1 focus:ring-[var(--primary)]/40"
              )}
            />
          ) : labelText ? (
            <button
              type="button"
              onDoubleClick={(e) => {
                e.stopPropagation()
                d.onStartEdit?.(id)
              }}
              title="Double-click to edit label"
              className={cn(
                "rounded border border-[var(--border)] bg-[var(--card)]",
                "px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]",
                "shadow-sm hover:text-[var(--foreground)]"
              )}
            >
              {labelText}
            </button>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
