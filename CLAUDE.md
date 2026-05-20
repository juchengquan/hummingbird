# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Humm is a Next.js 16.1.6 chat assistant application with a multi-panel interface featuring chat, rich text editor (Plate.js), and file management capabilities.

## Commands

```bash
# Development
bun dev              # Start development server on http://localhost:3000

# Build & Production
bun run build        # Build for production
bun run start        # Start production server

# Linting
bun run lint         # Run ESLint
bun run typecheck    # Run `tsc --noEmit`
bun run check        # typecheck + lint (fast — mirrors CI without build/audit)
bun run check:ci     # typecheck + lint + build + audit:bundle (full CI gate locally)
```

## Architecture

### Tech Stack

- **Runtime**: Bun (package manager)
- **Framework**: Next.js 16.1.6 (App Router)
- **Language**: TypeScript 5.x
- **UI**: React 19.2.3
- **Styling**: Tailwind CSS 4 + shadcn/ui components
- **State**: Zustand 5.x with localStorage persistence
- **Editor**: Plate.js (Slate-based rich text)
- **Icons**: Lucide React

### Key Directories

| Directory | Purpose |
|-----------|---------|
| `app/` | Next.js App Router pages and layouts |
| `components/ui/` | Base UI components (shadcn/radix) |
| `components/panels/` | Main content panels (chat, editor, sources) |
| `components/sidebars/` | Sliding sidebar components |
| `lib/hooks/` | Zustand stores and custom hooks |
| `lib/` | Utilities (cn() for Tailwind, file-utils) |

### State Management

The app uses **Zustand** with localStorage persistence (`lib/hooks/use-store.ts`):

- **Main store (`useStore`)**: Panel visibility, theme, conversations, messages, files, editor content
- **Session store (`useSessionStore`)**: Ephemeral state using sessionStorage (selected files for current session)

Key store interfaces:
```typescript
interface Conversation { id, title, messages[], createdAt, updatedAt, pinned }
interface Message { id, role: 'user' | 'assistant', content, timestamp }
interface UploadedFile { id, name, size, type, uploadedAt }
```

The store persists: theme, conversations, activeConversationId, files, documentContent, panel states, and panel widths.

### Panel System

Uses Shadcn UI's `SidebarProvider` for a multi-panel layout:
- **AppSidebar**: Main navigation (left)
- **ChatSidebar**: Chat sessions list
- **SourcesSidebar**: File management
- **EditorSidebar**: Rich text editor (Plate.js)

Each panel is resizable and independently toggleable via the Zustand store.

### Theme

Default theme is `'dark'`. Theme is initialized synchronously from localStorage to prevent flash. Uses `suppressHydrationWarning` on the html element.

### Hydration Handling

Client-only time formatting is used to avoid hydration mismatches:
```typescript
function MessageTime({ timestamp }) {
  const [time, setTime] = useState("")
  useEffect(() => { setTime(formatTime(timestamp)) }, [timestamp])
  if (!time) return null
  return <>{time}</>
}
```

## Environment Variables

See `.env.example` for the full list. Two groups:

- **AI Gateway** (`AI_GATEWAY_API_KEY`) — required for real chat/editor AI. Without it, the chat panel falls back to a clearly-labeled mock response.
- **Supabase** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) — optional. Enables email magic-link sign-in and (eventually) cloud sync of workspaces, conversations, files, and conversation assets. Without it the app runs anonymously on `localStorage` only; the auth UI is hidden.

SQL lives under `supabase/migrations/` as three final-shape files
(`0001_schema.sql`, `0002_rls_policies.sql`, `0003_storage.sql`) — see
`docs/SUPABASE_SETUP.md` for the hosted-cloud run order, or
`docs/SUPABASE_LOCAL.md` for the local Supabase CLI path (Docker-based,
no cloud account needed).

## Frontend module conventions

`lib/` is split into three folders by runtime. The folder name tells you
where the code runs, and a fence import at the top of each file enforces
the boundary at build time:

| Folder | Runtime | Fence | Allowed imports |
|---|---|---|---|
| `lib/client/`  | Browser only | `import "client-only"` | `@/client/*`, `@/shared/*` |
| `lib/server/`  | Node only (route handlers, server components) | `import "server-only"` | `@/server/*`, `@/shared/*` |
| `lib/shared/`  | Isomorphic (pure, no I/O) | none | `@/shared/*` only |

Path aliases (`tsconfig.json`): `@/client/*`, `@/server/*`, `@/shared/*`.
ESLint enforces the same convention via `no-restricted-imports` in
`eslint.config.mjs`. After a production build, run `bun run audit:bundle`
to confirm no server-only paths or secret env-var names leaked into
`.next/static/chunks/*.js`.

When adding a new file, classify by runtime first:
- Touches `window`, `document`, `localStorage`, React hooks, or Zustand store → `lib/client/`
- Reads `process.env`, server-only secrets, or uses `next/headers` / `cookies()` → `lib/server/`
- Pure types, Zod schemas, helpers, constants → `lib/shared/`

## API contract

Frontend → backend communication is centralised in `lib/client/api-client.ts`.
Components and hooks must call `apiClient.*` (or read URLs from
`apiUrls.*` for libraries like Plate that take a URL string) — never
`fetch('/api/...')` directly. The wire shapes are pinned in
`lib/shared/api-schemas.ts` (Zod request + response schemas) and
`docs/API.md` (the SSE streaming protocol).

When adding a new endpoint, follow the checklist at the bottom of
`docs/API.md`. The plan in `docs/PLAN-backend-extraction.md` describes
the eventual swap to a Python backend; the client + schemas + doc
together are the contract that has to survive that swap.

## Development Patterns

- All panel content uses client-side rendering (`"use client"`)
- Zustand selectors are used for reactive state (`useStore(state => state.property)`)
- Tailwind classes are composed using the `cn()` utility from `lib/utils.ts`
- Components are organized by feature (panels, sidebars) rather than by type
