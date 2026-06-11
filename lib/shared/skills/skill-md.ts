/**
 * SKILL.md parse / serialise — the portable interchange format for user
 * skills (`docs/PLAN-portable-skills.md`). A SKILL.md file is YAML-ish
 * front-matter (a few single-line `key: value` pairs) followed by a
 * markdown body:
 *
 *   ---
 *   name: Code Reviewer
 *   description: Reviews diffs for bugs and clarity
 *   when_to_use: When the user shares a diff or asks for a review
 *   ---
 *   You are a meticulous code reviewer. ...
 *
 * v1 keeps the front-matter parser intentionally tiny — single-line
 * values, the three known keys, everything after the closing fence is
 * body. Not a full YAML parser (no nested structures, no quoting); the
 * fields are all short scalars. Pure: no I/O, no deps.
 */

import type { ShareableUserSkill } from "./user-skill-types"

const FRONT_MATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/

/** Parse SKILL.md text into the shareable shape, or return an error
 *  (missing front-matter / missing name). Body may be empty. */
export function parseSkillMd(
  text: string
): ShareableUserSkill | { error: string } {
  const m = FRONT_MATTER_RE.exec(text.trim())
  if (!m) {
    return { error: "Missing front-matter (expected a leading --- block)" }
  }
  const [, frontMatter, body] = m
  let name = ""
  let description = ""
  let whenToUse = ""
  for (const line of frontMatter.split("\n")) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === "name") name = value
    else if (key === "description") description = value
    else if (key === "when_to_use" || key === "when-to-use") whenToUse = value
  }
  if (!name) {
    return { error: "Front-matter must include a non-empty `name`" }
  }
  return { name, description, whenToUse, body: body.trim() }
}

/** Serialise a skill back to SKILL.md text. Omits empty optional
 *  front-matter lines. */
export function toSkillMd(skill: ShareableUserSkill): string {
  const lines = ["---", `name: ${skill.name}`]
  if (skill.description.trim()) lines.push(`description: ${skill.description.trim()}`)
  if (skill.whenToUse.trim()) lines.push(`when_to_use: ${skill.whenToUse.trim()}`)
  lines.push("---", "", skill.body.trim(), "")
  return lines.join("\n")
}
