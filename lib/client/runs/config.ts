import "client-only"

/**
 * Feature switch for chat on agent-py's `/v1/runs` ("agent-py (runs)",
 * `docs/PLAN-frontend-backend-split.md` Q33).
 *
 * `true` since wave 4b-A: the `'python-runs'` backend option shows in the
 * chat-backend selector (`components/auth/account-menu.tsx`) and a chat
 * turn under it runs through `apiClient.runs.*` (`use-chat-send` →
 * `chat-runner.ts`). Set it back to `false` to hide the option; a turn
 * under `'python-runs'` then behaves exactly as under `'python'`
 * (`apiClient.chat.stream` → agent-py `/v1/chat`).
 */
export const RUNS_CHAT_ENABLED = true
