/**
 * Open-state for the child-run drill-in Sheet (subagent orchestration
 * PR-3b). Mirrors the text/pdf/csv viewer stores: one target at a time,
 * `open`/`close`. The `ChildRunModalHost` reads `target` + renders the
 * Sheet; `SubagentGroup` pills call `openChildRunViewer`.
 */

import { create } from "zustand"

export interface ChildRunViewerTarget {
  childTaskId: string
}

interface ChildRunViewerStore {
  target: ChildRunViewerTarget | null
  open: (target: ChildRunViewerTarget) => void
  close: () => void
}

export const useChildRunViewer = create<ChildRunViewerStore>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}))

/** Convenience opener (mirrors `openPdf` etc. in right-panel-slot). */
export function openChildRunViewer(target: ChildRunViewerTarget): void {
  useChildRunViewer.getState().open(target)
}
