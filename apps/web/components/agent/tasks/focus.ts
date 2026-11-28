"use client"
import "client-only"

/**
 * Which tasks the runs list shows expanded (each expanded one is watched:
 * its stream is followed). A launch point or the chat's pointer focuses
 * a task: the panel then opens with it expanded. Per tab, not persisted.
 */

import { create } from "zustand"

interface TaskFocusState {
  expanded: ReadonlySet<string>
  /** Closed by the user: a task needing an answer otherwise opens itself. */
  collapsed: ReadonlySet<string>
  /** The task the panel should scroll to once (cleared when it did). */
  focused: string | null
  toggle(rootRunId: string, isExpanded: boolean): void
  /** A task that asks opens by itself — and stays open once answered —
   *  unless the user closed it. */
  openAsking(rootRunId: string): void
  focus(rootRunId: string): void
  clearFocus(): void
}

export const useTaskFocus = create<TaskFocusState>((set) => ({
  expanded: new Set(),
  collapsed: new Set(),
  focused: null,
  toggle: (id, isExpanded) =>
    set((s) => {
      const expanded = new Set(s.expanded)
      const collapsed = new Set(s.collapsed)
      if (isExpanded) {
        expanded.delete(id)
        collapsed.add(id)
      } else {
        expanded.add(id)
        collapsed.delete(id)
      }
      return { expanded, collapsed }
    }),
  openAsking: (id) =>
    set((s) => (s.expanded.has(id) || s.collapsed.has(id) ? s : { expanded: new Set(s.expanded).add(id) })),
  focus: (id) =>
    set((s) => {
      const collapsed = new Set(s.collapsed)
      collapsed.delete(id)
      return { expanded: new Set(s.expanded).add(id), collapsed, focused: id }
    }),
  clearFocus: () => set({ focused: null }),
}))
