"use client"
import "client-only"

/**
 * Debounced localStorage adapter for the main Zustand store.
 *
 * The default `createJSONStorage(() => localStorage)` writes the
 * **entire** partialized store on every state mutation. With ~28
 * persisted keys (conversations, messages, files, prompts, …),
 * that's a large `JSON.stringify` on every keystroke that touches
 * `pendingChatInput`, every SSE frame that updates a message, every
 * mouse-over that bumps `activeView`. Most are immediately
 * superseded by the next mutation — the intermediate writes are
 * pure waste.
 *
 * This wrapper coalesces bursts of `setItem` calls into one actual
 * `localStorage.setItem` per quiet window. Reads stay synchronous +
 * always observe the most recent value (the in-flight cache shadows
 * localStorage until the write lands). A `pagehide` listener flushes
 * any pending write before the tab unloads so we never lose
 * committed state on navigation.
 *
 * Wire it via Zustand's `createJSONStorage(() => debouncedStorage(...))`.
 */

import type { StateStorage } from "zustand/middleware"

export interface DebouncedStorageOptions {
  /** Underlying storage to persist to. Defaults to `localStorage`. */
  target?: Storage
  /** Coalesce window in ms. Default 100 — empirically a good trade-off
   *  between cutting bursts and not losing too much state on a hard
   *  crash. The `pagehide` flush covers the planned-exit case. */
  delayMs?: number
}

/** Build a `StateStorage` that wraps `target` (default `localStorage`)
 *  and debounces writes by `delayMs`. Reads return the most-recent
 *  value, including any pending write. */
export function debouncedStorage(opts: DebouncedStorageOptions = {}): StateStorage {
  const resolvedTarget =
    opts.target ?? (typeof window !== "undefined" ? window.localStorage : undefined)
  const delayMs = opts.delayMs ?? 100

  if (!resolvedTarget) {
    // SSR / Node — no-op storage. Mirrors Zustand's own
    // `createJSONStorage(() => undefined)` fallback shape.
    return {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    }
  }
  // Capture as non-null after the guard so the closures below see a
  // narrowed type.
  const target: Storage = resolvedTarget

  // In-flight cache: name → pending value. A read for a name with a
  // pending write returns the pending value (read-your-write
  // semantics within the same tab). Cleared per-key once the write
  // lands.
  const pending = new Map<string, string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function flush(name: string): void {
    const value = pending.get(name)
    if (value === undefined) return
    pending.delete(name)
    const timer = timers.get(name)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(name)
    }
    try {
      target.setItem(name, value)
    } catch {
      // Quota exceeded or storage unavailable — surface the error on
      // the next read (callers see stale data, same as if the write
      // never happened). We don't throw because Zustand's persist
      // middleware swallows storage errors too.
    }
  }

  function flushAll(): void {
    for (const name of pending.keys()) flush(name)
  }

  // Flush pending writes on tab unload so the committed state survives
  // navigation. `pagehide` fires on tab close + bfcache eviction +
  // browser-back, which is broader than `beforeunload`.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushAll)
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushAll()
    })
  }

  return {
    getItem(name: string): string | null {
      const inflight = pending.get(name)
      if (inflight !== undefined) return inflight
      return target.getItem(name)
    },
    setItem(name: string, value: string): void {
      pending.set(name, value)
      const existing = timers.get(name)
      if (existing !== undefined) clearTimeout(existing)
      timers.set(
        name,
        setTimeout(() => flush(name), delayMs),
      )
    },
    removeItem(name: string): void {
      pending.delete(name)
      const existing = timers.get(name)
      if (existing !== undefined) {
        clearTimeout(existing)
        timers.delete(name)
      }
      try {
        target.removeItem(name)
      } catch {
        // see setItem comment
      }
    },
  }
}
