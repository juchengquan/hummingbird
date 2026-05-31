/**
 * Summarisation helpers — port of agent-py's `summarise.py`.
 *
 * Four modes (`file` / `conversation` / `compress` /
 * `project-breakdown`) via discriminated union on `mode`. Three of
 * the four parse JSON from the model output; `compress` returns
 * plain markdown. Same prompt strings as agent-py, same JSON-fence
 * stripper, same error buckets (`provider` / `invalid_json`).
 *
 * Non-Anthropic `model` ids (e.g. the TS chat default
 * `google/gemini-2.5-flash`) fall back to a cheap Anthropic default
 * — agent-ts only talks to Anthropic, same as agent-py.
 */

import { anthropic, createAnthropic } from "@ai-sdk/anthropic"
import type { LanguageModel } from "ai"
import { generateText } from "ai"

import { getEnv } from "./env"

export const DEFAULT_SUMMARY_MODEL = "claude-3-5-haiku-20241022"

export type SummariseResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; code: "provider" | "invalid_json"; message: string }

export function isAnthropicModelId(model: string): boolean {
  return model.toLowerCase().startsWith("claude")
}

export function resolveModel(requested: string | null | undefined): string {
  return requested && isAnthropicModelId(requested) ? requested : DEFAULT_SUMMARY_MODEL
}

function buildModel(modelId: string): LanguageModel | null {
  const env = getEnv()
  if (!env.ANTHROPIC_API_KEY) return null
  if (env.ANTHROPIC_BASE_URL) {
    const custom = createAnthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      baseURL: env.ANTHROPIC_BASE_URL,
    })
    return custom(modelId)
  }
  return anthropic(modelId)
}

const FENCE_HEAD_RE = /^```(?:json)?\s*\n?/i
const FENCE_TAIL_RE = /\n?```\s*$/

export function stripJsonFences(text: string): string {
  let out = text.trim()
  out = out.replace(FENCE_HEAD_RE, "")
  out = out.replace(FENCE_TAIL_RE, "")
  return out.trim()
}

// --- prompt builders ----------------------------------------------------

function buildFilePrompt(name: string | undefined, text: string): string {
  const title = name ? ` titled "${name}"` : ""
  return (
    `Summarize the following document${title} in 2-3 plain-text sentences. ` +
    "Then list 3-5 short topic phrases (noun phrases, lowercase, no punctuation).\n\n" +
    "Reply with strict JSON only, no prose:\n" +
    '{"summary": "...", "keyTopics": ["topic one", "topic two"]}\n\n' +
    `Document:\n"""\n${text}\n"""`
  )
}

interface SummariseMessage {
  role: "user" | "assistant"
  content: string
}

function formatTranscript(msgs: SummariseMessage[]): string {
  return msgs.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n")
}

function buildConversationPrompt(msgs: SummariseMessage[]): string {
  return (
    "Summarize this conversation. Include:\n" +
    "- A one-paragraph overview\n" +
    "- 3-6 key points\n" +
    "- Decisions or action items (or [] if none)\n\n" +
    "Reply with strict JSON only, no prose:\n" +
    '{"summary": "...", "keyPoints": ["..."], "decisions": ["..."]}\n\n' +
    `Conversation:\n"""\n${formatTranscript(msgs)}\n"""`
  )
}

function buildCompressPrompt(msgs: SummariseMessage[]): string {
  return (
    "Compress the following conversation between USER and ASSISTANT into a tight " +
    "markdown recap (4-10 bullets, ~300 tokens) that PRESERVES enough information " +
    "for the assistant to continue the conversation seamlessly from this point.\n\n" +
    "Required:\n" +
    "- Keep specific names, facts, numbers, file references, URLs.\n" +
    "- Keep any explicit decisions the user made.\n" +
    "- Keep any open questions or pending follow-ups.\n" +
    "- Drop pleasantries and rhetorical filler.\n\n" +
    "Output plain markdown bullets only. No headings, no preamble, no JSON. " +
    'Start the response with "- ".\n\n' +
    `Conversation:\n"""\n${formatTranscript(msgs)}\n"""`
  )
}

function buildProjectBreakdownPrompt(
  goal: string,
  existing: string[] | undefined,
): string {
  const existingBlock =
    existing && existing.length > 0
      ? `\n\nThe board already has these tasks — do NOT repeat them:\n${existing
          .map((t) => `- ${t}`)
          .join("\n")}`
      : ""
  return (
    "Break the following project goal into 5-8 concrete, actionable task titles. " +
    'Each title is a short imperative phrase (e.g. "Draft the API schema", ' +
    '"Set up CI"), not a sentence. ' +
    `Order them roughly by sequence.${existingBlock}\n\n` +
    "Reply with strict JSON only, no prose:\n" +
    '{"titles": ["task one", "task two", "..."]}\n\n' +
    `Goal:\n"""\n${goal}\n"""`
  )
}

// --- public surface ----------------------------------------------------

export async function summariseFile(
  modelId: string,
  name: string | undefined,
  text: string,
): Promise<SummariseResult> {
  return runJson(modelId, buildFilePrompt(name, text), 600)
}

export async function summariseConversation(
  modelId: string,
  msgs: SummariseMessage[],
): Promise<SummariseResult> {
  return runJson(modelId, buildConversationPrompt(msgs), 600)
}

export async function summariseProjectBreakdown(
  modelId: string,
  goal: string,
  existing: string[] | undefined,
): Promise<SummariseResult> {
  return runJson(modelId, buildProjectBreakdownPrompt(goal, existing), 600)
}

export async function summariseCompress(
  modelId: string,
  msgs: SummariseMessage[],
): Promise<SummariseResult> {
  const model = buildModel(modelId)
  if (model === null) {
    return { ok: false, code: "provider", message: "ANTHROPIC_API_KEY is not configured." }
  }
  let text: string
  try {
    const out = await generateText({
      model,
      prompt: buildCompressPrompt(msgs),
      maxOutputTokens: 800,
      temperature: 0.3,
    })
    text = out.text
  } catch (err) {
    return {
      ok: false,
      code: "provider",
      message: err instanceof Error ? err.message : String(err),
    }
  }
  const recap = text.trim()
  if (!recap) {
    return { ok: false, code: "provider", message: "Summariser returned empty output." }
  }
  return { ok: true, payload: { recap } }
}

async function runJson(
  modelId: string,
  prompt: string,
  maxOutputTokens: number,
): Promise<SummariseResult> {
  const model = buildModel(modelId)
  if (model === null) {
    return { ok: false, code: "provider", message: "ANTHROPIC_API_KEY is not configured." }
  }
  let text: string
  try {
    const out = await generateText({
      model,
      prompt,
      maxOutputTokens,
      temperature: 0.3,
    })
    text = out.text
  } catch (err) {
    return {
      ok: false,
      code: "provider",
      message: err instanceof Error ? err.message : String(err),
    }
  }
  if (!text.trim()) {
    return { ok: false, code: "provider", message: "Summariser returned empty output." }
  }
  const cleaned = stripJsonFences(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return {
      ok: false,
      code: "invalid_json",
      message: "Summarisation model did not return valid JSON.",
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "invalid_json",
      message: "Summarisation model returned non-object JSON.",
    }
  }
  return { ok: true, payload: parsed as Record<string, unknown> }
}
