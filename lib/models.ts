export interface ChatModel {
  id: string
  label: string
  provider: string
}

export const CHAT_MODELS: ChatModel[] = [
  { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'Anthropic' },
  { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'Anthropic' },
  { id: 'openai/gpt-4o', label: 'GPT-4o', provider: 'OpenAI' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', provider: 'OpenAI' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Google' },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'Google' },
  { id: 'deepseek/deepseek-chat-v3.1', label: 'DeepSeek Chat v3.1', provider: 'DeepSeek' },
  { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1', provider: 'DeepSeek' },
  { id: 'alibaba/qwen-3-coder', label: 'Qwen 3 Coder', provider: 'Alibaba' },
  { id: 'alibaba/qwen-3-max', label: 'Qwen 3 Max', provider: 'Alibaba' },
]

export const DEFAULT_CHAT_MODEL = 'anthropic/claude-sonnet-4-5'
