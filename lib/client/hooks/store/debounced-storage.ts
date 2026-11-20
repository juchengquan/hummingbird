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
import { mark as perfMark, count as perfCount } from "@/client/perf-chat-stream"

import { isQuotaExceededError, notifyStorageQuotaExceeded } from "./quota-toast"

export interface DebouncedStorageOptions {
  /** Underlying storage to persist to. Defaults to `localStorage`. */
  target?: Storage
  /** Coalesce window in ms. Default 100 — empirically a good trade-off
   *  between cutting bursts and not losing too much state on a hard
   *  crash. The `pagehide` flush covers the planned-exit case. */
  delayMs?: number
  /** Called when a flush fails with a quota error. Defaults to a
   *  once-per-session toast (`quota-toast.ts`). */
  onQuotaExceeded?: (err: unknown) => void
}

/** `StateStorage` plus the hooks the cross-tab merge
 *  (`cross-tab-sync.ts`) needs to reason about this tab's unflushed
 *  write. */
export interface DebouncedStateStorage extends StateStorage {
  /** True while a write for `name` is buffered and not yet on disk. */
  hasPending(name: string): boolean
  /** Drop the buffered write for `name` without writing it. */
  discardPending(name: string): void
  /** Called after each successful underlying write. Returns an
   *  unsubscribe function. */
  subscribeFlush(cb: (name: string) => void): () => void
}

/** Build a `StateStorage` that wraps `target` (default `localStorage`)
 *  and debounces writes by `delayMs`. Reads return the most-recent
 *  value, including any pending write. */
export function debouncedStorage(
  opts: DebouncedStorageOptions = {}
): DebouncedStateStorage {
  const resolvedTarget =
    opts.target ?? (typeof window !== "undefined" ? window.localStorage : undefined)
  const delayMs = opts.delayMs ?? 100
  const onQuotaExceeded =
    opts.onQuotaExceeded ?? (() => void notifyStorageQuotaExceeded())

  if (!resolvedTarget) {
    // SSR / Node — no-op storage. Mirrors Zustand's own
    // `createJSONStorage(() => undefined)` fallback shape.
    return {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      hasPending: () => false,
      discardPending: () => {},
      subscribeFlush: () => () => {},
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
  const flushListeners = new Set<(name: string) => void>()

  function cancel(name: string): void {
    pending.delete(name)
    const timer = timers.get(name)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(name)
    }
  }

  function flush(name: string): void {
    const value = pending.get(name)
    if (value === undefined) return
    cancel(name)
    perfMark("humm/chat/persist-debounce-flush:start")
    perfCount("chat.persist.flush")
    let wrote = false
    try {
      target.setItem(name, value)
      wrote = true
    } catch (err) {
      // Quota exceeded or storage unavailable — callers see stale data
      // on the next read, same as if the write never happened. We don't
      // throw because Zustand's persist middleware swallows storage
      // errors too. A quota error is the one the user can act on, so
      // it gets a (once-per-session) toast.
      if (isQuotaExceededError(err)) onQuotaExceeded(err)
    }
    perfMark("humm/chat/persist-debounce-flush:end")
    if (wrote) for (const cb of flushListeners) cb(name)
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
      cancel(name)
      try {
        target.removeItem(name)
      } catch {
        // see setItem comment
      }
    },
    hasPending(name: string): boolean {
      return pending.has(name)
    },
    discardPending(name: string): void {
      cancel(name)
    },
    subscribeFlush(cb: (name: string) => void): () => void {
      flushListeners.add(cb)
      return () => {
        flushListeners.delete(cb)
      }
    },
  }
}
