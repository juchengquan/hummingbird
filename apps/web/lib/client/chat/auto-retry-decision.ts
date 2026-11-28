"use client"
import "client-only"

/**
 * Auto-retry-once decision for the chat send pipeline. Pulled out of
 * `use-chat-send.ts` so the policy is testable without spinning up a
 * React harness + Zustand store.
 *
 * The policy: a transient blip on a brand-new request (no placeholder
 * content yet, network online, not already a retry attempt) tries
 * **one** silent recovery after a 1 s delay before surfacing the
 * error to the user. Once the assistant placeholder has any content,
 * we don't retry — duplicating partial output would be confusing and
 * the user already has visible feedback to react to.
 */

export interface AutoRetryInputs {
  /** True iff this send is itself the auto-retry attempt. Prevents
   *  the retry from triggering its own retry (i.e. caps the depth at
   *  one re-attempt). */
  isRetry: boolean
  /** True iff `navigator.onLine === false` at the failure point. We
   *  don't retry when the browser is reporting offline — a 1 s sleep
   *  won't fix a missing network, and the user needs to see the error
   *  immediately to act on it. */
  offline: boolean
  /** True iff the assistant placeholder has not yet received any
   *  text/reasoning. If the stream already produced output, the user
   *  has visible state we shouldn't duplicate or rewind. */
  placeholderEmpty: boolean
}

/** Decide whether to fire the silent 1 s auto-retry. Pure function;
 *  the caller wires the timer, the `isRetry: true` flag, and the
 *  surface-error fallback. */
export function shouldAutoRetry(inputs: AutoRetryInputs): boolean {
  return !inputs.isRetry && !inputs.offline && inputs.placeholderEmpty
}
