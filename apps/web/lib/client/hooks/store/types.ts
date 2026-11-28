import "client-only"

import type { StateCreator } from "zustand"

import type { AppState } from "../use-store"

/**
 * The full composed Zustand store state.
 *
 * Step 1 of `PLAN-store-slice-split.md` aliases this to `AppState`
 * so the new `store/` infra (persist + migrate) can be typed
 * against `StoreState` while the interface itself still lives in
 * `use-store.ts`. Step 2+ pull per-entity slices out and the
 * composition shifts here; `AppState` will become an alias the
 * other way around (or go away) at the end of the split.
 */
export type StoreState = AppState

/**
 * Zustand's documented "slices pattern" factory, typed against the
 * full composed `StoreState` so a slice can read sibling state via
 * `get()`. Used by the per-entity slice modules introduced in
 * later steps of the split.
 */
export type SliceCreator<T> = StateCreator<
  StoreState,
  [["zustand/persist", unknown]],
  [],
  T
>
