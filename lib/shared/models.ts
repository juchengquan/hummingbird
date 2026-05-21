export interface ChatModel {
  id: string
  label: string
  provider: string
  /** Total context window in tokens. Used by the chat header's
   *  context meter to surface how close the conversation is to the
   *  model's drop-old-messages threshold. */
  contextWindow: number
}

export const CHAT_MODELS: ChatModel[] = [
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', provider: 'Anthropic', contextWindow: 1_000_000 },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', provider: 'Anthropic', contextWindow: 200_000 },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5', provider: 'OpenAI', contextWindow: 1_000_000 },
  { id: 'openai/gpt-5.3-chat', label: 'ChatGPT (latest)', provider: 'OpenAI', contextWindow: 128_000 },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Google', contextWindow: 1_048_576 },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'Google', contextWindow: 1_000_000 },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek v4 Flash', provider: 'DeepSeek', contextWindow: 1_000_000 },
  { id: 'minimax/minimax-m2.7', label: 'MiniMax M2.7', provider: 'MiniMax', contextWindow: 204_800 },
]

export const DEFAULT_CHAT_MODEL = 'deepseek/deepseek-v4-flash'

/** Look up a model definition by id. Returns null when the id is
 *  unknown (rare — typically only on legacy state from before a model
 *  was removed). */
export function getChatModel(id: string): ChatModel | null {
  return CHAT_MODELS.find((m) => m.id === id) ?? null
}
