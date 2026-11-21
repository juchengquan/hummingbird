import "client-only"

/**
 * What a resume run's message held before the resume started — its
 * **base** — so a reset of that run (a rejoin after a reload always
 * resets once caught up) restores the paused run's output instead of
 * wiping it. Live, the runner keeps the base in memory
 * (`messageBaseOf`); for a reload it saves the base's *sizes* here, per
 * run, and cuts the persisted message back to them (`baseFromCounts`):
 * a resume run only appends (text, reasoning, parts) to the message.
 *
 * localStorage key `humm.runBases`, `{ [runId]: counts + updatedAt }`;
 * entries older than a day are dropped, like the active-run pointers.
 */

import type { MessageBase } from "@/client/chat/turn-writer"
import type { Message } from "@/shared/types"

import { MAX_AGE_MS } from "./active-run"
import type { TokenStorage } from "./run-tokens"

const STORAGE_KEY = "humm.runBases"

export interface RunBaseCounts {
  content: number
  reasoning: number
  toolCalls: number
  generatedImages: number
  generatedFiles: number
  codeResults: number
  uiParts: number
  mcpApps: number
}

const COUNT_KEYS: readonly (keyof RunBaseCounts)[] = [
  "content",
  "reasoning",
  "toolCalls",
  "generatedImages",
  "generatedFiles",
  "codeResults",
  "uiParts",
  "mcpApps",
]

export function countsOf(base: MessageBase): RunBaseCounts {
  return {
    content: base.content.length,
    reasoning: base.reasoning?.length ?? 0,
    toolCalls: base.toolCalls?.length ?? 0,
    generatedImages: base.generatedImages?.length ?? 0,
    generatedFiles: base.generatedFiles?.length ?? 0,
    codeResults: base.codeResults?.length ?? 0,
    uiParts: base.uiParts?.length ?? 0,
    mcpApps: base.mcpApps?.length ?? 0,
  }
}

function cut<T>(items: readonly T[] | undefined, n: number): T[] | undefined {
  if (!items || n <= 0) return undefined
  return items.slice(0, n)
}

/** The base of `message` given its sizes: every field cut back to them. Pure. */
export function baseFromCounts(message: Message, counts: RunBaseCounts): MessageBase {
  return {
    content: message.content.slice(0, counts.content),
    reasoning: counts.reasoning > 0 ? message.reasoning?.slice(0, counts.reasoning) : undefined,
    toolCalls: cut(message.toolCalls, counts.toolCalls),
    generatedImages: cut(message.generatedImages, counts.generatedImages),
    generatedFiles: cut(message.generatedFiles, counts.generatedFiles),
    codeResults: cut(message.codeResults, counts.codeResults),
    uiParts: cut(message.uiParts, counts.uiParts),
    mcpApps: cut(message.mcpApps, counts.mcpApps),
    routedModel: message.routedModel,
  }
}

type Stored = RunBaseCounts & { updatedAt: number }

function isStored(value: unknown): value is Stored {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.updatedAt === "number" &&
    COUNT_KEYS.every((k) => typeof v[k] === "number" && Number.isInteger(v[k]) && (v[k] as number) >= 0)
  )
}

function defaultStorage(): TokenStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function read(storage: TokenStorage | null, now: number): Record<string, Stored> {
  if (!storage) return {}
  let json: unknown
  try {
    json = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}")
  } catch {
    return {}
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return {}
  const out: Record<string, Stored> = {}
  for (const [runId, value] of Object.entries(json)) {
    if (isStored(value) && now - value.updatedAt <= MAX_AGE_MS) out[runId] = value
  }
  return out
}

function write(storage: TokenStorage | null, map: Record<string, Stored>): void {
  if (!storage) return
  try {
    if (Object.keys(map).length === 0) storage.removeItem(STORAGE_KEY)
    else storage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Private mode / quota — a reload mid-resume then rebuilds the
    // message from the resume run alone.
  }
}

export function saveRunBase(
  runId: string,
  counts: RunBaseCounts,
  storage: TokenStorage | null = defaultStorage(),
  now: number = Date.now(),
): void {
  const map = read(storage, now)
  map[runId] = { ...counts, updatedAt: now }
  write(storage, map)
}

export function loadRunBase(
  runId: string,
  storage: TokenStorage | null = defaultStorage(),
  now: number = Date.now(),
): RunBaseCounts | null {
  const stored = read(storage, now)[runId]
  if (!stored) return null
  const { updatedAt: _updatedAt, ...counts } = stored
  void _updatedAt
  return counts
}

export function clearRunBase(
  runId: string,
  storage: TokenStorage | null = defaultStorage(),
  now: number = Date.now(),
): void {
  const map = read(storage, now)
  if (!(runId in map)) return
  delete map[runId]
  write(storage, map)
}
