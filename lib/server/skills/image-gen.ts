import "server-only"

/**
 * Image-generation skill — Minimax T2I + I2I.
 *
 * Exposes a single `generateImage({ prompt, ... })` tool to the model.
 * The tool always calls Minimax's documented `/v1/image_generation`
 * endpoint (T2I); when the model includes a `referenceImageUrl` the
 * tool switches to I2I mode by attaching `subject_reference`.
 *
 * The actual HTTP call lives in `minimax-image-client.ts` — this file
 * owns the AI-SDK tool shape, the per-turn budget, the per-IP rate
 * limit, the SSRF gate on `referenceImageUrl`, and the
 * `ServerSkill` registry entry the chat route loops over.
 *
 * Persistence + UI happen in follow-up PRs (B + C). For now the tool
 * returns the temporary Minimax URL(s) inline — they're typically
 * valid for a few hours, so the model can reference them in this
 * conversation and downstream PRs will swap in Supabase-Storage
 * URLs without changing the tool's interface.
 */

import { tool } from "ai"
import { z } from "zod"

import { validateOutboundUrl } from "@/server/url/validate"
import {
  clampMaxImageGenerations,
  IMAGE_GEN_ASPECT_RATIOS,
  MAX_IMAGES_PER_CALL,
  resolveImageGenConfig,
  type ResolvedImageGenConfig,
} from "@/shared/skills/image-gen-config"
import type { ServerSkill } from "@/server/skills/registry"

import { minimaxGenerateImage } from "@/server/skills/minimax-image-client"

export interface ImageGenInvocation {
  prompt: string
  mode: "t2i" | "i2i"
  /** Number of images Minimax actually returned. Zero on failure. */
  imageCount: number
  ok: boolean
}

export type ImageGenLog = ImageGenInvocation[]

interface BuildOpts {
  config: ResolvedImageGenConfig
  /** Upstream abort signal — typically the chat route's `req.signal`. */
  signal?: AbortSignal
  /** Per-IP cross-turn budget. The image-gen route has its own
   *  bucket (separate from `chatWebToolLimit`) because image gen
   *  costs an order of magnitude more per call. */
  consumeBudget?: () => { allowed: boolean; retryAfterSec: number }
}

interface ImageGenSuccess {
  ok: true
  mode: "t2i" | "i2i"
  prompt: string
  images: Array<{
    id: string
    url: string
    width: number
    height: number
    format: string
  }>
}

interface ImageGenFailure {
  ok: false
  error: string
  /** Structured code so the model can decide whether to retry, switch
   *  prompt, or just give up. */
  code:
    | "rate_limit"
    | "content_policy"
    | "validation"
    | "auth"
    | "network"
    | "upstream"
    | "budget"
}

export type ImageGenResult = ImageGenSuccess | ImageGenFailure

/** Returns true when the server has what it needs to call Minimax. */
export function isImageGenConfigured(): boolean {
  return !!process.env.MINIMAX_CN_API_KEY
}

export function buildImageGenTool(log: ImageGenLog, opts: BuildOpts) {
  const cap = clampMaxImageGenerations(opts.config.maxCalls)
  return tool({
    description:
      "Generate one or more images via Minimax (text-to-image, or " +
      "image-to-image when you provide `referenceImageUrl`). Returns " +
      "image URLs the user will see inline. " +
      `HARD LIMIT: ${cap} call${cap === 1 ? "" : "s"} per turn. ` +
      `Each call can render up to ${MAX_IMAGES_PER_CALL} images. ` +
      "Use only when the user explicitly asks for an image; do not " +
      "preemptively generate to illustrate text answers.",
    inputSchema: z.object({
      prompt: z
        .string()
        .min(1)
        .max(2000)
        .describe(
          "A vivid, specific description of the image to generate. " +
            "More detail produces better results — include style, " +
            "composition, lighting, mood."
        ),
      aspectRatio: z
        .enum(IMAGE_GEN_ASPECT_RATIOS as readonly [string, ...string[]])
        .optional()
        .describe(
          `Aspect ratio. Defaults to the user's configured default ` +
            `(currently ${opts.config.aspectRatio}).`
        ),
      count: z
        .number()
        .int()
        .min(1)
        .max(MAX_IMAGES_PER_CALL)
        .optional()
        .describe(
          `How many images to generate (1..${MAX_IMAGES_PER_CALL}). ` +
            "Defaults to 1. Higher counts cost proportionally more."
        ),
      referenceImageUrl: z
        .string()
        .url()
        .max(2000)
        .optional()
        .describe(
          "Optional public https URL of a reference image. When " +
            "provided, switches to image-to-image mode (Minimax " +
            "treats the referenced image as a subject to render in " +
            "the new scene). Must be a public web URL — internal/" +
            "private addresses are rejected."
        ),
    }),
    execute: async ({
      prompt,
      aspectRatio,
      count,
      referenceImageUrl,
    }): Promise<ImageGenResult> => {
      const mode: "t2i" | "i2i" = referenceImageUrl ? "i2i" : "t2i"

      // Per-IP cross-turn gate first. Image gen is the most expensive
      // surface; tell the model to back off if the IP is hammering.
      const budget = opts.consumeBudget?.()
      if (budget && !budget.allowed) {
        log.push({ prompt, mode, imageCount: 0, ok: false })
        return {
          ok: false,
          code: "budget",
          error:
            `Image generation rate limit exceeded for this IP. ` +
            `Retry in ${budget.retryAfterSec}s.`,
        }
      }

      // Per-turn soft cap.
      if (log.length >= cap) {
        log.push({ prompt, mode, imageCount: 0, ok: false })
        return {
          ok: false,
          code: "budget",
          error:
            `Image-generation budget exhausted (${cap} ${cap === 1 ? "call" : "calls"} per turn). ` +
            "Answer with the images already produced or ask the user to refine the request.",
        }
      }

      // SSRF gate on the reference URL — Minimax fetches it server-
      // side, so without this the model can exfiltrate
      // `http://internal/secret` via Minimax's egress. Same guard
      // the URL-bookmark route uses on user input.
      if (referenceImageUrl) {
        const validation = await validateOutboundUrl(referenceImageUrl)
        if (!validation.ok) {
          log.push({ prompt, mode, imageCount: 0, ok: false })
          return {
            ok: false,
            code: "validation",
            error: `referenceImageUrl refused: ${validation.error.message}`,
          }
        }
      }

      const result = await minimaxGenerateImage({
        prompt,
        aspectRatio: aspectRatio ?? opts.config.aspectRatio,
        count: count ?? 1,
        referenceImageUrl,
        signal: opts.signal,
      })

      if (!result.ok) {
        log.push({ prompt, mode, imageCount: 0, ok: false })
        return {
          ok: false,
          code: result.code,
          error: result.message,
        }
      }

      log.push({ prompt, mode, imageCount: result.images.length, ok: true })
      return {
        ok: true,
        mode,
        prompt,
        images: result.images.map((img, i) => ({
          // Stable per-result id so the UI can key on it. URL alone
          // works too but is unwieldy in React keys.
          id: `${Date.now()}-${i}`,
          ...img,
        })),
      }
    },
  })
}

// --- ServerSkill entry -----------------------------------------------------

/**
 * Registry entry for the imageGen skill. Threads the per-request
 * `imageGenConfig` through the shared resolver, owns its per-turn
 * log internally, and either returns a Tool or null (when
 * `MINIMAX_CN_API_KEY` is missing).
 */
export const imageGenSkill: ServerSkill = {
  id: "imageGen",
  toolName: "generateImage",
  buildTool(requestEntry, ctx) {
    if (!isImageGenConfigured()) return null
    const config = resolveImageGenConfig(undefined, requestEntry?.imageGenConfig)
    const log: ImageGenLog = []
    return buildImageGenTool(log, {
      config,
      signal: ctx.signal,
      consumeBudget: ctx.consumeBudget,
    })
  },
  promptFragment(requestEntry) {
    if (!isImageGenConfigured()) {
      return (
        'The user enabled "Image generation" but the server has no ' +
        "Minimax API key configured (missing MINIMAX_CN_API_KEY). You " +
        "cannot actually generate images — say so briefly if the user " +
        "asks for one."
      )
    }
    const config = resolveImageGenConfig(undefined, requestEntry?.imageGenConfig)
    const cap = config.maxCalls
    return (
      `You can call \`generateImage({ prompt, aspectRatio?, count?, referenceImageUrl? })\` ` +
      `to render an image via Minimax. Use this only when the user explicitly asks for ` +
      `an image — do not preemptively illustrate text answers. ` +
      `Default aspect ratio is ${config.aspectRatio}; you can override per call from the ` +
      `set: ${IMAGE_GEN_ASPECT_RATIOS.join(", ")}. ` +
      `Provide \`referenceImageUrl\` (must be a public https URL) when the user wants to ` +
      `remix or extend an existing image (I2I mode). ` +
      `HARD LIMIT: ${cap} call${cap === 1 ? "" : "s"} per turn (each can produce up to ` +
      `${MAX_IMAGES_PER_CALL} images via the \`count\` parameter). ` +
      `Returned images appear inline above your message text — refer to them by ` +
      `description, not by URL.`
    )
  },
}

// Default-export only for compatibility with module-mock helpers in
// tests that pull the whole module shape. The named exports above
// are the canonical surface.
const _default = { imageGenSkill, buildImageGenTool, isImageGenConfigured }
export default _default
