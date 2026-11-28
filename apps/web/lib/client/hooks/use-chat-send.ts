"use client"
import "client-only"

/**
 * `useChatSend` — owns the chat send pipeline that used to live as the
 * 600-line `callChatAPI` callback inside `components/panels/chat.tsx`.
 *
 * Returns:
 *  - `send(history, options)`: stable wrapper that invokes the latest
 *    pipeline (internal ref keeps closures fresh without forcing
 *    consumers to manage their own).
 *  - `stop()`: aborts the *active* conversation's stream only; other
 *    conversations mid-stream stay running.
 *  - `isStreaming(convId)`: true iff that conv has an in-flight stream.
 *  - `streamingConvIds`: the live Set (consumers can read it directly
 *    for "any conv streaming?" status).
 *  - `liveToolCalls`: per-message in-flight tool-call pills; cleared on
 *    stream `done`. Durable record gets persisted onto the message in
 *    `setMessageToolCalls`.
 *
 * A turn runs on agent-py's runs API (`lib/client/runs/chat-runner.ts`),
 * the only chat path since wave 13 (Q121); a task turn launches a
 * background run (the tasks interface, Q61). Preserves the invariants
 * `callChatAPI` had:
 *  - The conversation id is captured at send time → switching tabs
 *    mid-stream doesn't move the stream's UI state onto the wrong chat.
 *  - `useStore.getState()` fresh reads for `chatModel`, MCP/URL state,
 *    `localFilesOnly` — so retry-after-model-change uses the new
 *    value without waiting for re-render.
 *  - `callChatAPIRef` latest-version pattern (moved internal to the
 *    hook) → `send` stays stable across renders.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { apiClient } from "@/client/api-client"
import { useTasks } from "@/client/runs/tasks/context"
import { launchTaskOnRuns } from "@/components/agent/tasks/launch"
import { autoArchiveCodeBlocks as autoArchiveCodeBlocksPure } from "@/client/chat/auto-archive-code-blocks"
import { resolveSendTargetConversationId } from "@/client/chat/resolve-send-target"
import { buildAttachments } from "@/client/chat/build-attachments"
import { buildTransmittedMessages } from "@/client/chat/build-messages"
import {
  buildSandboxFiles,
  type SandboxFileSource,
} from "@/client/chat/build-sandbox-files"
import { getFileImageDataUrls } from "@/client/files/blob-fields"
import { getBlob } from "@/client/files/local-store"
import { extractAfterTurn } from "@/client/memory/extract-after-turn"
import { useStore } from "@/client/hooks/use-store"
import { getLocalCred } from "@/client/mcp/local-creds"
import type { LiveToolCall } from "@/components/skills/tool-call-strip"
import { composeSystemPrompts } from "@/shared/agents/resolve"
import { withUserSkillInstructions } from "@/shared/skills/user-skill-prompt"
import type { TaskRequestInput } from "@/shared/api-schemas"
import { modelSupportsReasoningEffort } from "@/shared/models"
import { resolveEnabledSkills } from "@/shared/skills/resolve-enabled-skills"
import type { SkillId } from "@/shared/skills/types"
import type { Message } from "@/shared/types"
import {
  attachedMcpResources,
  attachedUrlBookmarks,
} from "@/client/chat/context-sources"
import { runAttachmentsFor } from "@/client/runs/attachments"
import { latestTurnPersona, resolveTurnPersona } from "@/shared/agents/turn-persona"
import { buildRunInput, fitSandboxFilesToRun } from "@/client/runs/build-input"
import { localMcpForRun } from "@/client/runs/local-mcp"
import { registerChatRunBridge } from "@/client/runs/chat-bridge"
import { createChatRunner, type ChatRunner } from "@/client/runs/chat-runner"

export interface SendOptions {
  modelOverride?: string
  isRetry?: boolean
  /** I2I reference URL to forward to the server for this turn.
   *  Captured by the caller ahead of the store clear so a retry doesn't
   *  quietly re-attach a reference the user already dismissed. */
  referenceImage?: { url: string }
  /** Skill ids forced on for this turn by a `/slash` command, on top of
   *  the workspace/conversation cascade. Passed as an arg (not read from
   *  state) so a retry re-applies the same forced set deterministically. */
  forcedSkillIds?: SkillId[]
  /** Skill ids muted (× chip) for this one send. Passed in so the hook
   *  doesn't need to subscribe to panel-level UI state. */
  mutedSkillIds?: Set<SkillId>
  /** When true, launch the turn as a long-running task (Tasks panel)
   *  instead of an inline chat stream. */
  asTask?: boolean
  /** Task mode for this turn — `'research'` triggers Deep Research
   *  mode in the worker. Only meaningful when `asTask` is true. */
  taskMode?: "default" | "research"
  /** Route this turn's reply onto a specific conversation rather than
   *  the React-subscribed `activeConversationId`. Needed when the caller
   *  has *just* created a conversation (e.g. a non-destructive edit/
   *  regenerate fork) in the same event tick: the store's
   *  `activeConversationId` is already the fork, but the subscribed
   *  closure values inside `send` still see the source. When set, the
   *  conversation (and everything derived from it at send-time) is
   *  resolved from `useStore.getState()` for this id. When absent, the
   *  pipeline keeps reading the subscribed `activeConversationId` /
   *  `conversations` — preserving the tab-switch-mid-stream protection. */
  targetConversationId?: string
}

export interface UseChatSendResult {
  send: (history: Message[], options?: SendOptions) => Promise<void>
  stop: () => void
  isStreaming: (convId: string | null | undefined) => boolean
  streamingConvIds: ReadonlySet<string>
  liveToolCalls: Record<string, LiveToolCall[]>
}

/** The attached files `runCode` may mount (`buildSandboxFiles`): a cloud
 *  file by id, a local one's bytes from IndexedDB (the attachment store). */
function sandboxSourcesFor(
  files: ReadonlyArray<{ id: string; name: string; storagePath?: string | null }>
): SandboxFileSource[] {
  return files.map((file) => ({
    fileId: file.id,
    name: file.name,
    storagePath: file.storagePath ?? null,
    readBytes: async () => {
      const blob = await getBlob(file.id)
      if (!blob) return new Uint8Array(0)
      return new Uint8Array(await blob.arrayBuffer())
    },
  }))
}

export function useChatSend(): UseChatSendResult {
  // Slices the pipeline reads when assembling the request. Subscribing
  // keeps the resolved messages array fresh between turns; `getState()`
  // is reserved for values that *must* be read at-send-time
  // (chatModel for retry-after-model-change, MCP/URL state, localFilesOnly).
  const activeConversationId = useStore((s) => s.activeConversationId)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const conversations = useStore((s) => s.conversations)
  const workspaces = useStore((s) => s.workspaces)
  const files = useStore((s) => s.files)
  const conversationFiles = useStore((s) => s.conversationFiles)
  // Enabled portable user skills fold their bodies into the system
  // prompt (client-side v1 activation). See PLAN-portable-skills.md.
  const userSkills = useStore((s) => s.userSkills)
  // Account-level custom instructions — the always-on base of the
  // system-prompt cascade (account style → voice, account about →
  // context). Subscribed so an edit takes effect on the next turn.
  const customInstructionsStyle = useStore((s) => s.customInstructionsStyle)
  const customInstructionsAbout = useStore((s) => s.customInstructionsAbout)
  // --- own state / refs (used to live on the chat panel) ---
  // In-flight streams live in the store (not local state) so `useSync`
  // can hold per-token message diffs until each stream settles.
  const streamingConversationIds = useStore((s) => s.streamingConversationIds)
  const streamingConvIds = useMemo(
    () => new Set(streamingConversationIds),
    [streamingConversationIds]
  )
  const [liveToolCalls, setLiveToolCalls] = useState<
    Record<string, LiveToolCall[]>
  >({})
  // Chat on agent-py's runs API ("agent-py (runs)") — its sessions,
  // Stop → cancel, pointer, rejoin and the answer-card bridge
  // (`lib/client/runs/chat-runner.ts`). Reads the store fresh; the
  // session module (`@ag-ui/client`) is imported only when a run starts.
  const [runner] = useState<ChatRunner>(() =>
    createChatRunner({
      store: () => useStore.getState(),
      setLiveToolCalls,
      loadSession: () => import("@/client/runs/session"),
      resolveTarget: async () =>
        (await import("@/client/api/backend-resolver")).resolveRunsTarget(),
      cancelRun: (runId, opts) => apiClient.runs.cancel(runId, opts),
      buildRunInput,
      autoArchive: (messageId, conversationId) => {
        const st = useStore.getState()
        const message = st.conversations
          .find((c) => c.id === conversationId)
          ?.messages.find((m) => m.id === messageId)
        if (!message) return
        autoArchiveCodeBlocksPure(
          { content: message.content, messageId, conversationId },
          st.createArtifact
        )
      },
      extractMemory: extractAfterTurn,
      memoryEnabled: () => useStore.getState().memoryEnabled,
      // A resume after a reload or from another tab (the paused run's
      // request isn't here): composed like a send's, with the paused run's
      // MCP allow-list (Q51), minus the persona's prompt / forced skills.
      composeResumeInput: (turn) => {
        const st = useStore.getState()
        const conv = st.conversations.find((c) => c.id === turn.conversationId)
        const workspaceId = conv?.workspaceId || st.activeWorkspaceId
        const workspace = st.workspaces.find((w) => w.id === workspaceId)
        const model = turn.model ?? st.chatModel
        const skills = resolveEnabledSkills({ workspace, conversation: conv })
        const resumeFiles = buildAttachments({
          conversation: conv,
          files: st.files,
          conversationFiles: st.conversationFiles,
        }).attachedFiles
        return {
          model,
          systemPrompt: withUserSkillInstructions(
            composeSystemPrompts(
              st.customInstructionsStyle,
              st.customInstructionsAbout,
              workspace?.systemPrompt,
              conv?.systemPrompt,
              ""
            ),
            st.userSkills,
            workspaceId
          ),
          skills,
          workspaceId: workspaceId || undefined,
          allowedMcpServerIds: turn.allowedMcpServerIds,
          // runCode's files (wave 8): this rebuild is synchronous, so the
          // cloud ones only, by id — a local file's bytes aren't read here.
          sandboxFiles: skills.some((s) => s.id === "codeInterpreter")
            ? resumeFiles
                .filter((f) => f.storagePath)
                .slice(0, 10)
                .map((f) => ({ name: f.name, fileId: f.id }))
            : undefined,
          reasoningEffort: modelSupportsReasoningEffort(model)
            ? st.chatReasoningEffort ?? undefined
            : undefined,
          memoryBypass: conv?.memoryOff || undefined,
          verifyCitations: st.verifyCitations || undefined,
          localFilesOnly: st.localFilesOnly || undefined,
          // The conversation's sources as they are now (nothing keeps the
          // paused run's request across a reload) — what a send would
          // attach. Signed in → files by id, images included.
          attachments: runAttachmentsFor({
            files: resumeFiles,
            retrievalModes: conv?.fileRetrievalModes,
            mcpResources: attachedMcpResources(conv, st),
            bookmarks: attachedUrlBookmarks(conv, st),
            cloud: !turn.anonymous,
          }),
          // The local MCP servers + their credentials, re-read for the same
          // reason (Q45). The I2I `referenceImage` is per send and is not
          // re-applied after a reload.
          ...localMcpForRun(st.mcpServers, workspaceId, getLocalCred, {
            allowedMcpServerIds: turn.allowedMcpServerIds,
          }),
        }
      },
    })
  )

  // Tasks on runs (wave 6): a task turn launches a background run (Q61).
  const tasks = useTasks()
  const tasksRef = useRef(tasks)
  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  // Latest-version ref so `send` stays stable without becoming a stale
  // closure across renders. Synced in an effect below, per
  // react-hooks/immutability.
  const callChatAPIRef = useRef<
    ((history: Message[], options?: SendOptions) => Promise<void>) | null
  >(null)

  // --- the pipeline (the body that used to be `callChatAPI`) ---
  const callChatAPI = useCallback(
    async (history: Message[], options?: SendOptions) => {
      // The turn's persona comes from the history, never from the caller
      // (Q52): the newest user message records it, so every send of that
      // turn (first, Regenerate, Edit, Retry, the auto-retry below, a
      // UI card's answer) gets the same prompt, model, skills and MCP
      // allow-list. `allowedMcpServerIds` filters server-side (Q48) and
      // here: absent = no restriction, `[]` = no MCP.
      const persona = resolveTurnPersona(
        latestTurnPersona(history),
        useStore.getState().agents
      )
      const allowedMcpServerIds = persona.allowedMcpServerIds ?? undefined
      // Read the model freshly so retry-after-model-change works.
      const modelForCall =
        options?.modelOverride ?? persona.modelId ?? useStore.getState().chatModel
      const isRetry = options?.isRetry ?? false
      // Capture the conv id at send time so a tab switch mid-stream
      // doesn't move the UI state onto the wrong chat. When the caller
      // explicitly targets a conversation (a just-created fork that the
      // subscribed closure hasn't seen yet), that id wins and the conv
      // is resolved from `getState()` — see `resolveSendTargetConversationId`.
      const targetConvId = resolveSendTargetConversationId(
        options,
        activeConversationId
      )
      if (!targetConvId) return
      // For an explicit target, `conversations` (the subscribed closure)
      // may not yet contain the just-created fork — read it fresh.
      // Without a target, keep using the subscribed array so the
      // tab-switch-mid-stream protection is unchanged.
      const conv = options?.targetConversationId
        ? useStore.getState().conversations.find((c) => c.id === targetConvId)
        : conversations.find((c) => c.id === targetConvId)
      const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
      // Compose the three system-prompt tiers in the cascade: workspace
      // voice → conversation thread context → per-turn persona override.
      // The conversation prompt is **additive** — switching personas does
      // not drop the thread context. See
      // `docs/PLAN-conversation-system-prompt.md`.
      const workspaceSystemPrompt = withUserSkillInstructions(
        composeSystemPrompts(
          customInstructionsStyle,
          customInstructionsAbout,
          activeWorkspace?.systemPrompt,
          conv?.systemPrompt,
          persona.systemPrompt
        ),
        userSkills,
        activeWorkspaceId
      )

      // Effective skills = (workspace/conversation cascade ∪ forced) − muted.
      // Mute wins over forced when both name the same skill.
      const enabledSkills = resolveEnabledSkills({
        workspace: activeWorkspace,
        conversation: conv,
        forcedSkillIds: [...(options?.forcedSkillIds ?? []), ...persona.forcedSkillIds],
        mutedSkillIds: options?.mutedSkillIds,
      })

      // Attachments via the pure helper.
      const { attachedFiles, attachedImageFiles } = buildAttachments({
        conversation: conv,
        files,
        conversationFiles,
      })
      // Image data URLs live in IndexedDB since store v32.
      const attachedImageUrls = await getFileImageDataUrls(attachedImageFiles)

      // Task mode (wave 6, Q71): a background run. The attached images go
      // in the message (by value), never `attachments`; `research` for
      // `/research`; the persona's MCP allow-list; "store files locally".
      // The tasks interface switches a model the worker can't run (Q55).
      if (options?.asTask) {
        const taskInput: TaskRequestInput = {
          messages: buildTransmittedMessages(history, attachedImageUrls) as TaskRequestInput["messages"],
          conversationId: targetConvId,
          model: modelForCall,
          workspaceSystemPrompt,
          workspaceId: activeWorkspaceId || undefined,
          skills: enabledSkills,
          ...(options.taskMode && options.taskMode !== "default"
            ? { mode: options.taskMode }
            : {}),
          ...(allowedMcpServerIds ? { allowedMcpServerIds } : {}),
          ...(useStore.getState().localFilesOnly ? { localFilesOnly: true } : {}),
        }
        // Still reading the session: no launch yet, and no refusal.
        const { availability } = tasksRef.current
        if (!availability.ok && availability.reason === "loading") return
        // The task is titled by its goal (the turn's text); the list shows
        // its conversation's name under it.
        const goal = [...history].reverse().find((m) => m.role === "user")?.content ?? ""
        // runCode's files (Q93): a background run mounts cloud files only,
        // by id — a local file can't reach the worker.
        const sandboxFiles = enabledSkills.some((s) => s.id === "codeInterpreter")
          ? attachedFiles
              .filter((f) => f.storagePath)
              .slice(0, 10)
              .map((f) => ({ name: f.name, fileId: f.id }))
          : []
        await launchTaskOnRuns(
          tasksRef.current,
          sandboxFiles.length > 0 ? { ...taskInput, sandboxFiles } : taskInput,
          { title: goal }
        )
        return
      }

      // Chat on agent-py's runs API (Q33). Signed-out users get a target
      // too (anonymous runs, Q34). An anonymous run's attached images go as
      // the newest user message's parts (their data URLs), and the
      // reasoning tier where the model has one. The contract-0.4.0 options
      // go too where they are at hand (the memory opt-out, citation
      // checks, `localFilesOnly`, the I2I reference, the persona's MCP
      // allow-list, the local MCP servers with their credentials in
      // `state`). Files, MCP resources and URL bookmarks go as
      // `attachments` (`runAttachmentsFor`): a signed-in run's files by
      // id — their images too, so no image data is sent for them (Q44) —
      // and an anonymous run's by value. With the code interpreter on, the
      // attached files `runCode` may mount go as `sandboxFiles` (wave 8):
      // cloud ones by id, local ones with their bytes while they fit.
      const runsTarget = await (
        await import("@/client/api/backend-resolver")
      ).resolveRunsTarget()
      // Q35: a new message while a turn is paused cancels the paused run.
      await runner.supersedeInterrupted(targetConvId, runsTarget)
      await runner.send({
        conversationId: targetConvId,
        history,
        target: runsTarget,
        model: modelForCall,
        isRetry,
        body: buildRunInput({
          conversationId: targetConvId,
          history,
          model: modelForCall,
          systemPrompt: workspaceSystemPrompt,
          skills: enabledSkills,
          workspaceId: activeWorkspaceId || undefined,
          // Signed in: the image files go by id (`attachments`).
          images: runsTarget.authToken ? [] : attachedImageUrls,
          attachments: runAttachmentsFor({
            files: attachedFiles,
            retrievalModes: conv?.fileRetrievalModes,
            mcpResources: attachedMcpResources(conv, useStore.getState()),
            bookmarks: attachedUrlBookmarks(conv, useStore.getState()),
            cloud: runsTarget.authToken !== null,
          }),
          reasoningEffort: modelSupportsReasoningEffort(modelForCall)
            ? useStore.getState().chatReasoningEffort ?? undefined
            : undefined,
          memoryBypass: conv?.memoryOff || undefined,
          verifyCitations: useStore.getState().verifyCitations || undefined,
          localFilesOnly: useStore.getState().localFilesOnly || undefined,
          referenceImage: options?.referenceImage,
          allowedMcpServerIds,
          sandboxFiles: enabledSkills.some((s) => s.id === "codeInterpreter")
            ? fitSandboxFilesToRun(
                await buildSandboxFiles(sandboxSourcesFor(attachedFiles))
              )
            : undefined,
          // Local MCP servers (Q42/Q45); credentials go in `state`.
          ...localMcpForRun(
            useStore.getState().mcpServers,
            activeWorkspaceId,
            getLocalCred,
            { allowedMcpServerIds }
          ),
        }),
      })
    },
    // Reads via getState() (chatModel, MCP state, localFilesOnly) and
    // refs (tasksRef) intentionally don't appear in the deps —
    // fresh-at-send-time / latest-version are the invariants.
    [
      activeConversationId,
      activeWorkspaceId,
      conversationFiles,
      conversations,
      customInstructionsAbout,
      customInstructionsStyle,
      files,
      runner,
      userSkills,
      workspaces,
    ]
  )

  useEffect(() => {
    callChatAPIRef.current = callChatAPI
  }, [callChatAPI])

  // A conversation deleted mid-run — here, or in another tab (the
  // cross-tab merge lets that delete win) — is detached from its run (the
  // run goes on server-side, but nothing writes into a conversation
  // that's gone); its pointers and paused turns are dropped.
  useEffect(
    () =>
      useStore.subscribe((state, prev) => {
        if (state.conversations === prev.conversations) return
        runner.forgetDeleted(state.conversations, prev.conversations)
      }),
    [runner]
  )

  // Runs: the answer cards resume paused turns through this hook
  // (`ChatRunBridge`); after a reload, running answers are rejoined into
  // their messages. Unmount stops reading every run (they go on
  // server-side and are rejoined on the next mount).
  useEffect(() => {
    const unregister = registerChatRunBridge({
      answerInterrupts: (turn, answers, opts) =>
        runner.answerInterrupts(turn, answers, opts),
    })
    const rejoin = () => void runner.rejoinActive()
    let offHydrate: (() => void) | undefined
    if (useStore.persist.hasHydrated()) rejoin()
    else offHydrate = useStore.persist.onFinishHydration(rejoin)
    return () => {
      offHydrate?.()
      unregister()
      runner.detachAll()
    }
  }, [runner])

  // Stable wrapper — consumers don't manage their own ref.
  const send = useCallback(
    (history: Message[], options?: SendOptions): Promise<void> =>
      callChatAPIRef.current?.(history, options) ?? Promise.resolve(),
    []
  )

  const stop = useCallback(() => {
    // Stop only the *active* conv's stream. Other conversations
    // mid-stream stay running — each has its own controller.
    if (!activeConversationId) return
    // Stop cancels the run on the server (Q36).
    runner.stop(activeConversationId)
  }, [activeConversationId, runner])

  const isStreaming = useCallback(
    (convId: string | null | undefined): boolean =>
      !!convId && streamingConvIds.has(convId),
    [streamingConvIds]
  )

  return { send, stop, isStreaming, streamingConvIds, liveToolCalls }
}
