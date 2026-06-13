import { describe, expect, test } from "bun:test"

import type { Message } from "@/shared/types"
import {
  contextZone,
  estimateConversationTokens,
  estimateTokens,
  estimateTokensWith,
  formatTokenCount,
  tokenizerForModelId,
} from "./tokens"

const HEURISTIC = (s: string) => Math.ceil(s.length / 4)

// Code/JSON is where the chars/4 heuristic undercounts — the whole point
// of the real-tokenizer path.
const CODE = `function add(a: number, b: number) { return a + b }
const xs = [1, 2, 3].map((n) => n * 2)`

function msg(partial: Partial<Message>): Message {
  return {
    id: "m",
    role: "assistant",
    content: "",
    timestamp: new Date(),
    ...partial,
  } as Message
}

describe("estimateTokensWith", () => {
  test("heuristic is chars/4", () => {
    expect(estimateTokensWith(CODE, "heuristic")).toBe(HEURISTIC(CODE))
  })

  test("empty string → 0 on every tokenizer", () => {
    expect(estimateTokensWith("", "heuristic")).toBe(0)
    expect(estimateTokensWith("", "tiktoken-cl100k")).toBe(0)
    expect(estimateTokensWith("", "tiktoken-o200k")).toBe(0)
  })

  test("real tokenizers count code higher than the heuristic undercount", () => {
    const heuristic = estimateTokensWith(CODE, "heuristic")
    const cl = estimateTokensWith(CODE, "tiktoken-cl100k")
    const o2 = estimateTokensWith(CODE, "tiktoken-o200k")
    expect(cl).toBeGreaterThan(heuristic)
    expect(o2).toBeGreaterThan(heuristic)
  })

  test("deterministic for a known string", () => {
    // tiktoken is deterministic; pin the value so a tokenizer swap is loud.
    expect(estimateTokensWith("hello world", "tiktoken-cl100k")).toBe(2)
  })
})

describe("tokenizerForModelId", () => {
  test("resolves the configured tokenizer per model id", () => {
    expect(tokenizerForModelId("anthropic/claude-sonnet-4.6")).toBe(
      "tiktoken-cl100k"
    )
    expect(tokenizerForModelId("openai/gpt-5.5")).toBe("tiktoken-o200k")
  })

  test("untagged model (Gemini/DeepSeek/Ollama) → heuristic", () => {
    expect(tokenizerForModelId("google/gemini-2.5-pro")).toBe("heuristic")
    expect(tokenizerForModelId("deepseek/deepseek-v4-flash")).toBe("heuristic")
  })

  test("unknown / undefined id → heuristic", () => {
    expect(tokenizerForModelId("some/unknown-model")).toBe("heuristic")
    expect(tokenizerForModelId(undefined)).toBe("heuristic")
  })
})

describe("estimateTokens", () => {
  test("picks the model's tokenizer; falls back to heuristic", () => {
    // An OpenAI model uses the real encoder → higher than chars/4 for code.
    expect(estimateTokens(CODE, "openai/gpt-5.5")).toBeGreaterThan(
      HEURISTIC(CODE)
    )
    // An untagged model + no model id both reduce to the heuristic.
    expect(estimateTokens(CODE, "google/gemini-2.5-pro")).toBe(HEURISTIC(CODE))
    expect(estimateTokens(CODE)).toBe(HEURISTIC(CODE))
  })
})

describe("estimateConversationTokens", () => {
  test("skips compressed messages, counts reasoning", () => {
    const messages = [
      msg({ content: "alpha" }),
      msg({ content: "beta", reasoning: "gamma" }),
      msg({ content: "dropped", compressed: true }),
    ]
    // Heuristic path (no model id): alpha+beta+gamma counted, dropped skipped.
    const expected =
      HEURISTIC("alpha") + HEURISTIC("beta") + HEURISTIC("gamma")
    expect(estimateConversationTokens(messages)).toBe(expected)
  })

  test("threads the model tokenizer through", () => {
    const messages = [msg({ content: CODE })]
    expect(
      estimateConversationTokens(messages, "openai/gpt-5.5")
    ).toBeGreaterThan(estimateConversationTokens(messages))
  })

  test("empty conversation → 0", () => {
    expect(estimateConversationTokens([])).toBe(0)
  })
})

describe("contextZone", () => {
  test("thresholds at 0.5 (warn) and 0.9 (danger)", () => {
    expect(contextZone(10, 100)).toBe("ok")
    expect(contextZone(50, 100)).toBe("warn")
    expect(contextZone(90, 100)).toBe("danger")
    expect(contextZone(5, 0)).toBe("ok") // guard against div-by-zero
  })
})

describe("formatTokenCount", () => {
  test("compact formatting", () => {
    expect(formatTokenCount(540)).toBe("540")
    expect(formatTokenCount(38_000)).toBe("38k")
    expect(formatTokenCount(1_200_000)).toBe("1.2M")
  })
})
