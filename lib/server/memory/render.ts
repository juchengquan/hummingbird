import "server-only"

/** Render the always-on memory block for the system prompt, or null when
 *  there are no facts. Plain bullets (small set, injected whole). */
export function renderMemoryBlock(
  facts: { fact: string; category: string | null }[],
): string | null {
  if (facts.length === 0) return null
  const lines = facts.map((f) => `- ${f.fact}`)
  return [
    "What you know about this user (they can view/edit/remove these in Settings → Memory):",
    ...lines,
  ].join("\n")
}
