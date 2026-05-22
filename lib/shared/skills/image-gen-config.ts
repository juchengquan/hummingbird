/**
 * Per-skill config for `imageGen` (Minimax image generation).
 *
 * Shape:
 *   {
 *     maxCalls?: number,                    // per-turn cap
 *     aspectRatio?: ImageGenAspectRatio,    // default for generations
 *   }
 *
 * `maxCalls` is enforced at the tool level: one `generateImage`
 * invocation = one cap unit. (Each invocation can itself generate up
 * to N images via the tool's `count` input — that's bounded by
 * `MAX_IMAGES_PER_CALL` below, not by maxCalls.)
 *
 * Resolution order — for each scalar field — is conversation override
 * → workspace default → built-in default. Same cascade as web-search /
 * web-fetch.
 */

import { makeBoundedIntField } from "./bounded-int"

// --- Maxcalls ---------------------------------------------------------------

const IMAGE_GEN_MAX = makeBoundedIntField({ default: 2, min: 1, max: 5 })
/** Built-in default when neither workspace nor conversation specifies. */
export const DEFAULT_MAX_IMAGE_GENERATIONS = IMAGE_GEN_MAX.DEFAULT
/** Inclusive bounds the UI enforces on the stepper. */
export const MIN_MAX_IMAGE_GENERATIONS = IMAGE_GEN_MAX.MIN
export const MAX_MAX_IMAGE_GENERATIONS = IMAGE_GEN_MAX.MAX
export const clampMaxImageGenerations = IMAGE_GEN_MAX.clamp

/** Max images the model can request in a single `generateImage` call.
 *  Matches Minimax's per-call upper bound; raise if their docs ever
 *  bump it. Independent from the per-turn cap above. */
export const MAX_IMAGES_PER_CALL = 4

// --- Aspect ratio ----------------------------------------------------------

/** Aspect ratios surfaced to the model and the UI. Subset chosen
 *  from what Minimax's `aspect_ratio` parameter accepts. */
export type ImageGenAspectRatio =
  | "1:1"
  | "16:9"
  | "9:16"
  | "4:3"
  | "3:4"
  | "2:3"
  | "3:2"

export const IMAGE_GEN_ASPECT_RATIOS: ReadonlyArray<ImageGenAspectRatio> = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "2:3",
  "3:2",
]

export const DEFAULT_IMAGE_GEN_ASPECT_RATIO: ImageGenAspectRatio = "1:1"

/** User-facing labels for the aspect-ratio select. */
export const IMAGE_GEN_ASPECT_RATIO_LABELS: Record<ImageGenAspectRatio, string> = {
  "1:1": "Square (1:1)",
  "16:9": "Landscape (16:9)",
  "9:16": "Portrait (9:16)",
  "4:3": "Standard (4:3)",
  "3:4": "Portrait (3:4)",
  "2:3": "Portrait (2:3)",
  "3:2": "Landscape (3:2)",
}

function clampAspectRatio(value: string | undefined): ImageGenAspectRatio {
  if (
    value !== undefined &&
    (IMAGE_GEN_ASPECT_RATIOS as readonly string[]).includes(value)
  ) {
    return value as ImageGenAspectRatio
  }
  return DEFAULT_IMAGE_GEN_ASPECT_RATIO
}

// --- Top-level config + resolver -------------------------------------------

export interface ImageGenConfig {
  maxCalls?: number
  aspectRatio?: ImageGenAspectRatio
}

/** Fully-resolved shape — every field concrete so server code doesn't
 *  have to keep guarding for `undefined`. */
export interface ResolvedImageGenConfig {
  maxCalls: number
  aspectRatio: ImageGenAspectRatio
}

export function resolveImageGenConfig(
  workspaceCfg: ImageGenConfig | undefined,
  conversationCfg: ImageGenConfig | undefined
): ResolvedImageGenConfig {
  const maxCalls = clampMaxImageGenerations(
    conversationCfg?.maxCalls ??
      workspaceCfg?.maxCalls ??
      DEFAULT_MAX_IMAGE_GENERATIONS
  )
  const aspectRatio = clampAspectRatio(
    conversationCfg?.aspectRatio ??
      workspaceCfg?.aspectRatio ??
      DEFAULT_IMAGE_GEN_ASPECT_RATIO
  )
  return { maxCalls, aspectRatio }
}
