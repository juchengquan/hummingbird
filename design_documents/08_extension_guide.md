# Extension Guide

This document provides guidance on how to extend the application with new features.

---

## 1. Adding a Main-Area Tab

All dashboard views — workspaces, chat, resources, editor — render in `SidebarInset` via `MainArea`, gated by a single store field `activeView`. Adding a new tab means: (1) extend the union type, (2) render the panel in `MainArea`, (3) add a sidebar entry that calls `setActiveView`.

### 1.1 Create the Panel Component

`components/panels/example-main.tsx` — a normal client component returning a full-height layout. No wrapper.

### 1.2 Extend the `MainView` union and `setActiveView`

```typescript
// lib/hooks/use-store.ts
export type MainView = 'workspaces' | 'chat' | 'resources' | 'editor' | 'example'
```

`setActiveView` is already typed against `MainView`, so no other change is needed.

### 1.3 Render the panel in `MainArea`

```tsx
// app/dashboard/page.tsx
{activeView === "example" && <ExampleMainPanel />}
```

### 1.4 Add a sidebar entry

For a top-level tab (like Workspaces):

```tsx
<SidebarMenuItem>
  <SidebarMenuButton
    onClick={() => setActiveView("example")}
    isActive={activeView === "example"}
    tooltip="Example"
  >
    <Icon />
    <span className="group-data-[collapsible=icon]:hidden">Example</span>
  </SidebarMenuButton>
</SidebarMenuItem>
```

For a sub-item nested under a collapsible group (like `Files` under `Resources`), put a `SidebarMenuButton` inside the group's `CollapsibleContent` — see the Resources group in `components/sidebars/application.tsx`. If you need a deeper hierarchy with `SidebarMenuSub` / `SidebarMenuSubItem` / `SidebarMenuSubButton`, those primitives are available in `components/ui/sidebar.tsx`.

For an entry that needs to set additional state alongside the view (e.g. selecting a chat sets both `activeConversation` and `activeView`), write a tiny handler:

```typescript
const handleSelectConversation = (id: string) => {
  setActiveConversation(id)
  setActiveView("chat")
}
```

### 1.5 Avoid this anti-pattern

Do NOT add a new boolean flag like `examplePanelOpen` and check it separately in `MainArea`. Booleans like that gave us the original "overlay" behavior — multiple panels could be "open" at once and the dashboard had to pick a winner. The whole point of `activeView` is that exactly one panel is mounted at a time.

---

## 2. Sidebar Patterns

### 2.1 Collapsible group with header action (`SidebarGroupAction`)

Used by the Chats group to put a `+` button on the same row as the collapsible label. The action is positioned absolutely (`top-3.5 right-3`), so add `mr-6` to the chevron so they don't overlap.

```tsx
<Collapsible open={open} onOpenChange={setOpen} className="group/collapsible">
  <SidebarGroup>
    <SidebarGroupLabel asChild>
      <CollapsibleTrigger>
        Chats
        <ChevronRight className="ml-auto mr-6 transition-transform group-data-[state=open]/collapsible:rotate-90" />
      </CollapsibleTrigger>
    </SidebarGroupLabel>
    <SidebarGroupAction title="New chat" aria-label="New chat" onClick={handleNewChat}>
      <Plus />
    </SidebarGroupAction>
  </SidebarGroup>
  <CollapsibleContent>
    <SidebarGroupContent>
      <SidebarMenu>{/* items */}</SidebarMenu>
    </SidebarGroupContent>
  </CollapsibleContent>
</Collapsible>
```

### 2.2 Collapsible group containing sub-actions

Used by the Resources group to nest a "Files" `SidebarMenuButton` inside the collapsible body. Each sub-item is a normal `SidebarMenuItem` + `SidebarMenuButton`. Hide the whole group when the sidebar is icon-collapsed by wrapping the outer `SidebarGroup` with `className="group-data-[collapsible=icon]:hidden"`.

```tsx
<SidebarGroup className="group-data-[collapsible=icon]:hidden">
  <SidebarMenu>
    <SidebarMenuItem>
      <Collapsible open={open} onOpenChange={setOpen} className="group/collapsible">
        <SidebarGroup>
          <SidebarGroupLabel asChild>
            <CollapsibleTrigger>
              Resources
              <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
            </CollapsibleTrigger>
          </SidebarGroupLabel>
        </SidebarGroup>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => setActiveView("resources")}
                  isActive={activeView === "resources"}
                >
                  <Files />
                  <span className="group-data-[collapsible=icon]:hidden">Files</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  </SidebarMenu>
</SidebarGroup>
```

---

## 3. Adding AI Integration

### 3.1 Create API Route

Create a new file `app/api/chat/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { messages, files } = await req.json()

  // Call AI API with messages and file context
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [...messages],
      stream: true,
    }),
  })

  // Handle streaming response
  return new NextResponse(response.body, {
    headers: {
      'Content-Type': 'text/plain',
    },
  })
}
```

### 3.2 Update Chat Component

Replace the mock AI response with actual API call:

```typescript
const handleSendMessage = async () => {
  if (!inputValue.trim()) return

  const messageContent = inputValue.trim()

  addMessage({
    role: "user",
    content: messageContent,
  })

  setInputValue("")

  // Show typing indicator
  setIsTyping(true)

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          ...activeConversation.messages,
          { role: 'user', content: messageContent }
        ],
        files: selectedFiles
      })
    })

    // Handle streaming response
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value)
      // Process chunk and add to message
    }
  } catch (error) {
    console.error('AI error:', error)
  }

  setIsTyping(false)
}
```

### 3.3 Environment Variables

Add to `.env.local`:

```bash
OPENAI_API_KEY=your-api-key-here
```

---

## 4. Adding Database Persistence

### 4.1 Install Prisma

```bash
bun add prisma --dev
bunx prisma init
```

### 4.2 Define Schema

Create `prisma/schema.prisma`:

```prisma
model User {
  id            String         @id @default(cuid())
  email         String         @unique
  conversations Conversation[]
  files         UploadedFile[]
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt
}

model Conversation {
  id        String    @id @default(cuid())
  title     String
  messages  Message[]
  pinned    Boolean  @default(false)
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Message {
  id             String       @id @default(cuid())
  role           String
  content        String
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id])
  createdAt      DateTime     @default(now())
}

model UploadedFile {
  id          String   @id @default(cuid())
  name        String
  size        Int
  type        String
  userId      String
  user        User     @relation(fields: [userId], references: [id])
  uploadedAt  DateTime @default(now())
}
```

### 4.3 Run Migration

```bash
bunx prisma migrate dev --name init
```

### 4.4 Create Database Utility

Create `lib/db.ts`:

```typescript
import { PrismaClient } from '@prisma/client'

const globalForPrisma = global as unknown as { prisma: PrismaClient }

export const prisma = globalForPrisma.prisma || new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
```

### 4.5 Replace LocalStorage with Database

Update store actions to persist to database:

```typescript
// Example: Create conversation
createConversation: async () => {
  const userId = getCurrentUserId() // Implement auth

  const conversation = await prisma.conversation.create({
    data: {
      title: `New Conversation ${get().conversations.length + 1}`,
      userId,
    }
  })

  set(state => ({
    conversations: [conversation, ...state.conversations],
    activeConversationId: conversation.id
  }))
}
```

---

## 5. Adding Authentication

### 4.1 Install NextAuth

```bash
bun add next-auth
```

### 4.2 Create Auth Routes

Create `app/api/auth/[...nextauth]/route.ts`:

```typescript
import NextAuth from "next-auth"
import GoogleProvider from "next-auth/providers/google"

const handler = NextAuth({
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async session({ session, token }) {
      session.user.id = token.sub
      return session
    },
  },
})

export { handler as GET, handler as POST }
```

### 4.3 Add Environment Variables

```bash
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
NEXTAUTH_SECRET=your-secret
NEXTAUTH_URL=http://localhost:3000
```

---

## 6. Adding File Upload to Cloud Storage

### 5.1 Install UploadThing

```bash
bun add uploadthing @uploadthing/react
```

### 5.2 Configure UploadThing

Create `lib/uploadthing.ts`:

```typescript
import { generateReactHelpers } from "@uploadthing/react"
import type { OurFileRouter } from "@/app/api/uploadthing/core"

export const { useUploadThing, uploadFiles } = generateReactHelpers<OurFileRouter>()
```

### 5.3 Create Upload API

Create `app/api/uploadthing/core.ts`:

```typescript
import { auth } from "@/auth"
import { createUploadthing } from "uploadthing/next"

const f = createUploadthing()

export const ourFileRouter = {
  media: f({ image: { maxFileSize: "4MB" } })
    .middleware(async () => {
      const session = await auth()
      if (!session) throw new Error("Unauthorized")
      return { userId: session.user.id }
    })
    .onUploadComplete(() => {}),
} satisfies OurFileRouter
```

---

## 7. Adding Export Functionality

### 6.1 Export to PDF

```typescript
import html2canvas from 'html2canvas-pro'
import { jsPDF } from 'jspdf'

async function exportToPDF(element: HTMLElement) {
  const canvas = await html2canvas(element)
  const imgData = canvas.toDataURL('image/png')
  const pdf = new jsPDF()
  pdf.addImage(imgData, 'PNG', 0, 0, pdf.internal.pageSize.getWidth(), pdf.internal.pageSize.getHeight())
  pdf.save('document.pdf')
}
```

### 6.2 Export to Markdown

```typescript
function exportToMarkdown(content: string) {
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'document.md'
  a.click()
  URL.revokeObjectURL(url)
}
```

---

## 8. Best Practices

### 7.1 Component Organization

- Keep components small and focused
- Use descriptive names
- Co-locate related files

### 7.2 State Management

- Use Zustand for global state
- Use local state for component-specific state
- Keep stores focused and modular

### 7.3 Performance

- Use `useMemo` and `useCallback` appropriately
- Implement code splitting with dynamic imports
- Optimize images and assets

### 7.4 Accessibility

- Use semantic HTML
- Add ARIA labels
- Test keyboard navigation

---

## 9. Related Documents

- [01_project_overview.md](01_project_overview.md) - Project foundation
- [02_state_management.md](02_state_management.md) - State management
- [03_ui_components.md](03_ui_components.md) - UI components
- [04_ui_layout.md](04_ui_layout.md) - Layout system
- [07_features.md](07_features.md) - Feature implementation status
