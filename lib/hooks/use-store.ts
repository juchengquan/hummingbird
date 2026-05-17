import { useState, useEffect } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { UploadedFile, Workspace, Resource, Message, Conversation, MainView } from '@/lib/types'

export type { UploadedFile, Workspace, Resource, Message, Conversation, MainView } from '@/lib/types'

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

// Track hydration state for SSR/client synchronization
let hasHydratedInternal = false
export const useHydrated = () => {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    setHydrated(hasHydratedInternal)
  }, [])
  return hydrated
}

// Default initial values for store
const DEFAULT_WORKSPACE_ID = 'default'

const getDefaultWorkspaces = (): Workspace[] => {
  const now = new Date('2024-01-01T12:00:00Z')
  return [
    {
      id: DEFAULT_WORKSPACE_ID,
      name: 'My Workspace',
      createdAt: now,
      updatedAt: now,
    },
  ]
}

const getDefaultConversations = (): Conversation[] => {
  const baseTime = new Date('2024-01-01T12:00:00Z').getTime()
  return [
    {
      id: 'demo-1',
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: 'Welcome Chat',
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          content: 'Hello! I am your AI assistant. How can I help you today?',
          timestamp: new Date(baseTime - 60000),
        },
        {
          id: 'msg-2',
          role: 'user',
          content: 'Hi! I am testing the chat panel. It looks great!',
          timestamp: new Date(baseTime - 30000),
        },
        {
          id: 'msg-3',
          role: 'assistant',
          content: 'Thank you! Feel free to ask me anything or start a new conversation.',
          timestamp: new Date(baseTime),
        },
      ],
      createdAt: new Date(baseTime - 120000),
      updatedAt: new Date(baseTime),
      pinned: true,
    },
  ]
}

interface AppState {
  // Theme
  theme: Theme

  // Active main-area view (single source of truth — see MainArea in dashboard/page.tsx)
  activeView: MainView

  // Sidebar
  sidebarCollapsed: boolean

  // Files
  files: UploadedFile[]

  // Workspaces
  workspaces: Workspace[]
  activeWorkspaceId: string

  // Resources (file-to-workspace associations)
  resources: Resource[]

  // Conversations
  conversations: Conversation[]
  activeConversationId: string | null

  // Chat
  isTyping: boolean
  streamingContent: string

  // Document
  documentContent: string
  documentLastSaved: Date | null

  // Editor content synced from chat
  editorContent: string

  // View / sidebar actions
  toggleSidebar: () => void
  setActiveView: (view: MainView) => void

  // Workspace actions
  createWorkspace: (name: string) => Workspace
  deleteWorkspace: (workspaceId: string) => void
  renameWorkspace: (workspaceId: string, name: string) => void
  setActiveWorkspace: (workspaceId: string) => void

  // Resource actions
  addResource: (workspaceId: string, fileId: string) => void
  removeResource: (resourceId: string) => void

  // File actions
  addFile: (file: UploadedFile) => void
  removeFile: (fileId: string) => void
  clearFiles: () => void

  // Conversation actions
  createConversation: (workspaceId?: string) => Conversation
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
  setEditorContent: (content: string) => void

  // Theme actions
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Theme
      theme: getInitialTheme(),

      // Active main-area view
      activeView: 'workspaces',

      // Sidebar
      sidebarCollapsed: false,

      // Files
      files: [],

      // Workspaces
      workspaces: getDefaultWorkspaces(),
      activeWorkspaceId: DEFAULT_WORKSPACE_ID,

      // Resources
      resources: [],

      // Conversations
      conversations: getDefaultConversations().map((c: Conversation) => ({
        ...c,
        pinned: c.pinned ?? false,
      })),
      activeConversationId: 'demo-1',

      // Chat
      isTyping: false,
      streamingContent: '',

      // Document
      documentContent: '',
      documentLastSaved: null,

      // Editor content synced from chat
      editorContent: '',

      // View / sidebar actions
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setActiveView: (view: MainView) => set({ activeView: view }),

      // Workspace actions
      createWorkspace: (name: string) => {
        const newWorkspace: Workspace = {
          id: crypto.randomUUID(),
          name,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        set((state) => ({
          workspaces: [newWorkspace, ...state.workspaces],
        }))
        return newWorkspace
      },
      deleteWorkspace: (workspaceId: string) =>
        set((state) => {
          if (state.workspaces.length <= 1) return state // Prevent deleting last workspace
          const newWorkspaces = state.workspaces.filter((w) => w.id !== workspaceId)
          const newActiveWorkspaceId = state.activeWorkspaceId === workspaceId
            ? newWorkspaces[0]?.id
            : state.activeWorkspaceId
          // Also delete associated resources and conversations
          const newResources = state.resources.filter((r) => r.workspaceId !== workspaceId)
          const newConversations = state.conversations.filter((c) => c.workspaceId !== workspaceId)
          return {
            workspaces: newWorkspaces,
            activeWorkspaceId: newActiveWorkspaceId,
            resources: newResources,
            conversations: newConversations,
          }
        }),
      renameWorkspace: (workspaceId: string, name: string) =>
        set((state) => ({
          workspaces: state.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, name, updatedAt: new Date() } : w
          ),
        })),
      setActiveWorkspace: (workspaceId: string) =>
        set({ activeWorkspaceId: workspaceId }),

      // Resource actions
      addResource: (workspaceId: string, fileId: string) => {
        const newResource: Resource = {
          id: crypto.randomUUID(),
          workspaceId,
          fileId,
          addedAt: new Date(),
        }
        set((state) => ({
          resources: [...state.resources, newResource],
        }))
      },
      removeResource: (resourceId: string) =>
        set((state) => ({
          resources: state.resources.filter((r) => r.id !== resourceId),
        })),

      // File actions
      addFile: (file: UploadedFile) =>
        set((state) => ({ files: [...state.files, file] })),
      removeFile: (fileId: string) =>
        set((state) => ({
          files: state.files.filter((f) => f.id !== fileId),
        })),
      clearFiles: () => set({ files: [] }),

      // Conversation actions
      createConversation: (workspaceId?: string) => {
        const activeWorkspaceId = workspaceId || get().activeWorkspaceId
        const newConversation: Conversation = {
          id: crypto.randomUUID(),
          workspaceId: activeWorkspaceId,
          title: `New Chat ${get().conversations.filter(c => c.workspaceId === activeWorkspaceId).length + 1}`,
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          pinned: false,
        }
        set((state) => ({
          conversations: [newConversation, ...state.conversations],
          activeConversationId: newConversation.id,
        }))
        return newConversation
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
      setEditorContent: (content: string) => set({ editorContent: content }),

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
      version: 2,
      migrate: (persistedState, fromVersion) => {
        if (!persistedState || typeof persistedState !== 'object') return persistedState
        if (fromVersion < 2) {
          const state = persistedState as Record<string, unknown>
          const stale = [
            'chatPanelOpen', 'editorPanelOpen', 'resourcesPanelOpen', 'sourcesPanelOpen',
            'chatSessionsPanelOpen', 'workspacePanelOpen',
            'chatSessionsPanelWidth', 'resourcesPanelWidth', 'editorPanelWidth',
            'selectedFileIds',
          ]
          for (const k of stale) delete state[k]
        }
        return persistedState
      },
      onRehydrateStorage: () => () => {
        hasHydratedInternal = true
      },
      partialize: (state) => ({
        theme: state.theme,
        activeView: state.activeView,
        workspaces: state.workspaces,
        activeWorkspaceId: state.activeWorkspaceId,
        resources: state.resources,
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        files: state.files,
        documentContent: state.documentContent,
      }),
    }
  )
)

// Separate store for session-based state (cleared when browser tab is closed)
interface SessionState {
  selectedFileIds: string[]
  toggleFileSelection: (fileId: string) => void
  setSelectedFileIds: (ids: string[]) => void
  clearSelectedFiles: () => void
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      selectedFileIds: [],
      toggleFileSelection: (fileId: string) =>
        set((state) => ({
          selectedFileIds: state.selectedFileIds.includes(fileId)
            ? state.selectedFileIds.filter((id) => id !== fileId)
            : [...state.selectedFileIds, fileId],
        })),
      setSelectedFileIds: (ids: string[]) => set({ selectedFileIds: ids }),
      clearSelectedFiles: () => set({ selectedFileIds: [] }),
    }),
    {
      name: 'hummingbird-session',
      storage: (typeof window !== 'undefined')
        ? createJSONStorage(() => sessionStorage)
        : undefined,
    }
  )
)

// Helper selectors
export const useActiveWorkspace = () => {
  const workspaces = useStore((state) => state.workspaces)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return workspaces.find((w) => w.id === activeWorkspaceId) || null
}

export const useActiveConversation = () => {
  const conversations = useStore((state) => state.conversations)
  const activeConversationId = useStore((state) => state.activeConversationId)
  return conversations.find((c) => c.id === activeConversationId) || null
}

export const useWorkspaceConversations = () => {
  const conversations = useStore((state) => state.conversations)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  return conversations.filter((c) => c.workspaceId === activeWorkspaceId)
}

export const useWorkspaceResources = () => {
  const resources = useStore((state) => state.resources)
  const files = useStore((state) => state.files)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  const workspaceResources = resources.filter((r) => r.workspaceId === activeWorkspaceId)
  return workspaceResources.map((r) => files.find((f) => f.id === r.fileId)).filter(Boolean) as UploadedFile[]
}
