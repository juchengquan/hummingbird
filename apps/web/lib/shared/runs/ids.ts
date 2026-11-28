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

// --- Ids derived from a task (Q70, Q77) ----------------------------------------

/** The UUIDv5 namespace of the ids a task's result is written under. Fixed
 *  forever: changing it would deliver every finished task a second time. */
export const TASK_RESULT_NAMESPACE = "79bb547a-2a52-4e57-b1d8-78c6e8a369c4"

/** The ids a finished task's result is written under, in its conversation. */
export interface TaskResultIds {
  /** The assistant message holding the task's answer. */
  messageId: string
  /** A research task's report, opened as an editor document. */
  documentId: string
  /** The artifact the result is saved as (the research report's, today). */
  artifactId: string
}

/**
 * The ids of a task's result (Q70, Q77), derived from the signed-in user
 * and the task's root run (`Run.rootRunId`): every browser and tab that
 * delivers the same task writes the same rows, so a second write is a
 * no-op (an upsert of the same id) and sync never sees a duplicate.
 *
 * UUIDv5 (RFC 9562 § 5.5, SHA-1) in `TASK_RESULT_NAMESPACE` of
 * `task-result:<kind>:<userId>:<rootRunId>`, both ids lower-cased, so
 * Python's `uuid.uuid5` gives the same ids. Pure and synchronous.
 */
export function resultIdsFor(userId: string, rootRunId: string): TaskResultIds {
  const key = `${userId.toLowerCase()}:${rootRunId.toLowerCase()}`
  return {
    messageId: uuidV5(TASK_RESULT_NAMESPACE, `task-result:message:${key}`),
    documentId: uuidV5(TASK_RESULT_NAMESPACE, `task-result:document:${key}`),
    artifactId: uuidV5(TASK_RESULT_NAMESPACE, `task-result:artifact:${key}`),
  }
}

/** The `file` artifact of one file a task's code wrote (Q94): derived like
 *  `resultIdsFor`, from the task and the file's id (`<toolCallId>-file-<i>`). */
export function taskFileArtifactIdFor(userId: string, rootRunId: string, fileId: string): string {
  return uuidV5(
    TASK_RESULT_NAMESPACE,
    `task-result:file:${userId.toLowerCase()}:${rootRunId.toLowerCase()}:${fileId}`,
  )
}

/** A name-based UUID, version 5 (SHA-1): `uuid.uuid5(namespace, name)`. */
export function uuidV5(namespace: string, name: string): string {
  if (!isUuid(namespace)) throw new Error(`not a UUID: ${namespace}`)
  const ns = namespace.replace(/-/g, "")
  const nameBytes = new TextEncoder().encode(name)
  const input = new Uint8Array(16 + nameBytes.length)
  for (let i = 0; i < 16; i++) input[i] = parseInt(ns.slice(i * 2, i * 2 + 2), 16)
  input.set(nameBytes, 16)
  const bytes = sha1(input).slice(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return format(hex(bytes))
}

/** SHA-1 (FIPS 180-4) of `data`: 20 bytes. Only for name-based UUIDs. */
function sha1(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) * 64)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32))
  view.setUint32(padded.length - 4, bitLength >>> 0)
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let block = 0; block < padded.length; block += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(block + t * 4)
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]
      w[t] = (x << 1) | (x >>> 31)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let t = 0; t < 80; t++) {
      let f: number
      let k: number
      if (t < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (t < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0
      e = d
      d = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = temp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  const out = new Uint8Array(20)
  const outView = new DataView(out.buffer)
  ;[h0, h1, h2, h3, h4].forEach((h, i) => outView.setUint32(i * 4, h))
  return out
}
