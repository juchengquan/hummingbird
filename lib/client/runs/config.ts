import "client-only"

/**
 * Feature switch for chat on agent-py's `/v1/runs` ("agent-py (runs)",
 * `docs/PLAN-frontend-backend-split.md` Q33).
 *
 * While `false`, the `'python-runs'` backend option is hidden in the
 * chat-backend selector (`components/auth/account-menu.tsx`) and a chat
 * turn under it behaves exactly as under `'python'` (`apiClient.chat.stream`
 * → agent-py `/v1/chat`). Wave 4b-A flips it to `true` in the same change
 * that sends chat turns through `apiClient.runs.*` — see
 * `lib/client/runs/README.md`.
 */
export const RUNS_CHAT_ENABLED = false
