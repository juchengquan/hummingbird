import { describe, expect, test } from "bun:test"

import { routeModel } from "./router"

const PAIR = { strong: "anthropic/claude-sonnet-4.6", weak: "anthropic/claude-haiku-4.5" }

const base = { text: "", hasAttachments: false, messageCount: 1 }

describe("routeModel", () => {
  test("trivial short prompt → weak", () => {
    const d = routeModel({ ...base, text: "fix this typo: teh" }, PAIR)
    expect(d.tier).toBe("weak")
    expect(d.modelId).toBe(PAIR.weak)
  })

  test("attachments → strong", () => {
    const d = routeModel({ ...base, text: "summarize", hasAttachments: true }, PAIR)
    expect(d.tier).toBe("strong")
    expect(d.reason).toBe("attachments")
  })

  test("long thread → strong", () => {
    const d = routeModel({ ...base, text: "ok", messageCount: 20 }, PAIR)
    expect(d.tier).toBe("strong")
    expect(d.reason).toBe("long-thread")
  })

  test("long prompt → strong", () => {
    const d = routeModel({ ...base, text: "x".repeat(700) }, PAIR)
    expect(d.tier).toBe("strong")
    expect(d.reason).toBe("long-prompt")
  })

  test("code in the prompt → strong", () => {
    const d = routeModel(
      { ...base, text: "why does this fail?\n```js\nconst x = 1\n```" },
      PAIR
    )
    expect(d.tier).toBe("strong")
    expect(d.reason).toBe("code")
  })

  test("complexity keywords → strong", () => {
    for (const t of [
      "design a schema for this",
      "help me debug the loop",
      "analyze the trade-offs",
      "refactor this module",
    ]) {
      expect(routeModel({ ...base, text: t }, PAIR).tier).toBe("strong")
    }
  })

  test("everyday questions stay weak", () => {
    for (const t of [
      "what's the capital of France?",
      "rephrase this sentence please",
      "translate hello to spanish",
    ]) {
      expect(routeModel({ ...base, text: t }, PAIR).tier).toBe("weak")
    }
  })

  test("resolves to the configured pair ids", () => {
    expect(routeModel({ ...base, text: "hi" }, PAIR).modelId).toBe(PAIR.weak)
    expect(
      routeModel({ ...base, text: "design this", hasAttachments: true }, PAIR)
        .modelId
    ).toBe(PAIR.strong)
  })
})
