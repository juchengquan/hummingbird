import "server-only"

/**
 * A counting semaphore that bounds concurrent async work. `acquire` resolves
 * when a slot is free (FIFO); pass an `AbortSignal` to give up while queued
 * (the returned promise rejects on abort and the waiter is removed). Every
 * successful `acquire` MUST be paired with exactly one `release`.
 *
 * Pure (no I/O) so it unit-tests without booting anything.
 */
export interface Semaphore {
  acquire(signal?: AbortSignal): Promise<void>
  release(): void
  /** Slots currently held (diagnostics/tests). */
  active(): number
  /** Waiters currently queued (diagnostics/tests). */
  waiting(): number
}

export function createSemaphore(max: number): Semaphore {
  let active = 0
  const waiters: Array<() => void> = []

  function acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"))
    if (active < max) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort)
      const grant = () => {
        active++
        cleanup()
        resolve()
      }
      const onAbort = () => {
        const i = waiters.indexOf(grant)
        if (i >= 0) waiters.splice(i, 1)
        cleanup()
        reject(new Error("aborted"))
      }
      waiters.push(grant)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  function release(): void {
    // Free this slot, then immediately hand it to the next waiter (if any) in
    // the same synchronous tick so the count can never transiently exceed max.
    if (active > 0) active--
    const grant = waiters.shift()
    if (grant) grant()
  }

  return { acquire, release, active: () => active, waiting: () => waiters.length }
}
