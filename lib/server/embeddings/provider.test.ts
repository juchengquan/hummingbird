import { describe, expect, test } from "bun:test"

import {
  EMBEDDING_DIM,
  EmbeddingUnavailableError,
  embedTexts,
  isEmbeddingConfigured,
} from "./provider"

describe("embedding provider config gate", () => {
  test("EMBEDDING_DIM matches the migration column (768)", () => {
    expect(EMBEDDING_DIM).toBe(768)
  })

  test("embedTexts([]) short-circuits to [] regardless of config", async () => {
    expect(await embedTexts([])).toEqual([])
  })

  test("unconfigured: gate is false and embedTexts rejects", async () => {
    // Skip when a local dev env actually has an embedder wired — the
    // gate is true there and the real call would be made.
    if (isEmbeddingConfigured()) return
    expect(isEmbeddingConfigured()).toBe(false)
    await expect(embedTexts(["hello"])).rejects.toBeInstanceOf(
      EmbeddingUnavailableError
    )
  })
})
