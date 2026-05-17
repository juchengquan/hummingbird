# Utilities and CSS

This document details the utility functions and CSS design system used in the application.

---

## 1. File Utils

### 1.1 Location

`lib/file-utils.tsx`

### 1.2 Interface

```typescript
interface UploadedFile {
  id: string
  name: string
  size: number
  type: string
  uploadedAt: Date
}
```

### 1.3 processSelectedFiles

Processes a FileList and returns an array of UploadedFile objects:

```typescript
export function processSelectedFiles(
  files: FileList | null,
  options: {
    maxSize?: number
    onValidationError?: (error: string) => void
  } = {}
): UploadedFile[] {
  if (!files) return []

  const { maxSize = 5 * 1024 * 1024, onValidationError } = options
  const uploadedFiles: UploadedFile[] = []

  Array.from(files).forEach((file) => {
    if (file.size > maxSize) {
      onValidationError?.(`File "${file.name}" exceeds ${formatFileSize(maxSize)} limit`)
      return
    }

    uploadedFiles.push({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      type: file.type,
      uploadedAt: new Date(),
    })
  })

  return uploadedFiles
}
```

### 1.4 getFileIcon

Returns a Lucide icon based on file MIME type:

```typescript
export function getFileIcon(type: string): React.ReactNode {
  if (type.includes('pdf')) return <FileText className="text-red-500" size={20} />
  if (type.includes('word') || type.includes('document')) return <FileText className="text-blue-500" size={20} />
  if (type.includes('image')) return <Image className="text-purple-500" size={20} />
  if (type.includes('json')) return <FileJson className="text-yellow-500" size={20} />
  if (type.includes('csv') || type.includes('text')) return <FileText className="text-green-500" size={20} />
  return <File className="text-gray-500" size={20} />
}
```

### 1.5 formatFileSize

Formats bytes into human-readable size:

```typescript
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
```

---

## 2. CN Utility

### 2.1 Location

`lib/utils.ts`

### 2.2 Purpose

Merges Tailwind CSS classes, handling conflicts properly.

### 2.3 Implementation

```typescript
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

### 2.4 Usage

```typescript
import { cn } from "@/lib/utils"

// Basic usage
<div className={cn("base-class", condition && "conditional-class")} />

// With conflicting classes
<div className={cn("p-2 p-4")} />  // Returns "p-4"
```

---

## 3. CSS Design System

### 3.1 Location

`app/globals.css`

### 3.2 CSS Variables

The application uses CSS custom properties for theming:

#### Light Theme

```css
:root {
  --background: #ffffff;
  --foreground: #171717;
  --card: #ffffff;
  --card-foreground: #171717;
  --primary: #000000;
  --primary-foreground: #ffffff;
  --secondary: #f5f5f5;
  --secondary-foreground: #171717;
  --muted: #f5f5f5;
  --muted-foreground: #737373;
  --accent: #f5f5f5;
  --accent-foreground: #171717;
  --destructive: #ef4444;
  --destructive-foreground: #fafafa;
  --border: #e5e5e5;
  --input: #e5e5e5;
  --ring: #171717;
  --radius: 0.5rem;
}
```

#### Dark Theme

```css
.dark {
  --background: #0a0a0a;
  --foreground: #ededed;
  --card: #1a1a1a;
  --card-foreground: #ededed;
  --primary: #ededed;
  --primary-foreground: #171717;
  --secondary: #262626;
  --secondary-foreground: #ededed;
  --muted: #262626;
  --muted-foreground: #a3a3a3;
  --accent: #262626;
  --accent-foreground: #ededed;
  --destructive: #ef4444;
  --destructive-foreground: #fafafa;
  --border: #262626;
  --input: #262626;
  --ring: #d4d4d4;
}
```

### 3.3 Variable Categories

| Category | Variables |
|----------|-----------|
| Base | `--background`, `--foreground` |
| Cards | `--card`, `--card-foreground` |
| Primary | `--primary`, `--primary-foreground` |
| Secondary | `--secondary`, `--secondary-foreground` |
| Muted | `--muted`, `--muted-foreground` |
| Accent | `--accent`, `--accent-foreground` |
| Destructive | `--destructive`, `--destructive-foreground` |
| Borders | `--border`, `--input`, `--ring` |
| Radius | `--radius` |

---

## 4. Animations

### 4.1 Animation Definitions

All animations are defined in `app/globals.css`:

```css
@keyframes message-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes avatar-in {
  from {
    opacity: 0;
    transform: scale(0.8);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes content-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes scroll-button-in {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

@keyframes input-bar-in {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes slide-in-right {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes slide-out-right {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(100%);
    opacity: 0;
  }
}
```

### 4.2 Animation Classes

```css
.animate-message-in { animation: message-in 0.3s ease-out forwards; }
.animate-avatar-in { animation: avatar-in 0.3s ease-out forwards; }
.animate-content-in { animation: content-in 0.3s ease-out forwards; }
.animate-scroll-button-in { animation: scroll-button-in 0.3s ease-out forwards; }
.animate-input-bar-in { animation: input-bar-in 0.3s ease-out forwards; }
.animate-slide-in-right { animation: slide-in-right 0.3s ease-out forwards; }
.animate-slide-out-right { animation: slide-out-right 0.3s ease-out forwards; }
```

### 4.3 Animation Delays

Message animations use staggered delays:

```typescript
// In React component
<div
  className="animate-message-in"
  style={{ animationDelay: `${index * 50}ms` }}
>
```

---

## 5. Tailwind Configuration

### 5.1 Configuration Files

- `tailwind.config.ts` - Tailwind configuration
- `postcss.config.mjs` - PostCSS configuration

### 5.2 Tailwind CSS v4 Features

The application uses Tailwind CSS v4, which includes:
- CSS-based configuration
- Improved performance
- New CSS functions

---

## 6. Related Documents

- [01_project_overview.md](01_project_overview.md) - Project foundation
- [02_state_management.md](02_state_management.md) - State management
- [03_ui_components.md](03_ui_components.md) - UI components
- [04_ui_layout.md](04_ui_layout.md) - Layout system
