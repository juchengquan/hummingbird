"use client"
import "client-only"

/**
 * Chat turns on agent-py's runs API (wave 4b-A, README § "For wave 4b-A"):
 * everything `use-chat-send` does for a turn under "agent-py (runs)" once
 * the request is composed — the placeholder, the run session and its
 * sink, Stop → cancel, the sync hold, the active-run pointer, the outcome
 * (incl. interrupts → `useInterruptedTurns`), rejoin after a reload, and
 * the `ChatRunBridge` the answer cards resume through.
 *
 * The session module (`@ag-ui/client`, rxjs, …) is loaded through
 * `deps.loadSession` — `use-chat-send` passes a dynamic import — so
 * nobody who doesn't chat on runs downloads it. This module itself only
 * imports types from it.
 *
 * One live run per conversation (`entries`); the guard "is this
 * conversation's entry still mine" protects the sync hold, the pointer
 * and the live tool-call pills from a superseded run, as the abort
 * controllers do on the `/v1/chat` path.
 */

import type { Dispatch, SetStateAction } from "react"

import { toPersistedToolCalls } from "@/client/chat/tool-call-buffer"
import {
  createTurnWriter,
  messageBaseOf,
  type MessageBase,
  type TurnWriter,
  type TurnWriterStore,
} from "@/client/chat/turn-writer"
import type { AppState } from "@/client/hooks/use-store"
import type { LiveToolCall } from "@/components/skills/tool-call-strip"
import type { PersistedUiPart } from "@/shared/generative-ui/schemas"
import type { Message } from "@/shared/types"

import * as activeRunStore from "./active-run"
import { localMcpCredentialsOf, type ChatRunInput } from "./build-input"
import {
  useInterruptedTurns,
  type AnswerOptions,
  type AnswerResult,
  type InterruptedTurn,
} from "./chat-bridge"
import { createThrottle, planRunOutcome, pointerActionFor, type RunTurnKind } from "./chat-outcome"
import { buildResume, type InterruptAnswer } from "./interrupts"
import { hasOutput } from "./reducer"
import * as runBaseStore from "./run-base"
import type { RunSession, RunSessionOptions } from "./session"
import type { RunsTarget, StartRunRequest } from "./types"

type SessionModule = Pick<
  typeof import("./session"),
  "startRunSession" | "rejoinRunSession" | "resumeRunSession"
>

export type ChatRunnerStore = TurnWriterStore &
  Pick<
    AppState,
    | "conversations"
    | "deleteMessage"
    | "setMessageError"
    | "setMessageReasoningDuration"
    | "setConversationStreaming"
    | "clearMessageOutput"
    | "resolveMessageUiPart"
  >

type InterruptedTurnsApi = Pick<
  ReturnType<typeof useInterruptedTurns.getState>,
  "byConversation" | "setInterruptedTurn" | "clearInterruptedTurn"
>

export interface ChatRunnerDeps {
  /** A fresh store read (`useStore.getState`). */
  store: () => ChatRunnerStore
  setLiveToolCalls: Dispatch<SetStateAction<Record<string, LiveToolCall[]>>>
  /** `() => import("@/client/runs/session")` — lazy on purpose. */
  loadSession: () => Promise<SessionModule>
  /** `resolveRunsTarget` (null → not on runs). */
  resolveTarget: () => Promise<RunsTarget | null>
  /** `apiClient.runs.cancel`. */
  cancelRun: (runId: string, opts: { target: RunsTarget }) => Promise<unknown>
  /** `buildRunInput` — the hook passes the real one. */
  buildRunInput: (input: ChatRunInput) => StartRunRequest
  autoArchive: (messageId: string, conversationId: string) => void
  extractMemory: (turnText: string, conversationId: string, opts: { tainted: boolean }) => void
  memoryEnabled: () => boolean
  /** The request options of a resume when this tab didn't start the
   *  paused run (after a reload): composed like a send's. */
  composeResumeInput: (
    turn: InterruptedTurn,
    history: Message[],
  ) => Omit<ChatRunInput, "conversationId" | "history" | "runId">
  /** Seams (tests). */
  interruptedTurns?: () => InterruptedTurnsApi
  activeRuns?: Pick<
    typeof activeRunStore,
    "saveActiveRun" | "updateActiveRun" | "loadActiveRun" | "listActiveRuns" | "clearActiveRun"
  >
  runBases?: Pick<typeof runBaseStore, "saveRunBase" | "loadRunBase" | "clearRunBase">
  sessionOptions?: Partial<Pick<RunSessionOptions, "fetch" | "tokens" | "maxReconnects" | "reconnectDelayMs">>
  isOffline?: () => boolean
  retryDelayMs?: number
  cursorThrottleMs?: number
}

export interface SendRunRequest {
  conversationId: string
  /** History up to and including the new user message. */
  history: Message[]
  body: StartRunRequest
  target: RunsTarget
  model?: string
  isRetry?: boolean
}

export interface ChatRunner {
  send(req: SendRunRequest): Promise<void>
  /** Before a send on a conversation with a paused turn (Q35): cancel the
   *  paused run (failures ignored) and forget it. */
  supersedeInterrupted(conversationId: string, target: RunsTarget | null): Promise<void>
  /** Stop the conversation's run (cancel it server-side). `false` when it
   *  has none. */
  stop(conversationId: string): boolean
  has(conversationId: string): boolean
  /** Conversations deleted since `prev` (here or in another tab): detach
   *  their sessions, drop their pointers and paused turns. */
  forgetDeleted(conversations: ReadonlyArray<{ id: string }>, prev: ReadonlyArray<{ id: string }>): void
  /** Unmount: stop reading every run (they go on server-side). */
  detachAll(): void
  /** Mount: rejoin each `running` pointer whose message still exists. */
  rejoinActive(): Promise<void>
  /** `ChatRunBridge.answerInterrupts` (lifecycle: `chat-bridge.ts`). */
  answerInterrupts(
    turn: InterruptedTurn,
    answers: Record<string, InterruptAnswer>,
    opts?: AnswerOptions,
  ): Promise<AnswerResult>
}

interface Entry {
  session: RunSession | null
  stopped: boolean
  /** Waiting for the auto-retry's delay. */
  waiting: boolean
  wake: (() => void) | null
}

interface TurnSpec {
  kind: RunTurnKind
  conversationId: string
  placeholder: Message
  target: RunsTarget
  model?: string
  base?: MessageBase
  /** For memory extraction: the turn's user text. */
  userText: string
  isRetry: boolean
  open: (opts: RunSessionOptions) => RunSession
  /** `send`: reopen for the auto-retry (same body). */
  reopen?: (opts: RunSessionOptions) => RunSession
  /** `resume`: the run it answers. */
  previousRunId?: string
  /** `resume`: the answered generative-UI parts, written when it starts
   *  (already in `base`). */
  answeredUiParts?: readonly PersistedUiPart[]
}

function lastUserText(messages: readonly Message[]): string {
  return [...messages].reverse().find((m) => m.role === "user")?.content ?? ""
}

function findMessage(store: ChatRunnerStore, conversationId: string, messageId: string): Message | undefined {
  return store.conversations.find((c) => c.id === conversationId)?.messages.find((m) => m.id === messageId)
}

export function createChatRunner(deps: ChatRunnerDeps): ChatRunner {
  const entries = new Map<string, Entry>()
  /** Bumped by `detachAll` (unmount): a rejoin still resolving its
   *  target / module then doesn't start. */
  let generation = 0
  const bodies = new Map<string, StartRunRequest>()
  const interrupted = deps.interruptedTurns ?? (() => useInterruptedTurns.getState())
  const pointers = deps.activeRuns ?? activeRunStore
  const bases = deps.runBases ?? runBaseStore
  const retryDelayMs = deps.retryDelayMs ?? 1000
  const throttleMs = deps.cursorThrottleMs ?? 1000
  const offline = deps.isOffline ?? (() => typeof navigator !== "undefined" && navigator.onLine === false)

  const writerFor = (conversationId: string, placeholder: Message, base?: MessageBase): TurnWriter => {
    const s = deps.store()
    return createTurnWriter(
      {
        addMessage: s.addMessage,
        setConversationTyping: s.setConversationTyping,
        appendToMessage: s.appendToMessage,
        appendToMessageReasoning: s.appendToMessageReasoning,
        appendMessageGeneratedImages: s.appendMessageGeneratedImages,
        appendMessageGeneratedFiles: s.appendMessageGeneratedFiles,
        appendMessageCodeResult: s.appendMessageCodeResult,
        appendMessageUiPart: s.appendMessageUiPart,
        appendMessageMcpApp: s.appendMessageMcpApp,
        setMessageSuggestions: s.setMessageSuggestions,
        setMessageVerification: s.setMessageVerification,
        setMessageRoutedModel: s.setMessageRoutedModel,
        setMessageToolCalls: s.setMessageToolCalls,
        createArtifact: s.createArtifact,
        clearMessageOutput: s.clearMessageOutput,
        getMessage: (id) => findMessage(deps.store(), conversationId, id),
        setLiveToolCalls: deps.setLiveToolCalls,
      },
      { conversationId, placeholder, base },
    )
  }

  const isMine = (conversationId: string, entry: Entry) => entries.get(conversationId) === entry

  /** Run one turn's session(s) to the end and handle the outcome. */
  const runTurn = async (spec: TurnSpec): Promise<AnswerResult> => {
    const conv = spec.conversationId
    const previous = entries.get(conv)
    if (previous) {
      // A second send before the first settled: stop the older run.
      previous.stopped = true
      previous.wake?.()
      void previous.session?.cancel()
    }
    const entry: Entry = { session: null, stopped: false, waiting: false, wake: null }
    entries.set(conv, entry)
    const store = deps.store()
    store.setConversationStreaming(conv, true)
    if (spec.kind !== "rejoin") store.setConversationTyping(conv, true)

    const writer = writerFor(conv, spec.placeholder, spec.base)
    const messageId = spec.placeholder.id
    let isRetry = spec.isRetry
    let started = false
    let runId = ""
    let result: AnswerResult = { ok: true }
    const cursors = createThrottle<{ runId: string; cursor: string }>(
      ({ runId: id, cursor }) => pointers.updateActiveRun(conv, id, { cursor }),
      throttleMs,
    )

    const sessionOpts: RunSessionOptions = {
      ...deps.sessionOptions,
      target: spec.target,
      sink: { frame: (f) => void writer.handleFrame(f), clear: () => writer.clear() },
      onStarted: (info) => {
        started = true
        runId = info.runId
        if (spec.kind === "rejoin") return
        pointers.saveActiveRun({
          runId: info.runId,
          threadId: info.threadId,
          conversationId: conv,
          messageId,
          status: "running",
          cursor: "0",
          anonymous: !spec.target.authToken,
          ...(spec.model ? { model: spec.model } : {}),
        })
        if (spec.kind === "resume" && spec.previousRunId) {
          // Answered (`chat-bridge.ts`, lifecycle step 3), in this order:
          // the answered parts go on the message before any of the resume's
          // output; the base (which includes them) is saved so a reload
          // rebuilds this message on top of it; then the paused turn — and
          // its cards — is over.
          const s = deps.store()
          for (const part of spec.answeredUiParts ?? []) {
            s.appendMessageUiPart(messageId, part)
            if (part.answer) s.resolveMessageUiPart(messageId, part.id, part.answer)
          }
          if (spec.base) bases.saveRunBase(info.runId, runBaseStore.countsOf(spec.base))
          interrupted().clearInterruptedTurn(conv, spec.previousRunId)
        }
      },
      onCursor: (cursor) => {
        if (runId) cursors.push({ runId, cursor })
      },
    }

    try {
      let session = spec.open(sessionOpts)
      while (true) {
        entry.session = session
        runId = session.runId
        if (entry.stopped) void session.cancel()
        const done = await session.done
        cursors.cancel()
        const plan = planRunOutcome({
          outcome: done.outcome,
          turn: spec.kind,
          hasOutput: hasOutput(done.state.view),
          started,
          isRetry,
          offline: offline(),
          model: spec.model,
        })

        if (plan.kind === "retry" && spec.reopen && isMine(conv, entry) && !entry.stopped) {
          entry.waiting = true
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, retryDelayMs)
            entry.wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
          entry.waiting = false
          entry.wake = null
          if (entry.stopped || !isMine(conv, entry)) {
            const s = deps.store()
            if (!findMessage(s, conv, messageId)?.content) s.deleteMessage(messageId)
            break
          }
          isRetry = true
          started = false
          session = spec.reopen(sessionOpts)
          continue
        }

        const s = deps.store()
        const pointer = pointerActionFor(plan)
        if (pointer === "clear") {
          pointers.clearActiveRun(conv, session.runId)
          bases.clearRunBase(session.runId)
          bodies.delete(session.runId)
        }

        switch (plan.kind) {
          case "detached":
          case "forgotten":
            break
          case "finalize": {
            finalizeToolCalls(s, writer, messageId)
            deps.autoArchive(messageId, conv)
            if (deps.memoryEnabled()) {
              const finalConv = s.conversations.find((c) => c.id === conv)
              if (finalConv && !finalConv.memoryOff) {
                const assistantText = finalConv.messages.find((m) => m.id === messageId)?.content ?? ""
                const turnText = [
                  spec.userText && `User: ${spec.userText}`,
                  assistantText && `Assistant: ${assistantText}`,
                ]
                  .filter(Boolean)
                  .join("\n\n")
                if (turnText.trim()) deps.extractMemory(turnText, conv, { tainted: plan.tainted })
              }
            }
            break
          }
          case "empty":
          case "error":
            s.setMessageError(messageId, plan.error)
            break
          case "cancelled":
            if (plan.dropPlaceholder && !findMessage(s, conv, messageId)?.content) {
              s.deleteMessage(messageId)
            } else {
              finalizeToolCalls(s, writer, messageId)
            }
            break
          case "interrupt": {
            finalizeToolCalls(s, writer, messageId)
            const current = pointers.loadActiveRun(conv)
            if (!current || current.runId === session.runId) {
              pointers.saveActiveRun({
                runId: session.runId,
                threadId: session.threadId,
                conversationId: conv,
                messageId,
                status: "interrupted",
                cursor: done.cursor,
                anonymous: !spec.target.authToken,
                ...(spec.model ? { model: spec.model } : {}),
              })
            }
            interrupted().setInterruptedTurn({
              conversationId: conv,
              messageId,
              runId: session.runId,
              threadId: session.threadId,
              interrupts: plan.interrupts,
              anonymous: !spec.target.authToken,
              ...(spec.model ? { model: spec.model } : {}),
            })
            break
          }
          case "rejected":
            bodies.delete(session.runId)
            result = { ok: false, error: plan.error, code: plan.code }
            break
          case "retry":
            // No reopen (not a send) or superseded: surface it as an error.
            if (done.outcome?.type === "error") s.setMessageError(messageId, done.outcome.error)
            break
        }
        break
      }
    } catch (err) {
      // Never expected (`done` doesn't reject): keep the turn readable.
      deps.store().setMessageError(messageId, {
        code: "unknown",
        model: spec.model,
        detail: err instanceof Error ? err.message : String(err),
      })
      result = { ok: false, error: { code: "unknown", detail: String(err) } }
    } finally {
      cursors.cancel()
      const s = deps.store()
      s.setConversationTyping(conv, false)
      deps.setLiveToolCalls((prev) => {
        if (!(messageId in prev)) return prev
        const next = { ...prev }
        delete next[messageId]
        return next
      })
      // Release the sync hold only if this conversation's run is still
      // this one — a newer run holds it otherwise.
      if (isMine(conv, entry)) {
        entries.delete(conv)
        s.setConversationStreaming(conv, false)
      }
    }
    return result
  }

  const finalizeToolCalls = (s: ChatRunnerStore, writer: TurnWriter, messageId: string) => {
    if (writer.reasoningStart !== null && writer.reasoningLast !== null) {
      s.setMessageReasoningDuration(messageId, Math.max(0, writer.reasoningLast - writer.reasoningStart))
    }
    const persisted = toPersistedToolCalls(writer.toolCalls)
    if (persisted.length > 0) s.setMessageToolCalls(messageId, persisted)
  }

  return {
    async send(req) {
      const s = deps.store()
      const conv = req.conversationId
      s.setConversationTyping(conv, true)
      let mod: SessionModule
      try {
        mod = await deps.loadSession()
      } catch (err) {
        s.setConversationTyping(conv, false)
        const created = s.addMessage({ role: "assistant", content: "" }, conv)
        s.setMessageError(created.id, {
          code: "network",
          model: req.model,
          detail: err instanceof Error ? err.message : "Could not load the runs client.",
        })
        return
      }
      // Parts can arrive before any text (`routed_model` opens a run), so
      // the placeholder exists before the run starts.
      const placeholder = deps.store().addMessage({ role: "assistant", content: "" }, conv)
      bodies.set(req.body.runId, req.body)
      await runTurn({
        kind: "send",
        conversationId: conv,
        placeholder,
        target: req.target,
        model: req.model,
        userText: lastUserText(req.history),
        isRetry: req.isRetry ?? false,
        open: (opts) => mod.startRunSession(req.body, opts),
        reopen: (opts) => mod.startRunSession(req.body, opts),
      })
    },

    async supersedeInterrupted(conversationId, target) {
      const turn = interrupted().byConversation[conversationId]
      const pointer = pointers.loadActiveRun(conversationId)
      const runId = turn?.runId ?? (pointer?.status === "interrupted" ? pointer.runId : undefined)
      if (!runId) return
      if (target) {
        try {
          await deps.cancelRun(runId, { target })
        } catch {
          // Ignored (Q35): the paused run expires on its own.
        }
      }
      pointers.clearActiveRun(conversationId, runId)
      bases.clearRunBase(runId)
      bodies.delete(runId)
      interrupted().clearInterruptedTurn(conversationId)
    },

    stop(conversationId) {
      const entry = entries.get(conversationId)
      if (!entry) return false
      entry.stopped = true
      if (entry.waiting) entry.wake?.()
      else void entry.session?.cancel()
      return true
    },

    has(conversationId) {
      return entries.has(conversationId)
    },

    forgetDeleted(conversations, prev) {
      const live = new Set(conversations.map((c) => c.id))
      const gone = prev.filter((c) => !live.has(c.id)).map((c) => c.id)
      for (const id of [...entries.keys()]) {
        if (live.has(id)) continue
        const entry = entries.get(id)
        if (!entry) continue
        entry.stopped = true
        entry.wake?.()
        entry.session?.detach()
        if (!gone.includes(id)) gone.push(id)
      }
      for (const id of gone) {
        const pointer = pointers.loadActiveRun(id)
        if (pointer) {
          bases.clearRunBase(pointer.runId)
          pointers.clearActiveRun(id, pointer.runId)
        }
        interrupted().clearInterruptedTurn(id)
      }
    },

    detachAll() {
      generation += 1
      const s = deps.store()
      for (const [conv, entry] of entries) {
        entry.stopped = true
        entry.wake?.()
        entry.session?.detach()
        // Release now (not when `done` settles): a remount rejoins at once.
        entries.delete(conv)
        s.setConversationStreaming(conv, false)
      }
    },

    async rejoinActive() {
      const gen = generation
      const running = pointers.listActiveRuns().filter((p) => p.status === "running")
      if (running.length === 0) return
      const target = await deps.resolveTarget()
      if (!target || gen !== generation) return
      let mod: SessionModule
      try {
        mod = await deps.loadSession()
      } catch {
        return
      }
      if (gen !== generation) return
      for (const p of running) {
        if (entries.has(p.conversationId)) continue
        const s = deps.store()
        const conv = s.conversations.find((c) => c.id === p.conversationId)
        const message = conv?.messages.find((m) => m.id === p.messageId)
        if (!conv || !message) {
          pointers.clearActiveRun(p.conversationId, p.runId)
          bases.clearRunBase(p.runId)
          continue
        }
        const counts = bases.loadRunBase(p.runId)
        const before = conv.messages.slice(0, conv.messages.indexOf(message))
        void runTurn({
          kind: "rejoin",
          conversationId: p.conversationId,
          placeholder: message,
          target,
          model: p.model,
          base: counts ? runBaseStore.baseFromCounts(message, counts) : undefined,
          userText: lastUserText(before),
          isRetry: true,
          open: (opts) =>
            mod.rejoinRunSession({ runId: p.runId, threadId: p.threadId, quietUntil: p.cursor }, opts),
        })
      }
    },

    async answerInterrupts(turn, answers, opts) {
      const target = await deps.resolveTarget()
      if (!target) {
        return {
          ok: false,
          error: { code: "unknown", detail: "Chat is not on agent-py (runs) any more." },
          code: "not_on_runs",
        }
      }
      const s = deps.store()
      const conv = s.conversations.find((c) => c.id === turn.conversationId)
      const message = conv?.messages.find((m) => m.id === turn.messageId)
      if (!conv || !message) {
        return { ok: false, error: { code: "unknown", detail: "The paused message is gone." }, code: "not_found" }
      }
      if (entries.has(turn.conversationId)) {
        return {
          ok: false,
          error: { code: "unknown", detail: "This conversation is answering already." },
          code: "busy",
        }
      }
      let mod: SessionModule
      try {
        mod = await deps.loadSession()
      } catch (err) {
        return {
          ok: false,
          error: { code: "network", detail: err instanceof Error ? err.message : "Could not load the runs client." },
          code: "network",
        }
      }
      const history = conv.messages.slice(0, conv.messages.indexOf(message))
      // The resume is a new run with the paused run's options: its request
      // when this tab sent it (`bodies` — memory only, dropped when the run
      // settles), else composed afresh after a reload. Local MCP
      // credentials ride in `state` (Q45) and agent-py keeps none, so they
      // are re-sent too: from the in-memory request, or — after a reload —
      // read again by `composeResumeInput` from where the browser keeps
      // them. Nothing here persists them: `bodies` is never written to
      // storage, and the saved pointers (`active-run.ts`, `run-tokens.ts`,
      // `run-base.ts`) and `InterruptedTurn` carry no request body.
      const previous = bodies.get(turn.runId)
      const input = deps.buildRunInput({
        ...(previous
          ? {
              model: turn.model,
              forwardedProps: previous.forwardedProps,
              localMcpCredentials: localMcpCredentialsOf(previous),
            }
          : deps.composeResumeInput(turn, history)),
        conversationId: turn.conversationId,
        history,
      })
      try {
        // `resumeRunSession` builds `resume[]` with the same (pure)
        // builder, which throws when an interrupt is unanswered or
        // expired — check before anything is held or sent.
        buildResume(turn.interrupts, answers)
      } catch (err) {
        return {
          ok: false,
          error: { code: "unknown", detail: err instanceof Error ? err.message : String(err) },
          code: "invalid_answers",
        }
      }
      bodies.set(input.runId, input)
      const answeredUiParts = opts?.uiParts ?? []
      return runTurn({
        kind: "resume",
        conversationId: turn.conversationId,
        placeholder: message,
        target,
        model: turn.model,
        // What the resume continues: the paused run's output plus the
        // answered parts (written as it starts) — what a reset restores.
        base: messageBaseOf(runBaseStore.withAnsweredUiParts(message, answeredUiParts)),
        answeredUiParts,
        userText: lastUserText(history),
        isRetry: true,
        open: (opts) =>
          mod.resumeRunSession(
            { input, previousRunId: turn.runId, interrupts: turn.interrupts, answers },
            opts,
          ),
        previousRunId: turn.runId,
      })
    },
  }
}
