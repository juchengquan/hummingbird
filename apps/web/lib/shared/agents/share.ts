/**
 * Share-by-URL primitives for custom agents / personas
 * (`PLAN-custom-agents.md` Phase 2). A persona is pure config — name,
 * prompt, model, allowed skills, allowed MCP server ids, icon. Nothing
 * else needs to travel with it. We base64url-encode the JSON blob into
 * a `?import-agent=` URL fragment; the recipient's app sees the param
 * on load and shows an Import modal.
 *
 * MCP server ids are *strings*, not foreign keys to the sharer's data
 * — if the recipient doesn't have a server with the same id the
 * importer warns and drops that entry.
 *
 * Pure: no I/O, no React. Tested in isolation.
 */

import type { Agent } from "../types"

/** Subset of the Agent shape that survives a share link — no ids, no
 *  timestamps, no workspace. The recipient's app re-derives those. */
export interface ShareableAgent {
  name: string
  slug: string
  systemPrompt: string
  modelId?: string
  allowedSkillIds: string[]
  allowedMcpServerIds: string[]
  icon?: string
}

/** Strip a stored Agent down to the shareable subset. */
export function toShareable(agent: Agent): ShareableAgent {
  return {
    name: agent.name,
    slug: agent.slug,
    systemPrompt: agent.systemPrompt,
    ...(agent.modelId ? { modelId: agent.modelId } : {}),
    allowedSkillIds: [...agent.allowedSkillIds],
    allowedMcpServerIds: [...agent.allowedMcpServerIds],
    ...(agent.icon ? { icon: agent.icon } : {}),
  }
}

/** Convert a `Uint8Array` to base64url (URL-safe, no padding). */
function toBase64Url(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Inverse of `toBase64Url`. Tolerates an extra `=` padding. */
function fromBase64Url(str: string): Uint8Array | null {
  try {
    const padded = str.replace(/-/g, "+").replace(/_/g, "/")
    const padLen = (4 - (padded.length % 4)) % 4
    const bin = atob(padded + "=".repeat(padLen))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** Encode a shareable persona into a URL-safe token. The caller
 *  prefixes it with the app's origin + `?import-agent=`. */
export function encodeAgentShareToken(shareable: ShareableAgent): string {
  const json = JSON.stringify(shareable)
  const bytes = new TextEncoder().encode(json)
  return toBase64Url(bytes)
}

/** Decode a `?import-agent=` token. Returns null on malformed input
 *  or schema mismatch — bad input is silently ignored upstream. */
export function decodeAgentShareToken(token: string): ShareableAgent | null {
  const bytes = fromBase64Url(token)
  if (!bytes) return null
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (!json || typeof json !== "object") return null
  const o = json as Partial<ShareableAgent>
  if (typeof o.name !== "string" || !o.name.trim()) return null
  if (typeof o.slug !== "string" || !o.slug.trim()) return null
  if (typeof o.systemPrompt !== "string") return null
  if (!Array.isArray(o.allowedSkillIds)) return null
  if (!Array.isArray(o.allowedMcpServerIds)) return null
  if (o.allowedSkillIds.some((s) => typeof s !== "string")) return null
  if (o.allowedMcpServerIds.some((s) => typeof s !== "string")) return null
  return {
    name: o.name,
    slug: o.slug,
    systemPrompt: o.systemPrompt,
    ...(typeof o.modelId === "string" ? { modelId: o.modelId } : {}),
    allowedSkillIds: o.allowedSkillIds,
    allowedMcpServerIds: o.allowedMcpServerIds,
    ...(typeof o.icon === "string" ? { icon: o.icon } : {}),
  }
}
