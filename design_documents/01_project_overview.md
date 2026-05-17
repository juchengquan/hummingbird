# Project Overview

This document provides the foundational information about the Chat Assistant application, including the technology stack, project structure, and core concepts.

---

## 1. Technology Stack

The application is built with the following core technologies:

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| Runtime | Bun | Latest | JavaScript runtime and package manager |
| Framework | Next.js | 16.1.6 | React framework with App Router |
| Language | TypeScript | 5.x | Type-safe JavaScript |
| UI Library | React | 19.2.3 | Component-based UI library |
| State Management | Zustand | 5.0.11 | Lightweight state management with persistence |
| Styling | Tailwind CSS | 4 | Utility-first CSS framework |
| Icons | Lucide React | 0.564.0 | Icon library |
| Rich Text Editor | Plate.js | 0.123.0 | Rich text editing |
| UI Components | Radix UI + Shadcn | Various | Accessible UI primitives |
| AI SDK | @ai-sdk/react | 3.0.92 | AI integration |
| Date Handling | date-fns | 4.1.0 | Date formatting |

### Runtime Requirements

- **Bun**: Required for running the development server and building the application
- **Node.js**: Not required (Bun handles everything)
- **npm/yarn**: Not used (Bun manages dependencies)

---

## 2. Project Structure

### 2.1 Directory Overview

```
humm/
├── app/                          # Next.js App Router
├── components/                   # React components
├── lib/                         # Utilities, hooks, shared types
├── public/                      # Static assets
├── design_documents/           # This documentation
├── package.json                 # Dependencies
├── tsconfig.json               # TypeScript config
├── next.config.ts               # Next.js config
├── tailwind.config.ts           # Tailwind config
├── postcss.config.mjs           # PostCSS config
└── bun.lock                    # Bun lockfile
```

### 2.2 App Directory (`app/`)

| File/Directory | Purpose |
|----------------|---------|
| `layout.tsx` | Root layout with Geist fonts |
| `page.tsx` | Root redirect to dashboard |
| `globals.css` | Global CSS variables and styles |
| `favicon.ico` | App favicon |
| `dashboard/page.tsx` | Main dashboard with sidebar layout |

### 2.3 Components Directory (`components/`)

#### UI Components (`components/ui/`)

| File | Purpose |
|------|---------|
| `button.tsx` | Button with variants (default, destructive, outline, secondary, ghost, link) |
| `input-group.tsx` | Input group components with addon support |
| `sidebar.tsx` | Shadcn sidebar with collapsible mode |
| `scroll-area.tsx` | Radix scroll area wrapper |
| `resizable.tsx` | Resizable panels using react-resizable-panels |
| `popover.tsx` | Popover component |
| `avatar.tsx` | Avatar component with fallback |
| `checkbox.tsx` | Checkbox component |
| `hover-card.tsx` | Hover card for preview |
| `alert-dialog.tsx` | Alert dialog for confirmations |
| `item.tsx` | Item components for lists |
| `collapsible.tsx` | Collapsible section |
| `input.tsx` | Input component |
| `textarea.tsx` | Textarea component |
| `separator.tsx` | Separator line |
| `tooltip.tsx` | Tooltip component |
| `dropdown-menu.tsx` | Dropdown menu |
| `sheet.tsx` | Sheet/drawer component |
| `skeleton.tsx` | Loading skeleton |
| `breadcrumb.tsx` | Breadcrumb navigation |
| `custom/scrollbar.tsx` | Custom scrollbar |

#### Panels (`components/panels/`)

Each panel renders as a full main-area view via `MainArea` in `app/dashboard/page.tsx`, selected by `activeView`.

| File | Purpose |
|------|---------|
| `chat.tsx` | Chat interface with messages and input (export: `ChatPanel`) |
| `editor.tsx` | Plate.js rich text editor (export: `EditorPanel`) |
| `sources.tsx` | File management panel (export: `ResourcePanel`) |
| `workspaces.tsx` | Workspace overview grid (export: `WorkspacesPanel`) |

#### Sidebars (`components/sidebars/`)

| File | Purpose |
|------|---------|
| `application.tsx` | Main navigation sidebar with tabs for Workspaces / Editor and collapsibles for Resources / Chats |
| `conversation-item.tsx` | Conversation list item with rename / pin / delete |

#### Third-Party Integrations (`components/third-party/`)

| File | Purpose |
|------|---------|
| `plate/editor/editor-kit.tsx` | Plate.js editor plugin configuration |
| `plate/ui/editor.tsx` | Plate.js UI components |

### 2.4 Lib Directory (`lib/`)

| File | Purpose |
|------|---------|
| `hooks/use-store.ts` | Zustand store with persistence (`useStore`) and session store (`useSessionStore`); re-exports types from `@/lib/types` |
| `types.ts` | Shared domain types: `UploadedFile`, `Workspace`, `Resource`, `Message`, `Conversation`, `MainView` |
| `file-utils.tsx` | File handling utilities |
| `utils.ts` | `cn()` utility for Tailwind |

---

## 3. Core Concepts

### 3.1 Application Name

The application is named **Humm** (as seen in localStorage key: `hummingbird-storage`).

### 3.2 Workspace Model

The application uses a **Workspace-based** organization:

| Entity | Description |
|--------|-------------|
| **Workspace** | A container for related work. Contains multiple chats and shared resources |
| **Resource** | A file associated with a workspace as context for AI conversations |
| **Conversation** | A chat session within a workspace. Multiple chats per workspace allowed |

**Key relationships:**
- One workspace → many conversations
- One workspace → many resources (files)
- One conversation → belongs to one workspace
- One resource → belongs to one workspace and references one file

### 3.3 Design System

The application uses:
- **Shadcn UI** pattern for component styling
- **Radix UI** primitives for accessibility
- **Tailwind CSS** for utility classes
- **CSS Variables** for theming (light/dark mode)

### 3.3 State Management

- **Zustand** for global state with localStorage persistence
- Separate **session store** using sessionStorage for temporary state
- **React Context** for sidebar state

### 3.4 Rendering Strategy

- **Server Components** for static content
- **Client Components** for interactive UI
- **Hydration handling** for SSR compatibility

---

## 4. Version Information

| Technology | Version |
|------------|---------|
| Next.js | 16.1.6 |
| React | 19.2.3 |
| Zustand | 5.0.11 |
| Tailwind CSS | 4 |
| Plate.js | 0.123.0 |
| Bun | Latest |
| TypeScript | 5.x |

---

## 5. Related Documents

- [02_state_management.md](02_state_management.md) - State management details (Workspace, Resource, Conversation models)
- [03_ui_components.md](03_ui_components.md) - UI component documentation
- [04_ui_layout.md](04_ui_layout.md) - Layout system documentation
- [05_utilities.md](05_utilities.md) - Utility functions and CSS
- [06_dependencies.md](06_dependencies.md) - Dependencies deep dive
- [07_features.md](07_features.md) - Feature implementation status
- [08_extension_guide.md](08_extension_guide.md) - How to extend the app
