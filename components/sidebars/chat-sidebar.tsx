"use client"

import { ChevronsLeft } from "lucide-react"
import { useStore } from "@/lib/hooks/use-store"
import { SlidingSidebar } from "./sliding-sidebar"
import { ChatPanel } from "../panels/chat"

export function ChatSidebar() {
  const { chatPanelOpen, toggleChatPanel } = useStore()

  return (
    <SlidingSidebar
      isOpen={chatPanelOpen}
      onClose={toggleChatPanel}
      closeButtonIcon={<ChevronsLeft size={20} className="text-[var(--foreground)]" />}
      closeButtonLabel="Close chat"
    >
      <ChatPanel />
    </SlidingSidebar>
  )
}
