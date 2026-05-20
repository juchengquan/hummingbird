"use client"

import { useEffect, useState, useMemo } from "react"
import { useStore } from "@/client/hooks/use-store"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import {
  FolderOpen,
  PencilLine,
  Files,
  MessagesSquare,
  MessageSquare,
  Plus,
  Layers,
  Sparkles,
  Quote,
} from "lucide-react"
import type { MainView } from "@/shared/types"

/** Snapshot of the document selection at the moment the palette opens.
 *  We capture it BEFORE focus moves to the palette input (which would
 *  collapse the selection). The dispatch path then dispatches a
 *  pending-selection-action with the captured rect — by the time the
 *  user picks an entry, `window.getSelection()` is gone but we still
 *  have what we need. */
interface SelectionSnapshot {
  text: string
  scope: string
  rect: { top: number; left: number; right: number; bottom: number; width: number; height: number }
}

function captureSelectionSnapshot(): SelectionSnapshot | null {
  if (typeof window === "undefined") return null
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const text = sel.toString().trim()
  if (!text) return null
  const range = sel.getRangeAt(0)
  let node: Node | null = range.commonAncestorContainer
  while (node && node.nodeType !== 1) node = node.parentNode
  const el = node as Element | null
  const scopeEl = el?.closest?.("[data-selection-scope]") as HTMLElement | null
  if (!scopeEl) return null
  const scope = scopeEl.dataset.selectionScope ?? ""
  if (!scope) return null
  const r = range.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return {
    text,
    scope,
    rect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
  }
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [selectionSnapshot, setSelectionSnapshot] =
    useState<SelectionSnapshot | null>(null)

  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const conversations = useStore((s) => s.conversations)
  const setActiveView = useStore((s) => s.setActiveView)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)
  const setActiveConversation = useStore((s) => s.setActiveConversation)
  const createConversation = useStore((s) => s.createConversation)
  const fireSelectionAction = useStore((s) => s.fireSelectionAction)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key?.toLowerCase() === "k") {
        e.preventDefault()
        // Snapshot the selection FIRST (synchronously, while it still
        // lives in the document) — opening the dialog steals focus and
        // collapses any active range.
        const snap = captureSelectionSnapshot()
        setSelectionSnapshot(snap)
        setOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  // Reset the snapshot whenever the palette closes — we don't want a
  // stale selection sticking around to next-time-the-palette-opens.
  useEffect(() => {
    if (!open) setSelectionSnapshot(null)
  }, [open])

  const conversationsForActiveWorkspace = useMemo(
    () => conversations.filter((c) => c.workspaceId === activeWorkspaceId),
    [conversations, activeWorkspaceId]
  )

  const otherConversations = useMemo(
    () => conversations.filter((c) => c.workspaceId !== activeWorkspaceId),
    [conversations, activeWorkspaceId]
  )

  const run = (fn: () => void) => {
    setOpen(false)
    fn()
  }

  const goToView = (view: MainView) => run(() => setActiveView(view))

  const goToConversation = (conversationId: string, workspaceId: string) =>
    run(() => {
      if (workspaceId !== activeWorkspaceId) {
        setActiveWorkspace(workspaceId)
      }
      setActiveConversation(conversationId)
      setActiveView("chat")
    })

  const goToWorkspace = (workspaceId: string) =>
    run(() => {
      setActiveWorkspace(workspaceId)
      setActiveView("workspaces")
    })

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search conversations, workspaces, or commands…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() =>
              run(() => {
                createConversation()
                setActiveView("chat")
              })
            }
          >
            <Plus />
            <span>New chat</span>
            <CommandShortcut>⌘K</CommandShortcut>
          </CommandItem>
          {selectionSnapshot && (
            <>
              <CommandItem
                value="explain selection"
                onSelect={() =>
                  run(() =>
                    fireSelectionAction({
                      type: "explain",
                      text: selectionSnapshot.text,
                      scope: selectionSnapshot.scope,
                      rect: selectionSnapshot.rect,
                    })
                  )
                }
              >
                <Sparkles />
                <span>Explain selection</span>
                <CommandShortcut>⌘E</CommandShortcut>
              </CommandItem>
              <CommandItem
                value="quote selection in reply"
                onSelect={() =>
                  run(() =>
                    fireSelectionAction({
                      type: "quote",
                      text: selectionSnapshot.text,
                    })
                  )
                }
              >
                <Quote />
                <span>Quote selection in reply</span>
              </CommandItem>
            </>
          )}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Views">
          <CommandItem onSelect={() => goToView("chat")}>
            <MessagesSquare />
            <span>Go to Chat</span>
          </CommandItem>
          <CommandItem onSelect={() => goToView("editor")}>
            <PencilLine />
            <span>Go to Editor</span>
          </CommandItem>
          <CommandItem onSelect={() => goToView("workspaces")}>
            <FolderOpen />
            <span>Go to Workspaces</span>
          </CommandItem>
          <CommandItem onSelect={() => goToView("resources")}>
            <Files />
            <span>Go to Files</span>
          </CommandItem>
        </CommandGroup>

        {workspaces.length > 1 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Switch workspace">
              {workspaces.map((w) => (
                <CommandItem
                  key={w.id}
                  value={`workspace ${w.name}`}
                  onSelect={() => goToWorkspace(w.id)}
                >
                  <Layers />
                  <span>{w.name}</span>
                  {w.id === activeWorkspaceId && (
                    <CommandShortcut>active</CommandShortcut>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {conversationsForActiveWorkspace.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Conversations (this workspace)">
              {conversationsForActiveWorkspace.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`conversation ${c.title}`}
                  onSelect={() => goToConversation(c.id, c.workspaceId)}
                >
                  <MessageSquare />
                  <span className="truncate">{c.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {otherConversations.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Conversations (other workspaces)">
              {otherConversations.map((c) => {
                const ws = workspaces.find((w) => w.id === c.workspaceId)
                return (
                  <CommandItem
                    key={c.id}
                    value={`conversation ${c.title} ${ws?.name ?? ""}`}
                    onSelect={() => goToConversation(c.id, c.workspaceId)}
                  >
                    <MessageSquare />
                    <span className="truncate">{c.title}</span>
                    {ws && <CommandShortcut>{ws.name}</CommandShortcut>}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
