/**
 * Cross-cutting state for the live-artifact preview panel. Mirrors
 * `usePdfViewer` so any consumer (artifact card, chat-message preview
 * button, future citation marker) can call
 * `useLiveArtifact.getState().open({ artifactId })` without threading
 * props through every render path.
 *
 * The mode flag (`render` vs `code`) is sticky-per-open: each `open()`
 * call resets to `render`, and the panel toolbar toggle flips the flag
 * for the current open session only.
 */

import { create } from "zustand"

export type LiveArtifactMode = "render" | "code"

export interface LiveArtifactTarget {
  artifactId: string
  /** Initial view mode. Defaults to `render` — the whole point of
   *  this panel. Callers can pass `code` to open straight into the
   *  syntax-highlighted view. */
  mode?: LiveArtifactMode
}

interface LiveArtifactStore {
  target: LiveArtifactTarget | null
  mode: LiveArtifactMode
  open: (target: LiveArtifactTarget) => void
  setMode: (mode: LiveArtifactMode) => void
  close: () => void
}

export const useLiveArtifact = create<LiveArtifactStore>((set) => ({
  target: null,
  mode: "render",
  open: (target) => set({ target, mode: target.mode ?? "render" }),
  setMode: (mode) => set({ mode }),
  close: () => set({ target: null }),
}))
