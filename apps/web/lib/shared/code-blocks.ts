/**
 * Shared fenced code-block parser. Used by:
 *  - `components/panels/chat-message.tsx` for the manual "Save as artifact" action
 *  - `components/panels/chat.tsx` for auto-archiving on stream end
 */

export interface DetectedCodeBlock {
  language: string | null
  code: string
  /** Number of newline-separated lines inside the block. */
  lines: number
}

const FENCE_RE = /```(\w*)\n([\s\S]*?)```/g

export function extractCodeBlocks(content: string): DetectedCodeBlock[] {
  const blocks: DetectedCodeBlock[] = []
  let m: RegExpExecArray | null
  // Reset state — module-level regexes with /g are stateful across calls.
  FENCE_RE.lastIndex = 0
  while ((m = FENCE_RE.exec(content)) !== null) {
    const code = m[2]
    blocks.push({
      language: m[1] || null,
      code,
      lines: code.split('\n').length,
    })
  }
  return blocks
}
