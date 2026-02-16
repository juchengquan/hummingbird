import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface UploadedFile {
  id: string
  name: string
  size: number
  type: string
  uploadedAt: Date
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: Date
  updatedAt: Date
  pinned: boolean
}

type Theme = 'system' | 'dark' | 'light'

// Read theme from localStorage synchronously to prevent flash
function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  try {
    const stored = localStorage.getItem('hummingbird-storage')
    if (stored) {
      const parsed = JSON.parse(stored)
      return parsed.state?.theme || 'dark'
    }
  } catch {}
  return 'dark'
}

// Read persisted state from localStorage synchronously
function getPersistedState() {
  if (typeof window === 'undefined') return {}
  try {
    const stored = localStorage.getItem('hummingbird-storage')
    if (stored) {
      const parsed = JSON.parse(stored)
      return parsed.state || {}
    }
  } catch {}
  return {}
}

// Get initial persisted values
const persisted = getPersistedState()

interface AppState {
  // Theme
  theme: Theme

  // Panel visibility
  chatSessionsPanelOpen: boolean
  resourcesPanelOpen: boolean
  chatPanelOpen: boolean
  editorPanelOpen: boolean

  // Sidebar
  sidebarCollapsed: boolean

  // Panel dimensions
  chatSessionsPanelWidth: number
  resourcesPanelWidth: number
  editorPanelWidth: number

  // Files
  files: UploadedFile[]
  selectedFileIds: string[]

  // Conversations
  conversations: Conversation[]
  activeConversationId: string | null

  // Chat
  isTyping: boolean
  streamingContent: string

  // Document
  documentContent: string
  documentLastSaved: Date | null

  // Panel actions
  toggleSidebar: () => void
  toggleChatSessionsPanel: () => void
  toggleResourcesPanel: () => void
  toggleChatPanel: () => void
  toggleEditorPanel: () => void
  setChatSessionsPanelWidth: (width: number) => void
  setResourcesPanelWidth: (width: number) => void
  setEditorPanelWidth: (width: number) => void

  // File actions
  addFile: (file: UploadedFile) => void
  removeFile: (fileId: string) => void
  toggleFileSelection: (fileId: string) => void
  clearSelectedFiles: () => void

  // Conversation actions
  createConversation: () => void
  deleteConversation: (conversationId: string) => void
  renameConversation: (conversationId: string, title: string) => void
  togglePin: (conversationId: string) => void
  setActiveConversation: (conversationId: string | null) => void

  // Message actions
  addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => void
  deleteMessage: (messageId: string) => void
  updateMessage: (messageId: string, content: string) => void
  clearMessages: () => void
  setIsTyping: (typing: boolean) => void
  setStreamingContent: (content: string) => void

  // Document actions
  setDocumentContent: (content: string) => void
  setDocumentLastSaved: (date: Date) => void

  // Theme actions
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Theme
      theme: getInitialTheme(),

      // Initial panel states
      chatSessionsPanelOpen: persisted.chatSessionsPanelOpen ?? true,
      resourcesPanelOpen: persisted.resourcesPanelOpen ?? true,
      chatPanelOpen: persisted.chatPanelOpen ?? true,
      editorPanelOpen: persisted.editorPanelOpen ?? true,

      // Sidebar
      sidebarCollapsed: persisted.sidebarCollapsed ?? false,

      // Initial panel dimensions
      chatSessionsPanelWidth: persisted.chatSessionsPanelWidth ?? 280,
      resourcesPanelWidth: persisted.resourcesPanelWidth ?? 280,
      editorPanelWidth: persisted.editorPanelWidth ?? 480,

      // Files
      files: [],
      selectedFileIds: [],

      // Conversations
      conversations: (persisted.conversations || []).map((c: Conversation) => ({
        ...c,
        pinned: c.pinned ?? false,
      })),
      activeConversationId: persisted.activeConversationId ?? null,

      // Chat
      isTyping: false,
      streamingContent: '',

      // Document
      documentContent: '',
      documentLastSaved: null,

      // Panel actions
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      toggleChatSessionsPanel: () =>
        set((state) => ({ chatSessionsPanelOpen: !state.chatSessionsPanelOpen })),
      toggleResourcesPanel: () =>
        set((state) => ({ resourcesPanelOpen: !state.resourcesPanelOpen })),
      toggleChatPanel: () =>
        set((state) => ({ chatPanelOpen: !state.chatPanelOpen })),
      toggleEditorPanel: () =>
        set((state) => ({ editorPanelOpen: !state.editorPanelOpen })),
      setChatSessionsPanelWidth: (width: number) =>
        set({ chatSessionsPanelWidth: Math.max(150, Math.min(400, width)) }),
      setResourcesPanelWidth: (width: number) =>
        set({ resourcesPanelWidth: Math.max(180, Math.min(500, width)) }),
      setEditorPanelWidth: (width: number) =>
        set({ editorPanelWidth: Math.max(300, Math.min(800, width)) }),

      // File actions
      addFile: (file: UploadedFile) =>
        set((state) => ({ files: [...state.files, file] })),
      removeFile: (fileId: string) =>
        set((state) => ({
          files: state.files.filter((f) => f.id !== fileId),
          selectedFileIds: state.selectedFileIds.filter((id) => id !== fileId),
        })),
      toggleFileSelection: (fileId: string) =>
        set((state) => ({
          selectedFileIds: state.selectedFileIds.includes(fileId)
            ? state.selectedFileIds.filter((id) => id !== fileId)
            : [...state.selectedFileIds, fileId],
        })),
      clearSelectedFiles: () => set({ selectedFileIds: [] }),

      // Conversation actions
      createConversation: () => {
        const newConversation: Conversation = {
          id: crypto.randomUUID(),
          title: `New Conversation ${get().conversations.length + 1}`,
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          pinned: false,
        }
        set((state) => ({
          conversations: [newConversation, ...state.conversations],
          activeConversationId: newConversation.id,
        }))
      },
      deleteConversation: (conversationId: string) =>
        set((state) => {
          const newConversations = state.conversations.filter(
            (c) => c.id !== conversationId
          )
          return {
            conversations: newConversations,
            activeConversationId:
              state.activeConversationId === conversationId
                ? newConversations[0]?.id || null
                : state.activeConversationId,
          }
        }),
      renameConversation: (conversationId: string, title: string) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, title, updatedAt: new Date() } : c
          ),
        })),
      togglePin: (conversationId: string) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, pinned: !c.pinned } : c
          ),
        })),
      setActiveConversation: (conversationId: string | null) =>
        set({ activeConversationId: conversationId }),

      // Message actions
      addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => {
        const newMessage: Message = {
          ...message,
          id: crypto.randomUUID(),
          timestamp: new Date(),
        }
        set((state) => {
          const { conversations, activeConversationId } = state
          const updatedConversations = conversations.map((c) => {
            if (c.id === activeConversationId) {
              return {
                ...c,
                messages: [...c.messages, newMessage],
                updatedAt: new Date(),
              }
            }
            return c
          })
          return { conversations: updatedConversations }
        })
        return newMessage
      },
      deleteMessage: (messageId: string) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id === state.activeConversationId) {
              return {
                ...c,
                messages: c.messages.filter((m) => m.id !== messageId),
              }
            }
            return c
          }),
        })),
      updateMessage: (messageId: string, content: string) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id === state.activeConversationId) {
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === messageId ? { ...m, content } : m
                ),
              }
            }
            return c
          }),
        })),
      clearMessages: () =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id === state.activeConversationId) {
              return { ...c, messages: [] }
            }
            return c
          }),
        })),
      setIsTyping: (typing: boolean) => set({ isTyping: typing }),
      setStreamingContent: (content: string) => set({ streamingContent: content }),

      // Document actions
      setDocumentContent: (content: string) => set({ documentContent: content }),
      setDocumentLastSaved: (date: Date) => set({ documentLastSaved: date }),

      // Theme actions
      setTheme: (theme: Theme) => set({ theme }),
      toggleTheme: () => {
        const currentTheme = get().theme
        const themes: Theme[] = ['system', 'dark', 'light']
        const currentIndex = themes.indexOf(currentTheme)
        const nextIndex = (currentIndex + 1) % themes.length
        set({ theme: themes[nextIndex] })
      },
    }),
    {
      name: 'hummingbird-storage',
      partialize: (state) => ({
        theme: state.theme,
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        files: state.files,
        documentContent: state.documentContent,
        chatSessionsPanelOpen: state.chatSessionsPanelOpen,
        resourcesPanelOpen: state.resourcesPanelOpen,
        chatPanelOpen: state.chatPanelOpen,
        editorPanelOpen: state.editorPanelOpen,
        chatSessionsPanelWidth: state.chatSessionsPanelWidth,
        resourcesPanelWidth: state.resourcesPanelWidth,
        editorPanelWidth: state.editorPanelWidth,
      }),
    }
  )
)

// Helper selectors
export const useActiveConversation = () => {
  const conversations = useStore((state) => state.conversations)
  const activeConversationId = useStore((state) => state.activeConversationId)
  return conversations.find((c) => c.id === activeConversationId) || null
}

export const useSelectedFiles = () => {
  const files = useStore((state) => state.files)
  const selectedFileIds = useStore((state) => state.selectedFileIds)
  return files.filter((f) => selectedFileIds.includes(f.id))
}
