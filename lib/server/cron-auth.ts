import "server-only"

import { createHash, timingSafeEqual } from "node:crypto"

/**
 * Cron-secret check for scheduled routes (`/api/tasks/jobs/tick`).
 *
 * Header-only: `Authorization: Bearer <CRON_SECRET>` — exactly what
 * Vercel Cron sends when `CRON_SECRET` is set on the project. A query
 * parameter is NOT accepted: URLs end up in access logs, proxy logs and
 * browser history.
 *
 * Constant-time: both sides are hashed to fixed-length SHA-256 digests
 * before `timingSafeEqual`, so neither the comparison nor a length
 * mismatch leaks how much of the secret matched.
 */
export function isAuthorizedCronRequest(
  authorizationHeader: string | null,
  expectedSecret: string
): boolean {
  if (!expectedSecret || !authorizationHeader) return false
  const match = /^Bearer (.+)$/.exec(authorizationHeader)
  if (!match) return false
  const given = createHash("sha256").update(match[1]).digest()
  const expected = createHash("sha256").update(expectedSecret).digest()
  return timingSafeEqual(given, expected)
}
