import "server-only"

/**
 * The job-queue worker (`PLAN-agent-task-queue.md`). v1 handles the
 * `continue` action only — it picks up a run that yielded for time,
 * runs another chunk of the agent loop, and either settles, suspends
 * (HITL), or yields again (re-enqueueing itself).
 *
 * `start` and `respond` are left as TODO: the routes still run them
 * inline; phases 3–4 of the queue plan move them here.
 *
 * Worker shape: a single function `processNextJob(db)` that the cron
 * tick route (or a future dedicated worker process) calls in a loop
 * until idle or the surrounding function's deadline is near. The
 * `db` MUST be the service-role admin client — RLS would limit the
 * worker to one user's jobs.
 */

import type { ModelMessage } from "ai"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  ProviderUnavailableError,
  selectModel,
} from "@/server/model-provider"
import {
  SERVER_SKILLS,
  type SkillRequestEntry,
} from "@/server/skills/registry"
import type { SkillId } from "@/shared/skills/types"
import { loadEffectiveMcpServers } from "@/server/mcp/load-servers"
import { buildGatedMcpTool, buildMcpTool, mcpToolName } from "@/server/mcp/tools"
import { RunEmitter } from "@/shared/agent/emitter"
import type { TaskEvent } from "@/shared/agent/events"
import type { Database, Json } from "@/shared/supabase/types"

import type { RunCheckpoint } from "./checkpoint"
import { makeAskUserTool } from "./ask-user-tool"
import { ASK_USER_TOOL_NAME, requestKindFor } from "./input-policy"
import { PLAN_TOOL_NAME, makePlanTool } from "./plan-tool"
import { makeStreamTextStep, runAgentLoop } from "./runner"
import {
  appendEvent,
  isRunCancelled,
  loadCheckpoint,
  saveCheckpoint,
  updateRun,
} from "./store"
import { buildTaskSystemPrompt } from "./task-prompt"
import {
  claimNextJob,
  enqueueContinueJob,
  markJobDone,
  markJobFailed,
  type ClaimedJob,
} from "./jobs"

type DB = SupabaseClient<Database>

/** Default wall-clock budget for one worker invocation. Tuned to leave
 *  ~15 s headroom under the Vercel Hobby 60 s cap; the deploy can
 *  override via env. */
const DEFAULT_WORKER_BUDGET_MS = (() => {
  const raw = Number(process.env.TASK_WORKER_BUDGET_MS)
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return 45_000
})()

export type ProcessOutcome =
  | { kind: "idle" }
  | { kind: "processed"; jobId: string; action: string; result: string }
  | { kind: "skipped"; jobId: string; reason: string }
  | { kind: "failed"; jobId: string; error: string }

/**
 * Claim the next ready job and run it. Returns `{kind:'idle'}` when the
 * queue is empty or the candidate was raced away. Otherwise dispatches
 * by action and reports the outcome (the job table is updated either
 * way).
 */
export async function processNextJob(
  db: DB,
  opts?: { budgetMs?: number }
): Promise<ProcessOutcome> {
  const job = await claimNextJob(db)
  if (!job) return { kind: "idle" }
  try {
    if (job.action === "continue") {
      const result = await runContinue(db, job, opts?.budgetMs ?? DEFAULT_WORKER_BUDGET_MS)
      await markJobDone(db, job.id)
      return { kind: "processed", jobId: job.id, action: job.action, result }
    }
    // Reserved for phases 3–4.
    await markJobFailed(
      db,
      job,
      { message: `Job action "${job.action}" not implemented`, code: "not_implemented" },
      { retryable: false }
    )
    return { kind: "skipped", jobId: job.id, reason: `unsupported action: ${job.action}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Provider errors are transient — let the job retry. Other errors
    // fall under default retry semantics (max_attempts). Marking failed
    // itself can throw; surface that to the caller via the outcome.
    try {
      await markJobFailed(db, job, { message: msg }, {
        retryable: !(err instanceof ProviderUnavailableError),
      })
    } catch (markErr) {
      const m = markErr instanceof Error ? markErr.message : String(markErr)
      return { kind: "failed", jobId: job.id, error: `${msg} (also failed to mark: ${m})` }
    }
    return { kind: "failed", jobId: job.id, error: msg }
  }
}

// --- continue action -------------------------------------------------------

/**
 * Run one chunk of a yielded run. Loads the checkpoint, rebuilds tools
 * the same way the routes do (cloud MCP only — local-mode creds aren't
 * in the checkpoint), re-applies the original gating, runs the loop
 * with a time budget, and on yield re-enqueues another `continue` job.
 *
 * Returns a short status string for observability ("settled" /
 * "suspended" / "yielded" / "cancelled").
 */
async function runContinue(
  db: DB,
  job: ClaimedJob,
  budgetMs: number
): Promise<string> {
  const checkpoint = await loadCheckpoint(db, job.taskId, job.userId)
  if (!checkpoint) {
    throw new Error(`continue: no checkpoint for run ${job.taskId}`)
  }

  // Resolve the model early so a misconfigured provider fails the job
  // before we start streaming.
  const model = selectModel(checkpoint.config.model)

  // Persistence chain — sink writes each event to task_events, with
  // status/result events also rolling onto the tasks row. No `writer`
  // in the worker; the client reads via the resume endpoint.
  let chain: Promise<void> = Promise.resolve()
  const enqueueWrite = (work: () => Promise<void>) => {
    chain = chain.then(work).catch((err) => {
      console.error("[worker/continue] persist:", err)
    })
  }
  const runId = job.taskId
  const userId = job.userId
  const sink = (event: TaskEvent) => {
    enqueueWrite(() => appendEvent(db, event, userId))
    if (event.kind === "status") {
      enqueueWrite(() =>
        updateRun(db, runId, userId, {
          status: event.status,
          step: event.step,
        })
      )
    } else if (event.kind === "result") {
      enqueueWrite(() =>
        updateRun(db, runId, userId, {
          status: event.status,
          step: event.step,
          finished: true,
        })
      )
    }
  }

  const emitter = new RunEmitter(
    {
      runId,
      maxSteps: checkpoint.config.maxSteps,
      startSeq: checkpoint.seq,
      startStep: checkpoint.step,
    },
    sink
  )
  // The loop only emits `status: running` on a fresh start (emitter.step === 0);
  // for a continuation we emit it ourselves so a client tailing the stream
  // sees the run flip from `paused`/quiet back to `running` immediately.
  emitter.status("running")

  // Tool map — match what the routes build (skills + cloud MCP + plan +
  // askUser). Local-mode MCP is not available in the worker (creds
  // live in the user's browser).
  const enabledSkillIds: SkillId[] = (checkpoint.config.skills ?? []).map(
    (s) => s.id as SkillId
  )
  const skillRequestEntries: SkillRequestEntry[] = checkpoint.config.skills ?? []
  const enabledSet = new Set<SkillId>(enabledSkillIds)
  const entryById = new Map<string, SkillRequestEntry>(
    skillRequestEntries.map((s) => [s.id, s])
  )
  const tools: Record<string, unknown> = {}
  for (const skill of SERVER_SKILLS) {
    if (!enabledSet.has(skill.id)) continue
    // No `consumeBudget` — the worker is system-driven, not user-IP
    // scoped. The skill's per-turn cap is still in force.
    const tool = skill.buildTool(entryById.get(skill.id), {})
    if (tool) tools[skill.toolName] = tool
  }
  const gatedToolNames = new Set<string>([
    ASK_USER_TOOL_NAME,
    ...(checkpoint.config.requireApprovalFor ?? []),
  ])
  tools[ASK_USER_TOOL_NAME] = makeAskUserTool()
  const mcpServers = await loadEffectiveMcpServers(
    checkpoint.config.workspaceId,
    undefined
  )
  for (const server of mcpServers) {
    for (const descriptor of server.capabilities?.tools ?? []) {
      const name = mcpToolName(server.id, descriptor.name)
      tools[name] = gatedToolNames.has(name)
        ? buildGatedMcpTool(server, descriptor)
        : buildMcpTool(server, descriptor, server.credentials)
    }
  }

  const system = buildTaskSystemPrompt({
    workspaceSystemPrompt: checkpoint.config.workspaceSystemPrompt,
    enabledSkillIds,
    skillRequestEntries,
    mcpServers: mcpServers.map((s) => ({
      name: s.name,
      toolCount: s.capabilities?.tools?.length ?? 0,
    })),
  })

  const runMessages: ModelMessage[] = [...checkpoint.messages]
  const runTools: Record<string, unknown> = {
    ...tools,
    [PLAN_TOOL_NAME]: makePlanTool(emitter),
  }
  const runStep = makeStreamTextStep({
    model,
    system,
    messages: runMessages,
    tools: runTools,
    silentTools: new Set([PLAN_TOOL_NAME]),
    gatedTools: gatedToolNames,
  })

  const deadline = Date.now() + budgetMs
  const ac = new AbortController()
  const result = await runAgentLoop({
    emitter,
    maxSteps: checkpoint.config.maxSteps,
    signal: ac.signal,
    isCancelled: () => isRunCancelled(db, runId, userId),
    shouldYield: () => Date.now() > deadline,
    runStep,
  })

  if (result.kind === "suspended") {
    const pi = result.pendingInput
    const nextCheckpoint: RunCheckpoint = {
      messages: runMessages,
      step: emitter.step,
      seq: emitter.seq,
      config: checkpoint.config,
    }
    try {
      await saveCheckpoint(db, runId, userId, nextCheckpoint)
    } catch (err) {
      console.error("[worker/continue] saveCheckpoint:", err)
    }
    emitter.inputRequest({
      approvalId: pi.toolCallId,
      requestKind: requestKindFor(pi.tool, pi.args),
      tool: pi.tool,
      toolCallId: pi.toolCallId,
      args: pi.args,
      ...(pi.tool === ASK_USER_TOOL_NAME && pi.args && typeof pi.args === "object"
        ? extractAskUserFields(pi.args as object)
        : {}),
    })
    emitter.status("paused")
    await chain
    return "suspended"
  }
  if (result.kind === "yielded") {
    const nextCheckpoint: RunCheckpoint = {
      messages: runMessages,
      step: emitter.step,
      seq: emitter.seq,
      config: checkpoint.config,
    }
    try {
      await saveCheckpoint(db, runId, userId, nextCheckpoint)
      await enqueueContinueJob(db, { taskId: runId, userId })
    } catch (err) {
      console.error("[worker/continue] yield handoff:", err)
    }
    await chain
    return "yielded"
  }
  // Settled (done / failed / cancelled — the emitter already wrote the
  // terminal event).
  await chain
  return "settled"
}

function extractAskUserFields(args: object): {
  prompt?: string
  options?: { id: string; label: string }[]
  multi?: boolean
} {
  const a = args as Record<string, unknown>
  const out: {
    prompt?: string
    options?: { id: string; label: string }[]
    multi?: boolean
  } = {}
  if (typeof a.prompt === "string") out.prompt = a.prompt
  if (Array.isArray(a.options)) {
    out.options = a.options
      .map((o) => {
        if (!o || typeof o !== "object") return null
        const id = (o as { id?: unknown }).id
        const label = (o as { label?: unknown }).label
        if (typeof id !== "string" || typeof label !== "string") return null
        return { id, label }
      })
      .filter((x): x is { id: string; label: string } => x !== null)
  }
  if (typeof a.multi === "boolean") out.multi = a.multi
  return out
}

// Re-export the Json type only to keep the import graph honest — used
// in the explicit `payload: Json` shape when worker logic spreads into
// follow-on actions.
export type { Json }
