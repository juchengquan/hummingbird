import "server-only"

/**
 * Low-level Minimax image-generation client.
 *
 * Wraps the documented endpoint:
 *
 *   POST https://api.minimax.io/v1/image_generation
 *   Authorization: Bearer <MINIMAX_CN_API_KEY>
 *   Content-Type: application/json
 *
 *   body = {
 *     model: "image-01",
 *     prompt: "...",
 *     aspect_ratio: "16:9",
 *     response_format: "url",
 *     n: 1..4,
 *     prompt_optimizer: true,
 *     // I2I mode (when referenceImageUrl is provided):
 *     subject_reference: [{ type: "character", image_file: "https://..." }],
 *   }
 *
 * The auth key is shared with the Minimax-CN chat bypass — Minimax
 * issues one key per account that covers both APIs. Endpoint URL is
 * fixed (T2I and I2I share the same path; the request shape
 * distinguishes the two modes).
 *
 * Failure handling is structured: every error returns
 * `{ ok: false, code, message }` with one of a small set of stable
 * codes the caller can map to user-facing copy. Network errors,
 * timeouts, HTTP status codes, and Minimax's own `base_resp.status_code`
 * convention all funnel through `mapMinimaxStatusCode` so the surface
 * stays small.
 *
 * Per-call timeout: 30 seconds. Image generation is slower than text;
 * 30s is enough headroom for a typical T2I roundtrip without leaving
 * the chat turn frozen if Minimax stalls.
 */

const ENDPOINT = "https://api.minimax.io/v1/image_generation"
const MODEL = "image-01"
const CALL_TIMEOUT_MS = 30_000

export interface MinimaxImageRequest {
  prompt: string
  /** Already validated against the enum in `image-gen-config.ts`. */
  aspectRatio: string
  /** Already clamped to 1..MAX_IMAGES_PER_CALL by the caller. */
  count: number
  /** When provided, switches to I2I mode via `subject_reference`.
   *  Caller must have run `validateOutboundUrl` against this first;
   *  otherwise the model can exfiltrate internal URLs via Minimax's
   *  egress. */
  referenceImageUrl?: string
  /** Upstream abort signal — typically the chat route's `req.signal`. */
  signal?: AbortSignal
}

export type MinimaxImageErrorCode =
  | "auth"
  | "rate_limit"
  | "content_policy"
  | "validation"
  | "upstream"
  | "network"

export type MinimaxImageResult =
  | {
      ok: true
      images: Array<{ url: string; width: number; height: number; format: string }>
    }
  | { ok: false; code: MinimaxImageErrorCode; message: string }

/**
 * Response shape — Minimax convention is to wrap everything in a
 * `base_resp` envelope, with `status_code === 0` meaning success.
 * The actual image URLs land under `data.image_urls` in the docs
 * we have; `extractImageUrls` accepts a couple of alternate shapes
 * defensively because Minimax has shipped variants over time.
 */
interface MinimaxImageResponse {
  data?: {
    image_urls?: string[]
    images?: Array<{ url?: string; image_url?: string }>
  }
  metadata?: {
    success_count?: number
    failed_count?: number
  }
  base_resp?: {
    status_code?: number
    status_msg?: string
  }
}

export async function minimaxGenerateImage(
  req: MinimaxImageRequest
): Promise<MinimaxImageResult> {
  const apiKey = process.env.MINIMAX_CN_API_KEY?.trim()
  if (!apiKey) {
    return {
      ok: false,
      code: "auth",
      message: "MINIMAX_CN_API_KEY is not set",
    }
  }

  const body: Record<string, unknown> = {
    model: MODEL,
    prompt: req.prompt,
    aspect_ratio: req.aspectRatio,
    response_format: "url",
    n: req.count,
    prompt_optimizer: true,
  }
  if (req.referenceImageUrl) {
    body.subject_reference = [
      { type: "character", image_file: req.referenceImageUrl },
    ]
  }

  const { signal, cancel } = buildSignal(req.signal)
  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        code: "network",
        message: `Image generation timed out after ${CALL_TIMEOUT_MS}ms`,
      }
    }
    return {
      ok: false,
      code: "network",
      message: err instanceof Error ? err.message : String(err),
    }
  } finally {
    cancel()
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      code: "auth",
      message: "Minimax rejected the API key",
    }
  }
  if (res.status === 429) {
    return {
      ok: false,
      code: "rate_limit",
      message: "Minimax rate-limited the request — back off and retry",
    }
  }
  if (!res.ok) {
    return {
      ok: false,
      code: "upstream",
      message: `Minimax returned HTTP ${res.status}`,
    }
  }

  let json: MinimaxImageResponse
  try {
    json = (await res.json()) as MinimaxImageResponse
  } catch (err) {
    return {
      ok: false,
      code: "upstream",
      message: `Minimax response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const statusCode = json.base_resp?.status_code
  if (statusCode !== undefined && statusCode !== 0) {
    const code = mapMinimaxStatusCode(statusCode)
    return {
      ok: false,
      code,
      message:
        json.base_resp?.status_msg ??
        `Minimax error ${statusCode} (no message)`,
    }
  }

  const urls = extractImageUrls(json)
  if (urls.length === 0) {
    // Unexpected shape — log so the parser can grow to handle it
    // without us having to repro by hand.
    console.warn(
      "[minimax-image] success but no image URLs in response. Top-level keys:",
      Object.keys(json)
    )
    return {
      ok: false,
      code: "upstream",
      message: "Minimax returned no image URLs",
    }
  }

  return {
    ok: true,
    images: urls.map((url) => ({
      url,
      // Width / height: Minimax doesn't always include explicit
      // dimensions in the response; the UI infers from the loaded
      // image. Zero is a sentinel ("unknown — let the browser tell us").
      width: 0,
      height: 0,
      format: "png",
    })),
  }
}

/**
 * Combine the per-call timeout with the upstream caller signal.
 * Mirrors `buildProviderSignal` in `web-search.ts` — both fire
 * `AbortSignal.any`-driven cancellation.
 */
function buildSignal(upstream: AbortSignal | undefined): {
  signal: AbortSignal
  cancel: () => void
} {
  const timer = new AbortController()
  const t = setTimeout(() => timer.abort(), CALL_TIMEOUT_MS)
  const signal = upstream
    ? AbortSignal.any([timer.signal, upstream])
    : timer.signal
  return { signal, cancel: () => clearTimeout(t) }
}

/**
 * Minimax's documented status codes for the image API. The list
 * starts small; expand whenever production logs surface an unmapped
 * code. Unknown codes fall through to `"upstream"` which surfaces
 * the original status_msg to the model.
 */
export function mapMinimaxStatusCode(code: number): MinimaxImageErrorCode {
  // Auth / quota
  if (code === 1004 || code === 1008) return "auth"
  if (code === 1013 || code === 1039) return "rate_limit"
  // Content / safety
  if (code === 2013 || code === 2049) return "content_policy"
  // Input validation
  if (code === 1002 || code === 2032) return "validation"
  return "upstream"
}

/**
 * Pull image URLs out of the Minimax response. The documented shape
 * is `data.image_urls: string[]`; we also accept `data.images[].url`
 * and `data.images[].image_url` because Minimax has shipped variants
 * over time. Returns `[]` when nothing recognisable is present —
 * the caller treats that as an upstream error and logs the response
 * keys so we can extend this list.
 */
export function extractImageUrls(json: MinimaxImageResponse): string[] {
  const data = json.data
  if (!data) return []
  if (Array.isArray(data.image_urls)) {
    return data.image_urls.filter((u): u is string => typeof u === "string")
  }
  if (Array.isArray(data.images)) {
    return data.images
      .map((img) => img?.url ?? img?.image_url)
      .filter((u): u is string => typeof u === "string")
  }
  return []
}

/** Exported for tests only. */
export const __test = {
  extractImageUrls,
  mapMinimaxStatusCode,
  ENDPOINT,
  CALL_TIMEOUT_MS,
}
