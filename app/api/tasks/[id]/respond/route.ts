import "server-only"

import type { NextRequest } from "next/server"

import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import type { ModelMessage } from "ai"
import { NextResponse } from "next/server"

import {
  ProviderUnavailableError,
  selectModel,
} from "@/server/model-provider"
import { categorizeError } from "@/shared/api-errors"
import { RespondRequestSchema } from "@/shared/api-schemas"
import { ASK_USER_TOOL_NAME, requestKindFor } from "@/server/agent/input-policy"
import { makeAskUserTool } from "@/server/agent/ask-user-tool"
import { buildGatedMcpTool, buildMcpTool, mcpToolName } from "@/server/mcp/tools"
import { callTool } from "@/server/mcp/client"
import { loadEffectiveMcpServers } from "@/server/mcp/load-servers"
import {
  SERVER_SKILLS,
  type SkillRequestEntry,
} from "@/server/skills/registry"
import type { SkillId } from "@/shared/skills/types"
import { getSupabaseServerClient } from "@/server/supabase/server"
import type { TaskEvent } from "@/shared/agent/events"
import { RunEmitter } from "@/shared/agent/emitter"
import { toDataPart } from "@/shared/agent/wire"
import { makeStreamTextStep, runAgentLoop } from "@/server/agent/runner"
import { PLAN_TOOL_NAME, makePlanTool } from "@/server/agent/plan-tool"
import type { RunCheckpoint } from "@/server/agent/checkpoint"
import {
  appendEvent,
  getRun,
  isRunCancelled,
  loadCheckpoint,
  saveCheckpoint,
  updateRun,
} from "@/server/agent/store"

/**
 * Resolve a HITL pending input — approve/reject a gated tool, choose
 * one of the options, or supply a value — and continue the run from
 * its checkpoint. Returns the AI-SDK data stream of the continuation
 * exactly like `POST /api/tasks`, so the client folds it through the
 * same `reduceRun`.
 *
 * Because this is a *new* invocation, all run state comes from the
 * checkpoint (messages, step, seq, config). Local-mode MCP creds are
 * the one thing the client must re-supply (secrets aren't persisted).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: runId } = await params
  const db = await getSupabaseServerClient()
  if (!db) {
    return NextResponse.json(
      { code: "unavailable", message: "Supabase is not configured." },
      { status: 503 }
    )
  }
  const { data: userData, error: authError } = await db.auth.getUser()
  if (authError || !userData.user) {
    return NextResponse.json(
      { code: "auth", message: "Unauthorized." },
      { status: 401 }
    )
  }
  const userId = userData.user.id

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json(
      { code: "invalid_request", message: "Body must be JSON." },
      { status: 400 }
    )
  }
  const parsed = RespondRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request body.",
      },
      { status: 400 }
    )
  }
  const body = parsed.data

  const run = await getRun(db, runId, userId)
  if (!run) {
    return NextResponse.json(
      { code: "not_found", message: "Run not found." },
      { status: 404 }
    )
  }
  if (run.status !== "paused") {
    return NextResponse.json(
      { code: "invalid_state", message: `Run is not paused (status=${run.status}).` },
      { status: 409 }
    )
  }
  const checkpoint = await loadCheckpoint(db, runId, userId)
  if (!checkpoint) {
    return NextResponse.json(
      { code: "invalid_state", message: "Run has no checkpoint to resume from." },
      { status: 409 }
    )
  }

  // Resolve the model up front so an unconfigured provider returns a
  // clean 401 instead of failing mid-stream.
  let model
  try {
    model = selectModel(checkpoint.config.model)
  } catch (error) {
    if (error instanceof ProviderUnavailableError) {
      return NextResponse.json(
        { code: "auth", message: error.message },
        { status: 401 }
      )
    }
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }

  // Find the pending tool call in the checkpoint's messages — the last
  // assistant message will carry it (the SDK appended it after the
  // model's no-execute call). We pair the human's answer with this
  // toolCallId.
  const pending = findPendingToolCall(checkpoint.messages, body.requestId)
  if (!pending) {
    return NextResponse.json(
      { code: "invalid_state", message: "Pending input not found in the checkpoint." },
      { status: 409 }
    )
  }

  const kind = requestKindFor(pending.toolName, pending.args)
  const finalArgs = body.args !== undefined ? body.args : pending.args

  // Rebuild the run's tool map for the continuation. Same rules as
  // the start route: skills + MCP (cloud via workspaceId, local from
  // the re-sent body.mcpServers), with gated tools registered without
  // execute so a second approval can suspend again.
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
    const tool = skill.buildTool(entryById.get(skill.id), { signal: req.signal })
    if (tool) tools[skill.toolName] = tool
  }
  const mcpServers = await loadEffectiveMcpServers(
    checkpoint.config.workspaceId,
    body.mcpServers
  )
  // For v1 we treat the same tool as gated on continuation only if it's
  // an MCP tool (the start route's policy is per-name; without that
  // policy persisted we err on safety: any MCP tool can re-suspend on a
  // second sensitive call, matching the start-route behavior when the
  // client re-supplies `requireApprovalFor`). The client is expected to
  // re-supply gating via the start route on the *next* fresh run; on a
  // continuation, gating is implicit only on the tool that paused us.
  // `askUser` is always gated on continuations too — the model may
  // call it again after answering the previous question.
  const gatedToolNames = new Set<string>([ASK_USER_TOOL_NAME])
  tools[ASK_USER_TOOL_NAME] = makeAskUserTool()
  for (const server of mcpServers) {
    for (const descriptor of server.capabilities?.tools ?? []) {
      const name = mcpToolName(server.id, descriptor.name)
      tools[name] = buildMcpTool(server, descriptor, server.credentials)
      // Same heuristic: only the originally paused tool stays gated
      // here (so the continuation can pause again if the model retries
      // the same action). Other tools execute normally on continuation.
      if (name === pending.toolName) {
        tools[name] = buildGatedMcpTool(server, descriptor)
        gatedToolNames.add(name)
      }
    }
  }

  // Produce the tool-result message that resolves the pending call.
  // For `approval`: execute the real tool now (if approved) or a
  // synthetic "declined" result. For `choice`/`input` (askUser): the
  // user's selection/value is the result; askUser has no side effect.
  const resultText = await buildToolResult({
    kind,
    pending,
    body,
    mcpServers,
    finalArgs,
  })
  const messages: ModelMessage[] = [
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

  // Build the same system prompt the start route did so the continuation
  // has the same instruction context.
  const system = buildTaskSystemPrompt({
    workspaceSystemPrompt: checkpoint.config.workspaceSystemPrompt,
    enabledSkillIds,
    skillRequestEntries,
    mcpServers: mcpServers.map((s) => ({
      name: s.name,
      toolCount: s.capabilities?.tools?.length ?? 0,
    })),
  })

  // Mirror the start route's sink: write to the wire + chain DB writes.
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let chain: Promise<void> = Promise.resolve()
      const enqueue = (work: () => Promise<void>) => {
        chain = chain.then(work).catch((err) => {
          console.error("[tasks/respond] persist:", err)
        })
      }
      const sink = (event: TaskEvent) => {
        writer.write(toDataPart(event))
        enqueue(() => appendEvent(db, event, userId))
        if (event.kind === "status") {
          enqueue(() =>
            updateRun(db, runId, userId, {
              status: event.status,
              step: event.step,
            })
          )
        } else if (event.kind === "result") {
          enqueue(() =>
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

      // Record the human's answer first (clears `pendingInput` in the
      // projection), then flip status back to `running` and resume.
      emitter.inputResponse({
        approvalId: body.requestId,
        ...(body.approved !== undefined ? { approved: body.approved } : {}),
        ...(body.selection !== undefined ? { selection: body.selection } : {}),
        ...(body.value !== undefined ? { value: body.value } : {}),
      })
      emitter.status("running")

      const runTools: Record<string, unknown> = {
        ...tools,
        [PLAN_TOOL_NAME]: makePlanTool(emitter),
      }
      const runStep = makeStreamTextStep({
        model,
        system,
        messages,
        tools: runTools,
        silentTools: new Set([PLAN_TOOL_NAME]),
        gatedTools: gatedToolNames,
      })

      const result = await runAgentLoop({
        emitter,
        maxSteps: checkpoint.config.maxSteps,
        signal: req.signal,
        isCancelled: () => isRunCancelled(db, runId, userId),
        runStep,
      })

      if (result.kind === "suspended") {
        const pi = result.pendingInput
        const nextCheckpoint: RunCheckpoint = {
          messages,
          step: emitter.step,
          seq: emitter.seq,
          config: checkpoint.config,
        }
        try {
          await saveCheckpoint(db, runId, userId, nextCheckpoint)
        } catch (err) {
          console.error("[tasks/respond] saveCheckpoint:", err)
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
      }

      await chain
    },
  })

  return createUIMessageStreamResponse({ stream })
}

// --- helpers ---------------------------------------------------------------

interface PendingToolCall {
  toolCallId: string
  toolName: string
  args: unknown
}

/** Walk back through the assistant's messages to find the un-resolved
 *  tool call whose id matches `requestId` (which is the toolCallId). */
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
  kind: "approval" | "choice" | "input"
  pending: PendingToolCall
  body: { approved?: boolean; selection?: string[]; value?: string }
  mcpServers: Awaited<ReturnType<typeof loadEffectiveMcpServers>>
  finalArgs: unknown
}): Promise<string> {
  const { kind, pending, body, mcpServers, finalArgs } = opts
  if (kind === "approval") {
    if (body.approved === false) {
      return "User declined to run this action. Consider an alternative or ask the user how to proceed."
    }
    // Approved → execute the real MCP tool now (out-of-band).
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
    const sel = Array.isArray(body.selection) ? body.selection : []
    return sel.length > 0
      ? `User selected: ${sel.join(", ")}`
      : "(User submitted no selection.)"
  }
  // input
  return typeof body.value === "string" && body.value.length > 0
    ? body.value
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

function buildTaskSystemPrompt(opts: {
  workspaceSystemPrompt?: string
  enabledSkillIds: SkillId[]
  skillRequestEntries: SkillRequestEntry[]
  mcpServers: { name: string; toolCount: number }[]
}): string {
  const trimmedWorkspace = opts.workspaceSystemPrompt?.trim()
  const enabled = new Set<SkillId>(opts.enabledSkillIds)
  const entryById = new Map<string, SkillRequestEntry>(
    opts.skillRequestEntries.map((s) => [s.id, s])
  )
  const notes: string[] = []
  for (const skill of SERVER_SKILLS) {
    if (!enabled.has(skill.id)) continue
    const fragment = skill.promptFragment(entryById.get(skill.id))
    if (fragment) notes.push(fragment)
  }
  const skillsLine =
    notes.length > 0
      ? `Available capabilities:\n${notes.map((n) => `- ${n}`).join("\n")}`
      : null
  const activeMcp = (opts.mcpServers ?? []).filter((s) => s.toolCount > 0)
  const mcpLine =
    activeMcp.length > 0
      ? `You also have tools from connected MCP servers (prefixed ` +
        `\`mcp__<serverId>__<toolName>\`); call them when relevant. ` +
        `Connected:\n${activeMcp
          .map((s) => `- "${s.name}" (${s.toolCount} tools)`)
          .join("\n")}`
      : null
  return [
    trimmedWorkspace,
    "You are an autonomous agent inside the Hummingbird app, working on a " +
      "multi-step task. Start by calling `setPlan` with a short todo list " +
      "of the steps you intend to take, then update it (via `setPlan` " +
      "again) as steps move to 'in_progress' and 'completed'. Call the " +
      "available tools as needed and keep going until the task is " +
      "complete. If you need a decision from the user (which option to " +
      "pick, a value to use), call `askUser` — the run pauses and the " +
      "user's answer comes back as the tool's result. When you have " +
      "finished, write a clear final answer in Markdown.",
    skillsLine,
    mcpLine,
  ]
    .filter(Boolean)
    .join("\n\n")
}
