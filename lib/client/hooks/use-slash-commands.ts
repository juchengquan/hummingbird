"use client"

import "client-only"

import { useCallback, useState } from "react"
import { toast } from "sonner"

import { useStore } from "@/client/hooks/use-store"
import { CHAT_MODELS } from "@/shared/models"
import type { CommandId } from "@/shared/commands/registry"

/**
 * Client-side runtime for the `/` action commands (`/new`, `/clear`,
 * `/rename`, `/model`, `/help`). The metadata + parsing live in
 * `lib/shared/commands/registry.ts`; this hook owns the *actions* —
 * store mutations, the destructive-confirm dialog, and the help
 * dialog. Returned state is rendered by the chat panel.
 *
 * See `docs/PLAN-slash-action-commands.md`.
 */
export interface UseSlashCommandsOptions {
  /** Open the chat-header model picker (local chat-panel state). */
  openModelPicker: () => void
  /** Whether the active conversation is mid-stream — destructive
   *  commands are blocked while true. */
  isStreaming: boolean
}

export interface UseSlashCommandsResult {
  /** Dispatch a parsed command. Instant commands fire immediately;
   *  `/clear` opens the confirm dialog. */
  run: (commandId: CommandId, arg: string) => void
  clearConfirmOpen: boolean
  setClearConfirmOpen: (open: boolean) => void
  /** Fired by the confirm dialog's destructive action. */
  confirmClear: () => void
  helpOpen: boolean
  setHelpOpen: (open: boolean) => void
}

export function useSlashCommands({
  openModelPicker,
  isStreaming,
}: UseSlashCommandsOptions): UseSlashCommandsResult {
  const createConversation = useStore((s) => s.createConversation)
  const setActiveConversation = useStore((s) => s.setActiveConversation)
  const renameConversation = useStore((s) => s.renameConversation)
  const clearMessages = useStore((s) => s.clearMessages)
  const setChatModel = useStore((s) => s.setChatModel)

  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  const confirmClear = useCallback(() => {
    clearMessages()
    toast.success("Conversation cleared")
  }, [clearMessages])

  const run = useCallback(
    (commandId: CommandId, arg: string) => {
      switch (commandId) {
        case "new": {
          const conv = createConversation()
          setActiveConversation(conv.id)
          break
        }
        case "clear": {
          if (isStreaming) {
            toast.error("Stop the response first")
            break
          }
          setClearConfirmOpen(true)
          break
        }
        case "rename": {
          const title = arg.trim()
          if (!title) break // required-arg guard already upstream; belt + suspenders
          const activeId = useStore.getState().activeConversationId
          if (!activeId) break
          renameConversation(activeId, title)
          toast.success("Conversation renamed")
          break
        }
        case "model": {
          const needle = arg.trim().toLowerCase()
          if (!needle) {
            openModelPicker()
            break
          }
          const match = CHAT_MODELS.find(
            (m) =>
              m.id.toLowerCase() === needle ||
              m.label.toLowerCase() === needle ||
              m.id.toLowerCase().includes(needle) ||
              m.label.toLowerCase().includes(needle)
          )
          if (match) {
            setChatModel(match.id)
            toast.success(`Model: ${match.label}`)
          } else {
            toast.error(`No model matches "${arg.trim()}"`)
            openModelPicker()
          }
          break
        }
        case "help": {
          setHelpOpen(true)
          break
        }
      }
    },
    [
      createConversation,
      setActiveConversation,
      renameConversation,
      setChatModel,
      openModelPicker,
      isStreaming,
    ]
  )

  return {
    run,
    clearConfirmOpen,
    setClearConfirmOpen,
    confirmClear,
    helpOpen,
    setHelpOpen,
  }
}
