import "server-only"

import { embedMany } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

/**
 * Embedding provider for the local-RAG / hybrid-search pipeline
 * (`docs/PLAN-local-rag.md`). Mirrors the chat `model-provider` pattern:
 * an OpenAI-compatible endpoint behind an env-gated base URL. Self-host
 * first — Ollama exposes `/v1/embeddings`; a hosted OpenAI-compatible
 * embedder works the same way.
 *
 * **Env-gated + a hard no-op when unconfigured.** With no base URL set,
 * `isEmbeddingConfigured()` is false and `embedTexts` throws
 * `EmbeddingUnavailableError` — callers skip the vector path and fall
 * back to FTS. Nothing in the app changes until an operator wires this up.
 *
 * Config (first match wins for the base URL):
 *   - `EMBEDDINGS_BASE_URL` (+ `EMBEDDINGS_API_KEY`) — a dedicated embedder
 *   - else `OLLAMA_BASE_URL` (+ `OLLAMA_API_KEY`) — reuse the Ollama host
 *   - `EMBEDDINGS_MODEL` — model id (default `nomic-embed-text`, 768-dim)
 */

/** Dimension of the embedding vectors. **Must match the `vector(N)`
 *  column in the migration** (`0023_file_embeddings.sql`). `nomic-embed-text`
 *  (the default model) is 768-dim; changing the model to a different
 *  dimension requires a matching migration. */
export const EMBEDDING_DIM = 768

const BASE_URL = process.env.EMBEDDINGS_BASE_URL || process.env.OLLAMA_BASE_URL || ""
const API_KEY = process.env.EMBEDDINGS_API_KEY || process.env.OLLAMA_API_KEY || ""
const MODEL = process.env.EMBEDDINGS_MODEL || "nomic-embed-text"

/** Thrown by `embedTexts` when no embedding provider is configured. */
export class EmbeddingUnavailableError extends Error {
  constructor(message = "No embedding provider configured") {
    super(message)
    this.name = "EmbeddingUnavailableError"
  }
}

/** True when an embedding base URL is configured. Gates every vector
 *  path — callers fall back to FTS when false. */
export function isEmbeddingConfigured(): boolean {
  return BASE_URL.length > 0
}

let cachedClient: ReturnType<typeof createOpenAICompatible> | null = null
function client() {
  if (!cachedClient) {
    cachedClient = createOpenAICompatible({
      name: "embeddings",
      baseURL: BASE_URL,
      // Ollama doesn't enforce auth; supply a placeholder so the SDK
      // doesn't reject an empty key.
      apiKey: API_KEY || "not-needed",
    })
  }
  return cachedClient
}

/**
 * Embed a batch of texts. Returns one vector per input, in order. Empty
 * input short-circuits to `[]` (no provider needed). Throws
 * `EmbeddingUnavailableError` when unconfigured.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  if (!isEmbeddingConfigured()) {
    throw new EmbeddingUnavailableError(
      "Set EMBEDDINGS_BASE_URL (or OLLAMA_BASE_URL) to enable embeddings."
    )
  }
  const { embeddings } = await embedMany({
    model: client().textEmbeddingModel(MODEL),
    values: texts,
  })
  return embeddings
}

/** Embed a single text. Convenience over `embedTexts`. */
export async function embedText(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text])
  return vec ?? []
}
