import "server-only"

/**
 * The job-queue worker (`PLAN-agent-task-queue.md`). v1 handles three
 * actions:
 *
 *  - **`start`** — fresh run. The route persisted an initial checkpoint
 *    with `step=0, seq=1` (the synthetic `status:queued` event) and
 *    enqueued this job. The worker just runs the loop from step 0;
 *    `runAgentLoop` auto-emits `status:running` for step=0.
 *  - **`respond`** — human resolved a HITL pause. Payload carries the
 *    answer; we find the pending tool call in the checkpointed
 *    messages, execute the gated tool (or synthesise a "declined"
 *    result for approval-reject / `askUser`), append it as a tool
 *    result message, then resume the loop.
 *  - **`continue`** — yielded mid-run (time budget exhausted). The
 *    checkpoint is what the inline route saved on yield; we just resume.
 *
 * All three end with the same shared core: build tools, run the loop,
 * handle settle / suspend / yield. The route + this worker are now
 * the only producers of agent-event rows; nothing streams inline.
 *
 * The `db` MUST be the service-role admin client — RLS would limit the
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
import { callTool } from "@/server/mcp/client"
import { loadEffectiveMcpServers } from "@/server/mcp/load-servers"
import { buildGatedMcpTool, buildMcpTool, mcpToolName } from "@/server/mcp/tools"
import { RunEmitter } from "@/shared/agent/emitter"
import type { TaskEvent } from "@/shared/agent/events"
import type { Database, Json } from "@/shared/supabase/types"

import type { RunCheckpoint } from "./checkpoint"
import { makeAskUserTool } from "./ask-user-tool"
import { ASK_USER_TOOL_NAME, requestKindFor, type RequestKind } from "./input-policy"
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

/** Payload shape for `respond` jobs. The route validates the human's
 *  answer against `RespondRequestSchema` and writes it here verbatim. */
interface RespondJobPayload {
  requestId: string
  approved?: boolean
  selection?: string[]
  value?: string
  args?: unknown
}

/**
 * Claim the next ready job and run it. Returns `{kind:'idle'}` when the
 * queue is empty or the candidate was raced away.
 */
export async function processNextJob(
  db: DB,
  opts?: { budgetMs?: number }
): Promise<ProcessOutcome> {
  const job = await claimNextJob(db)
  if (!job) return { kind: "idle" }
  const budgetMs = opts?.budgetMs ?? DEFAULT_WORKER_BUDGET_MS
  try {
    let outcome: string
    if (job.action === "start") {
      outcome = await runStart(db, job, budgetMs)
    } else if (job.action === "continue") {
      outcome = await runContinue(db, job, budgetMs)
    } else if (job.action === "respond") {
      outcome = await runRespond(db, job, budgetMs)
    } else {
      await markJobFailed(
        db,
        job,
        { message: `Unknown action "${job.action}"`, code: "unknown_action" },
        { retryable: false }
      )
      return { kind: "skipped", jobId: job.id, reason: `unknown action: ${job.action}` }
    }
    await markJobDone(db, job.id)
    return { kind: "processed", jobId: job.id, action: job.action, result: outcome }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
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

// --- Per-action handlers ---------------------------------------------------

/**
 * Fresh-start run. The checkpoint was preconfigured by the route with
 * `step=0, seq=1` (after the synthetic `status:queued` event). The
 * runner auto-emits `status:running` at `step==0`, so we don't need to
 * emit anything before the loop.
 */
async function runStart(
  db: DB,
  job: ClaimedJob,
  budgetMs: number
): Promise<string> {
  const checkpoint = await loadCheckpoint(db, job.taskId, job.userId)
  if (!checkpoint) {
    throw new Error(`start: no initial checkpoint for run ${job.taskId}`)
  }
  return runChunk(db, job.taskId, job.userId, checkpoint, budgetMs, {
    emitRunningBeforeLoop: false,
  })
}

/**
 * Continuation after a time-budget yield. Status was already `running`
 * before the yield; we re-emit it on the chunk boundary so a client
 * tailing the stream sees activity resume.
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
  return runChunk(db, job.taskId, job.userId, checkpoint, budgetMs, {
    emitRunningBeforeLoop: true,
  })
}

/**
 * Human-in-the-loop response. Loads the checkpoint, finds the pending
 * tool call, builds the result message (executing the real MCP tool for
 * approval-approve, otherwise synthesising), appends it, persists the
 * updated checkpoint, then runs the loop.
 */
async function runRespond(
  db: DB,
  job: ClaimedJob,
  budgetMs: number
): Promise<string> {
  const checkpoint = await loadCheckpoint(db, job.taskId, job.userId)
  if (!checkpoint) {
    throw new Error(`respond: no checkpoint for run ${job.taskId}`)
  }
  const payload = parseRespondPayload(job.payload)
  if (!payload) {
    throw new Error("respond: invalid job payload")
  }

  const pending = findPendingToolCall(checkpoint.messages, payload.requestId)
  if (!pending) {
    throw new Error(
      `respond: pending tool call ${payload.requestId} not found in checkpoint`
    )
  }
  const kind = requestKindFor(pending.toolName, pending.args)
  const finalArgs = payload.args !== undefined ? payload.args : pending.args

  // Local-mode MCP creds aren't carried into the job — the worker can
  // only reach cloud-mode servers. Persona allow-list (Phase 2 of
  // PLAN-custom-agents.md) further restricts which cloud servers are
  // visible for this run.
  const mcpServersForResult = await loadEffectiveMcpServers(
    checkpoint.config.workspaceId,
    undefined,
    { allowedServerIds: checkpoint.config.allowedMcpServerIds }
  )
  const resultText = await buildToolResult({
    kind,
    pending,
    payload,
    mcpServers: mcpServersForResult,
    finalArgs,
  })
  const updatedMessages: ModelMessage[] = [
    ...checkpoint.messages,
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          output: { type: "text", value: resultText },
        },
      ],
    } as ModelMessage,
  ]
  const updatedCheckpoint: RunCheckpoint = {
    ...checkpoint,
    messages: updatedMessages,
  }
  // Persist before emitting so a crash between emit and save can't lose
  // the tool result message.
  await saveCheckpoint(db, job.taskId, job.userId, updatedCheckpoint)

  return runChunk(db, job.taskId, job.userId, updatedCheckpoint, budgetMs, {
    emitRunningBeforeLoop: true,
    emitInputResponseBeforeLoop: {
      requestId: payload.requestId,
      approved: payload.approved,
      selection: payload.selection,
      value: payload.value,
    },
  })
}

// --- Shared core: run one chunk of the loop --------------------------------

interface RunChunkOptions {
  emitRunningBeforeLoop: boolean
  emitInputResponseBeforeLoop?: {
    requestId: string
    approved?: boolean
    selection?: string[]
    value?: string
  }
}

async function runChunk(
  db: DB,
  runId: string,
  userId: string,
  checkpoint: RunCheckpoint,
  budgetMs: number,
  opts: RunChunkOptions
): Promise<string> {
  // Resolve the model early so a misconfigured provider fails the job
  // before we start streaming.
  const model = selectModel(checkpoint.config.model)

  // Persistence chain — sink writes each event to task_events, with
  // status/result events also rolling onto the tasks row. The worker
  // has no UI writer; the client reads via the resume endpoint.
  let chain: Promise<void> = Promise.resolve()
  const enqueueWrite = (work: () => Promise<void>) => {
    chain = chain.then(work).catch((err) => {
      console.error("[worker] persist:", err)
    })
  }
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

  // Pre-loop events. `respond` emits the inputResponse first (clears
  // pendingInput in the projection), then status:running. `continue`
  // just re-emits running. `start` does neither — runner auto-emits
  // running at step=0.
  if (opts.emitInputResponseBeforeLoop) {
    const ir = opts.emitInputResponseBeforeLoop
    emitter.inputResponse({
      approvalId: ir.requestId,
      ...(ir.approved !== undefined ? { approved: ir.approved } : {}),
      ...(ir.selection !== undefined ? { selection: ir.selection } : {}),
      ...(ir.value !== undefined ? { value: ir.value } : {}),
    })
  }
  if (opts.emitRunningBeforeLoop) {
    emitter.status("running")
  }

  // Tool map — skills + cloud MCP + setPlan + askUser, gated per the
  // checkpoint's `requireApprovalFor` plus the always-gated askUser.
  const enabledSkillIds: SkillId[] = (checkpoint.config.skills ?? []).map(
    (s) => s.id as SkillId
  )
  const skillRequestEntries: SkillRequestEntry[] =
    checkpoint.config.skills ?? []
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
    undefined,
    { allowedServerIds: checkpoint.config.allowedMcpServerIds }
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
    mode: checkpoint.config.mode,
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
      console.error("[worker] saveCheckpoint:", err)
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
      console.error("[worker] yield handoff:", err)
    }
    await chain
    return "yielded"
  }
  await chain
  return "settled"
}

// --- helpers ---------------------------------------------------------------

interface PendingToolCall {
  toolCallId: string
  toolName: string
  args: unknown
}

function findPendingToolCall(
  messages: ModelMessage[],
  requestId: string
): PendingToolCall | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue
    for (const part of m.content) {
      if (!part || typeof part !== "object") continue
      const p = part as {
        type?: string
        toolCallId?: string
        toolName?: string
        input?: unknown
        args?: unknown
      }
      if (p.type === "tool-call" && p.toolCallId === requestId) {
        return {
          toolCallId: p.toolCallId,
          toolName: typeof p.toolName === "string" ? p.toolName : "",
          args: p.input ?? p.args,
        }
      }
    }
  }
  return null
}

async function buildToolResult(opts: {
  kind: RequestKind
  pending: PendingToolCall
  payload: RespondJobPayload
  mcpServers: Awaited<ReturnType<typeof loadEffectiveMcpServers>>
  finalArgs: unknown
}): Promise<string> {
  const { kind, pending, payload, mcpServers, finalArgs } = opts
  if (kind === "approval") {
    if (payload.approved === false) {
      return "User declined to run this action. Consider an alternative or ask the user how to proceed."
    }
    const match = matchMcpTool(pending.toolName, mcpServers)
    if (!match) {
      return `(Approved, but the tool "${pending.toolName}" is no longer registered.)`
    }
    try {
      const { text, isError } = await callTool(
        match.server,
        match.server.credentials,
        match.descriptor.name,
        finalArgs
      )
      if (isError) return `Tool error: ${text}`
      return text
    } catch (err) {
      return `Tool error: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (kind === "choice") {
    const sel = Array.isArray(payload.selection) ? payload.selection : []
    return sel.length > 0
      ? `User selected: ${sel.join(", ")}`
      : "(User submitted no selection.)"
  }
  // input
  return typeof payload.value === "string" && payload.value.length > 0
    ? payload.value
    : "(User submitted no value.)"
}

function matchMcpTool(
  prefixedName: string,
  mcpServers: Awaited<ReturnType<typeof loadEffectiveMcpServers>>
) {
  for (const server of mcpServers) {
    for (const descriptor of server.capabilities?.tools ?? []) {
      if (mcpToolName(server.id, descriptor.name) === prefixedName) {
        return { server, descriptor }
      }
    }
  }
  return null
}

function parseRespondPayload(p: Json): RespondJobPayload | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null
  const o = p as Record<string, unknown>
  if (typeof o.requestId !== "string" || o.requestId.length === 0) return null
  const out: RespondJobPayload = { requestId: o.requestId }
  if (typeof o.approved === "boolean") out.approved = o.approved
  if (Array.isArray(o.selection)) {
    out.selection = o.selection.filter((x): x is string => typeof x === "string")
  }
  if (typeof o.value === "string") out.value = o.value
  if ("args" in o) out.args = o.args
  return out
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
