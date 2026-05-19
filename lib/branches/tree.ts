/**
 * Build the conversation fork tree for the branches dialog.
 *
 * A "tree" is the set of conversations connected by parentId edges,
 * rooted at the first ancestor without a parentId. Conversations with
 * no children and no parent are trivial single-node trees and are
 * omitted from the dialog — we only show trees with ≥ 2 nodes (at
 * least one fork).
 */

import type { Conversation } from "@/lib/types"

export interface BranchNode {
  conversation: Conversation
  children: BranchNode[]
  /** Depth from the root (0 for the root). */
  depth: number
}

/**
 * Walk up `parentId` until we find a node with no parent (or hit a
 * missing parent — broken lineage falls back to the current node).
 */
export function findRoot(
  conversations: Conversation[],
  startId: string
): Conversation | null {
  const byId = new Map(conversations.map((c) => [c.id, c]))
  let cur = byId.get(startId)
  if (!cur) return null
  let safety = 50 // guard against cycles
  while (cur.parentId && byId.has(cur.parentId) && safety-- > 0) {
    cur = byId.get(cur.parentId)!
  }
  return cur
}

/**
 * Build a tree rooted at `rootId`. Children sorted by `createdAt`
 * ascending so the chronological branch order reads naturally.
 */
export function buildTree(conversations: Conversation[], rootId: string): BranchNode | null {
  const byId = new Map(conversations.map((c) => [c.id, c]))
  const root = byId.get(rootId)
  if (!root) return null

  const childrenByParent = new Map<string, Conversation[]>()
  for (const c of conversations) {
    if (!c.parentId) continue
    const arr = childrenByParent.get(c.parentId) ?? []
    arr.push(c)
    childrenByParent.set(c.parentId, arr)
  }

  function build(node: Conversation, depth: number): BranchNode {
    const kids = (childrenByParent.get(node.id) ?? [])
      .slice()
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      )
    return {
      conversation: node,
      depth,
      children: kids.map((c) => build(c, depth + 1)),
    }
  }
  return build(root, 0)
}

/**
 * Count the total nodes in a tree.
 */
export function countNodes(node: BranchNode): number {
  let n = 1
  for (const c of node.children) n += countNodes(c)
  return n
}

/**
 * Returns the title-fragment of the message in `parent` that was the
 * branch point. Used by the branches dialog to caption each fork edge.
 */
export function describeBranchPoint(
  parent: Conversation,
  messageId: string | undefined
): string | null {
  if (!messageId) return null
  const m = parent.messages.find((x) => x.id === messageId)
  if (!m) return null
  const snippet = m.content.trim().split(/\r?\n/)[0]
  return snippet.length > 60 ? `${snippet.slice(0, 57)}…` : snippet
}
