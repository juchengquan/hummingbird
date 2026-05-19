"use client"

import { useMemo } from "react"
import { GitBranch, Pin, MessageSquare } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useStore } from "@/lib/hooks/use-store"
import {
  buildTree,
  countNodes,
  describeBranchPoint,
  findRoot,
  type BranchNode,
} from "@/lib/branches/tree"

interface BranchesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Conversation whose tree to show. Walks up parentId to find the root. */
  anchorConversationId: string
}

/**
 * Branches dialog — visualizes the conversation fork tree rooted at the
 * topmost ancestor of `anchorConversationId`. Each node is a card with
 * title + message count + a "branched at: <snippet>" caption explaining
 * where it diverged from its parent. Click a card to switch to that
 * conversation and close the dialog.
 *
 * Layout is an indented vertical tree with SVG elbow connectors between
 * parent and child cards. Hand-rolled to avoid pulling in react-flow
 * for what's typically a small (< 10 node) tree.
 */
export function BranchesDialog({
  open,
  onOpenChange,
  anchorConversationId,
}: BranchesDialogProps) {
  const conversations = useStore((s) => s.conversations)
  const activeConversationId = useStore((s) => s.activeConversationId)
  const setActiveConversation = useStore((s) => s.setActiveConversation)

  const tree = useMemo(() => {
    const root = findRoot(conversations, anchorConversationId)
    if (!root) return null
    return buildTree(conversations, root.id)
  }, [conversations, anchorConversationId])

  const total = tree ? countNodes(tree) : 0

  const handleSwitch = (id: string) => {
    if (id !== activeConversationId) setActiveConversation(id)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch size={16} />
            Branches
          </DialogTitle>
          <DialogDescription>
            {total <= 1
              ? "This chat hasn't been branched yet. Use the GitBranch icon on an assistant message to create a sibling chat."
              : `${total} conversations in this branch tree. Click a card to jump.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto -mx-2 px-2">
          {tree && (
            <BranchTreeRender
              node={tree}
              activeId={activeConversationId}
              onSwitch={handleSwitch}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface BranchTreeRenderProps {
  node: BranchNode
  activeId: string | null
  onSwitch: (id: string) => void
}

function BranchTreeRender({ node, activeId, onSwitch }: BranchTreeRenderProps) {
  return (
    <ul className="relative pl-0 m-0">
      <BranchTreeNode node={node} activeId={activeId} onSwitch={onSwitch} isRoot />
    </ul>
  )
}

function BranchTreeNode({
  node,
  activeId,
  onSwitch,
  isRoot,
  parentConversation,
}: {
  node: BranchNode
  activeId: string | null
  onSwitch: (id: string) => void
  isRoot?: boolean
  /** The parent conversation; supplies the message text for the "forked at" caption. */
  parentConversation?: BranchNode["conversation"]
}) {
  const isActive = node.conversation.id === activeId
  const branchPointSnippet =
    !isRoot && parentConversation
      ? describeBranchPoint(parentConversation, node.conversation.forkedFromMessageId)
      : null
  return (
    <li className="relative list-none">
      {/* Elbow connector from the parent's vertical line into this card.
          Only rendered for non-root nodes; root sits flush. */}
      {!isRoot && (
        <span
          aria-hidden
          className="absolute -left-4 top-4 w-3 h-px bg-[var(--border)]"
        />
      )}
      <button
        type="button"
        onClick={() => onSwitch(node.conversation.id)}
        className={cn(
          "w-full text-left rounded-md border px-3 py-2 transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
          isActive
            ? "border-[var(--primary)] bg-[var(--primary)]/5"
            : "border-[var(--border)] hover:bg-[var(--accent)]"
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isRoot ? (
            <MessageSquare size={12} className="shrink-0 text-[var(--muted-foreground)]" />
          ) : (
            <GitBranch size={12} className="shrink-0 text-[var(--muted-foreground)]" />
          )}
          {node.conversation.pinned && <Pin size={10} className="shrink-0 text-amber-500" />}
          <span
            className={cn(
              "text-sm font-medium truncate",
              isActive && "text-[var(--primary)]"
            )}
          >
            {node.conversation.title}
          </span>
          <span className="ml-auto text-[10px] text-[var(--muted-foreground)] shrink-0">
            {node.conversation.messages.length} msg
          </span>
        </div>
        {branchPointSnippet && (
          <p className="mt-1 text-[10px] text-[var(--muted-foreground)] italic truncate">
            forked at: {branchPointSnippet}
          </p>
        )}
      </button>

      {node.children.length > 0 && (
        <ul className="relative mt-2 ml-3 pl-4 border-l border-[var(--border)] space-y-2 list-none">
          {node.children.map((child) => (
            <BranchTreeNode
              key={child.conversation.id}
              node={child}
              activeId={activeId}
              onSwitch={onSwitch}
              parentConversation={node.conversation}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
