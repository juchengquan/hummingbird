/**
 * Ids for chat on runs (`lib/client/runs/`). The client mints `runId`
 * (AG-UI rule; `openapi.yaml` `startRun`) and both `runId` and `threadId`
 * must be canonical UUIDs (`UuidString`).
 *
 * Pure and isomorphic.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function format(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * A fresh UUIDv4 for a run. `crypto.getRandomValues` exists in insecure
 * browser contexts too (unlike `crypto.randomUUID`, which `@/shared/uuid`
 * falls back from to a non-UUID string) — and a run id must be a real,
 * unguessable UUID: a repeated id is an idempotent retry of that run.
 */
export function mintRunId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return format(hex(bytes))
}

/**
 * The run thread for a conversation (Q27: the thread is the conversation).
 * A conversation id is already a UUID except one minted by `@/shared/uuid`'s
 * insecure-context fallback; those get a stable UUID-shaped id derived from
 * it (a 128-bit FNV-1a hash, version nibble 8), so every run of the
 * conversation — a resume included — lands on the same thread. Such a
 * conversation can never sync (its id isn't a UUID), so its runs are
 * interactive only, which is all chat needs.
 */
export function threadIdFor(conversationId: string): string {
  if (isUuid(conversationId)) return conversationId.toLowerCase()
  // Four independent 32-bit FNV-1a lanes, each seeded differently.
  const lanes = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]
  for (let i = 0; i < conversationId.length; i++) {
    const c = conversationId.charCodeAt(i)
    for (let l = 0; l < 4; l++) {
      lanes[l] = Math.imul(lanes[l] ^ (c + l), 0x01000193) >>> 0
    }
  }
  const bytes = new Uint8Array(16)
  lanes.forEach((v, l) => {
    bytes[l * 4] = v >>> 24
    bytes[l * 4 + 1] = (v >>> 16) & 0xff
    bytes[l * 4 + 2] = (v >>> 8) & 0xff
    bytes[l * 4 + 3] = v & 0xff
  })
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return format(hex(bytes))
}
