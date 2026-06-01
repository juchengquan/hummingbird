import "server-only"

/**
 * Toggle for the in-Next-process agent worker.
 *
 * Background: the Next.js process has historically been the only
 * thing that claims `task_jobs` rows — `processNextJob` runs both
 * inline (as a bootstrap in `POST /api/tasks` and HITL respond) and
 * on a Vercel cron (`/api/tasks/jobs/tick`). With `services/agent-py/`
 * and `services/agent-ts/` both shipping their own claim loops, the
 * inline worker is redundant for any deploy that runs one of them —
 * and the race between two claim mechanisms is a loaded gun.
 *
 * This env var is the soft retirement lever. Default `true` keeps
 * existing deploys unchanged. Set to `false` once a dedicated
 * agent service is reachable; the bootstrap calls + cron tick then
 * no-op, leaving the queue entirely to the service workers.
 *
 * Follow-up #4 in `docs/PLAN-agent-ts-followups.md`. Once the
 * default flips (a separate PR after at least one service is
 * universally deployed), `lib/server/agent/worker.ts` and
 * `lib/server/agent/jobs.ts`'s claim/release helpers can be
 * removed.
 */
export function inlineAgentWorkerEnabled(): boolean {
  const raw = (process.env.INLINE_AGENT_WORKER ?? "").toLowerCase()
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") {
    return false
  }
  // Default-on: empty / any other value = true.
  return true
}
