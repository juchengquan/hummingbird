/**
 * Share-by-URL primitives for portable user skills
 * (`docs/PLAN-portable-skills.md`). Mirrors `lib/shared/agents/share.ts`:
 * base64url-encode the JSON of the shareable subset into a
 * `?import-skill=` URL token; the recipient's app sees the param on load
 * and offers an Import modal. Pure — no I/O, no React.
 */

import type { ShareableUserSkill, UserSkill } from "./user-skill-types"

/** Strip a stored skill down to the shareable subset. */
export function toShareableUserSkill(skill: UserSkill): ShareableUserSkill {
  return {
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    body: skill.body,
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

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

/** Encode a shareable skill into a URL-safe token. The caller prefixes
 *  it with the app origin + `?import-skill=`. */
export function encodeSkillShareToken(shareable: ShareableUserSkill): string {
  const json = JSON.stringify(shareable)
  return toBase64Url(new TextEncoder().encode(json))
}

/** Decode a `?import-skill=` token. Returns null on malformed input or
 *  schema mismatch — bad input is silently ignored upstream. */
export function decodeSkillShareToken(
  token: string
): ShareableUserSkill | null {
  const bytes = fromBase64Url(token)
  if (!bytes) return null
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (!json || typeof json !== "object") return null
  const o = json as Partial<ShareableUserSkill>
  if (typeof o.name !== "string" || !o.name.trim()) return null
  if (typeof o.body !== "string") return null
  return {
    name: o.name,
    description: typeof o.description === "string" ? o.description : "",
    whenToUse: typeof o.whenToUse === "string" ? o.whenToUse : "",
    body: o.body,
  }
}
