import "client-only"

import { useShallow } from "zustand/react/shallow"

import { useStore } from "../../use-store"
import type { SliceCreator } from "../types"

/** Per-field cap for account-level custom instructions. The account
 *  layer is meant to be concise (cf. workspace/conversation prompts at
 *  20k); enforced again in the dialog UI + trimmed at compose time. */
export const ACCOUNT_INSTRUCTIONS_MAX = 4000

/**
 * Account-level custom instructions — the global, always-on base of the
 * system-prompt cascade. Two free-text fields the user authors once:
 *   - `customInstructionsAbout`: "What should the model know about you?"
 *   - `customInstructionsStyle`: "How should the model respond?"
 * Local-first (persisted to localStorage); synced to `profiles` when
 * signed in (later task). Composed into every chat by
 * `composeSystemPrompts` beneath workspace/conversation/persona.
 */
export interface AccountInstructionsSlice {
  customInstructionsAbout: string
  customInstructionsStyle: string
  setAccountInstructions: (patch: { about?: string; style?: string }) => void
}

export const createAccountInstructionsSlice: SliceCreator<
  AccountInstructionsSlice
> = (set) => ({
  customInstructionsAbout: "",
  customInstructionsStyle: "",
  setAccountInstructions: (patch) =>
    set((s) => ({
      customInstructionsAbout:
        patch.about !== undefined
          ? patch.about.slice(0, ACCOUNT_INSTRUCTIONS_MAX)
          : s.customInstructionsAbout,
      customInstructionsStyle:
        patch.style !== undefined
          ? patch.style.slice(0, ACCOUNT_INSTRUCTIONS_MAX)
          : s.customInstructionsStyle,
    })),
})

/** Selector hook — the two fields as a stable object. */
export const useAccountInstructions = () =>
  useStore(
    useShallow((s) => ({
      about: s.customInstructionsAbout,
      style: s.customInstructionsStyle,
    })),
  )
