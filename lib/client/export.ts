import type { Conversation } from "@/shared/types"

function formatTimestamp(timestamp: Date | string): string {
  const d = new Date(timestamp)
  return d.toISOString()
}

export function conversationToMarkdown(conversation: Conversation): string {
  const header = `# ${conversation.title}\n\n_Exported ${new Date().toISOString()}_\n`
  const body = conversation.messages
    .filter((m) => !m.error)
    .map((m) => {
      const role = m.role === "user" ? "User" : "Assistant"
      return `## ${role} — ${formatTimestamp(m.timestamp)}\n\n${m.content}`
    })
    .join("\n\n---\n\n")
  return body ? `${header}\n${body}\n` : `${header}\n_No messages yet._\n`
}

export function safeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").trim()
  return cleaned.length > 0 ? cleaned : "untitled"
}

export function downloadAsFile(
  filename: string,
  content: string,
  mimeType: string = "text/markdown;charset=utf-8"
): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}
