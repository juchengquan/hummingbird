"use client"

import { useEffect, useState, useMemo } from "react"
import { useStore } from "@/lib/hooks/use-store"
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
} from "lucide-react"
import type { MainView } from "@/lib/types"

export function CommandPalette() {
  const [open, setOpen] = useState(false)

  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const conversations = useStore((s) => s.conversations)
  const setActiveView = useStore((s) => s.setActiveView)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)
  const setActiveConversation = useStore((s) => s.setActiveConversation)
  const createConversation = useStore((s) => s.createConversation)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

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
