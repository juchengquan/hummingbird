# Dependencies

This document provides a deep dive into the dependencies used in the application.

---

## 1. Core Dependencies

### 1.1 Production Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `next` | 16.1.6 | React framework with App Router |
| `react` | 19.2.3 | UI library |
| `react-dom` | 19.2.3 | React DOM rendering |
| `zustand` | 5.0.11 | State management |
| `tailwind-merge` | 3.4.1 | Tailwind class merging |
| `clsx` | 2.1.1 | Conditional class names |
| `lucide-react` | 0.564.0 | Icon library |
| `date-fns` | 4.1.0 | Date formatting |
| `slate` | 0.123.0 | Rich text editor core |
| `slate-react` | 0.123.0 | Slate React bindings |
| `platejs` | 52.0.17 | Rich text editor |
| `react-resizable-panels` | 4 | Resizable panels |

### 1.2 Plate.js Plugins

| Package | Purpose |
|---------|---------|
| `@platejs/slate` | Core Slate plugin |
| `@platejs/basic-nodes` | Basic HTML nodes |
| `@platejs/basic-styles` | Basic styling |
| `@platejs/list` | List support |
| `@platejs/markdown` | Markdown serialization |
| `@platejs/ai` | AI features |
| `@platejs/editor` | Editor component |

### 1.3 Radix UI Components

| Package | Purpose |
|---------|---------|
| `@radix-ui/react-dropdown-menu` | Dropdown menus |
| `@radix-ui/react-separator` | Separators |
| `@radix-ui/react-toolbar` | Toolbars |
| `@radix-ui/react-tooltip` | Tooltips |

---

## 2. Development Dependencies

### 2.1 Build Tools

| Package | Purpose |
|---------|---------|
| `typescript` | Type checking |
| `eslint` | Code linting |
| `eslint-config-next` | Next.js ESLint config |
| `tailwindcss` | 4 |
| `@tailwindcss/postcss` | PostCSS plugin for Tailwind |

---

## 3. Plate.js Editor Configuration

### 3.1 Editor Kit

Location: `components/third-party/plate/editor/editor-kit.tsx`

The editor uses a custom plugin kit:

```typescript
import { createSlatePlugin } from '@platejs/slate'
import { createBasicElementsPlugin } from '@platejs/basic-nodes'
import { createListPlugin } from '@platejs/list'
import { createBasicStylesPlugin } from '@platejs/basic-styles'
import { createMarkdownPlugin } from '@platejs/markdown'
// ... more plugins

export const EditorKit = [
  createSlatePlugin(),
  createBasicElementsPlugin(),
  createBasicStylesPlugin(),
  createListPlugin(),
  createMarkdownPlugin(),
  // ... more plugins
]
```

### 3.2 Editor Components

Location: `components/third-party/plate/ui/editor.tsx`

```typescript
import { Editor, EditorContainer } from "@/components/third-party/plate/ui/editor"

// Usage
<Plate editor={editor}>
  <EditorContainer variant="default" className="h-[100vh]">
    <Editor />
  </EditorContainer>
</Plate>
```

---

## 4. UI Component Patterns

### 4.1 Button Variants

```typescript
interface ButtonProps extends React.ComponentProps<"button"> {
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
  size?: "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg"
  asChild?: boolean
}
```

### 4.2 Component Structure

The application follows Shadcn UI patterns:

```typescript
// Component with variants using CVA
import { cva, type VariantProps } from "class-variance-authority"

const buttonVariants = cva(
  "base classes",
  {
    variants: {
      variant: {
        default: "default classes",
        destructive: "destructive classes",
        // ...
      },
      size: {
        default: "size classes",
        sm: "small classes",
        // ...
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
)
```

---

## 5. Build and Run

### 5.1 Installation

```bash
# Install dependencies
bun install
```

### 5.2 Development

```bash
# Start development server
bun run dev
```

The app runs on `http://localhost:3000`

### 5.3 Build

```bash
# Build for production
bun run build

# Start production server
bun run start
```

### 5.4 Linting

```bash
# Run ESLint
bun run lint
```

---

## 6. Package Manager

### 6.1 Bun

The application uses **Bun** as the package manager:

```bash
# Install Bun (if not installed)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Run scripts
bun run dev
bun run build
bun run start
```

### 6.2 Benefits

- Faster installation than npm/yarn
- Built-in bundler
- Built-in test runner
- Native TypeScript support

---

## 7. Related Documents

- [01_project_overview.md](01_project_overview.md) - Project foundation
- [02_state_management.md](02_state_management.md) - State management
- [03_ui_components.md](03_ui_components.md) - UI components
- [04_ui_layout.md](04_ui_layout.md) - Layout system
