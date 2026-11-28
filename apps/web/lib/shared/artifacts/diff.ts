import type { ArtifactKind } from "@/shared/types"

export type DiffOp = "equal" | "insert" | "delete"
export interface DiffSegment {
  op: DiffOp
  text: string
}

/** Line-level LCS diff of two text blobs. Adjacent same-op lines are
 *  coalesced into one segment (joined by "\n"). Pure + deterministic. */
export function diffLines(oldText: string, newText: string): DiffSegment[] {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const segs: DiffSegment[] = []
  const push = (op: DiffOp, text: string) => {
    const last = segs[segs.length - 1]
    if (last && last.op === op) last.text += `\n${text}`
    else segs.push({ op, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("equal", a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("delete", a[i])
      i++
    } else {
      push("insert", b[j])
      j++
    }
  }
  while (i < n) {
    push("delete", a[i])
    i++
  }
  while (j < m) {
    push("insert", b[j])
    j++
  }
  return segs
}

/** Prepare content for a line diff: pretty-print json/table so the diff
 *  is line-oriented; everything else passes through. Never throws. */
export function prettyForDiff(content: string, kind: ArtifactKind): string {
  if (kind === "json" || kind === "table") {
    try {
      return JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      return content
    }
  }
  return content
}
