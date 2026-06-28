# In-conversation Find (⌘F) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ⌘F find bar scoped to the open conversation — every occurrence highlights in place (CSS Custom Highlight API), `Enter`/`Shift+Enter` jumps next/prev with a `current / total` count, `Esc` closes.

**Architecture:** Pure match helpers (`lib/shared`) + a client highlight util that walks the message viewport's text nodes and registers `Range`s via `CSS.highlights` (no DOM mutation, so markdown + citation buttons stay intact) + a `useConversationFind` hook (state, debounced re-walk, navigation, message-level fallback) + a `ConversationFindBar` + ⌘F wiring in the chat panel.

**Tech Stack:** React 19, TypeScript, Zustand, bun:test, the CSS Custom Highlight API.

## Global Constraints

- **No backend / store / schema change** — purely client UI over the rendered conversation.
- **No DOM mutation for highlighting** — use `CSS.highlights` + `::highlight(...)`. The `<mark>`-wrapping approach is forbidden (it would split markdown/citation markup).
- **Search scope = rendered visible text** of the open conversation (walk the scroll viewport's text nodes). Collapsed reasoning / unrendered content is not matched (documented v1 limitation).
- **Case-insensitive only**; no regex/whole-word/case toggle in v1.
- **⌘F intercepts only** when the chat view is active AND a conversation is open; otherwise leave the browser's native find alone.
- **Fallback:** when `CSS.highlights` is unavailable, degrade to message-level (jump between matching `#chat-message-{id}` with a brief flash; `total` = matching message count).
- `lib/shared/*` = pure, no fence; `lib/client/*` = `import "client-only"`; components = `"use client"`.
- Tests: `bun test <path>`; new `*.test.ts` under `./lib`. The hook / util / bar / wiring are NOT render-tested (no `@testing-library` in repo) — the pure helpers carry coverage; the rest is review + the manual runbook.
- Run `bun run check` before each commit; must pass. Commit messages: **no `Co-Authored-By` trailer**.
- Reference patterns: the ⌘K keydown in `components/command-palette.tsx:78-92` (+ `captureSelectionSnapshot`); the viewport discovery `messagesEndRef.closest('[data-slot="scroll-area-viewport"]')` in `components/panels/use-chat-scroll.ts`; message wrappers carry `id="chat-message-{id}"`.

---

## File Structure

- `lib/shared/find/match.ts` *(new)* — `findMatchOffsets` + `wrapIndex`. (Task 1)
- `lib/shared/find/match.test.ts` *(new)* — their tests. (Task 1)
- `lib/client/find/highlight.ts` *(new)* — DOM text-node walk + `Range` building + `CSS.highlights` registration. (Task 2)
- `lib/client/hooks/use-conversation-find.ts` *(new)* — find state, debounced re-walk, nav, scroll, fallback. (Task 3)
- `components/panels/conversation-find-bar.tsx` *(new)* — the floating bar. (Task 4)
- `app/globals.css` — `::highlight(...)` rules + a fallback flash class. (Task 4)
- `components/panels/chat.tsx` — mount the hook + bar + ⌘F keydown. (Task 5)
- `docs/SMOKE-TEST-in-conversation-find.md` *(new)* — runbook. (Task 6)

---

## Task 1: Pure match helpers

**Files:**
- Create: `lib/shared/find/match.ts`
- Test: `lib/shared/find/match.test.ts`

**Interfaces:**
- Produces: `findMatchOffsets(haystack: string, needle: string): number[]` (case-insensitive, non-overlapping start offsets; empty/whitespace needle → `[]`); `wrapIndex(current: number, total: number, dir: 1 | -1): number`.

- [ ] **Step 1: Write the failing test**

Create `lib/shared/find/match.test.ts`:

```typescript
import { describe, expect, it } from "bun:test"

import { findMatchOffsets, wrapIndex } from "./match"

describe("findMatchOffsets", () => {
  it("finds all case-insensitive occurrences", () => {
    expect(findMatchOffsets("Foo foo FOO", "foo")).toEqual([0, 4, 8])
  })
  it("is non-overlapping", () => {
    expect(findMatchOffsets("aaaa", "aa")).toEqual([0, 2])
  })
  it("matches at the edges", () => {
    expect(findMatchOffsets("xhellox", "x")).toEqual([0, 6])
  })
  it("returns [] for no match", () => {
    expect(findMatchOffsets("abc", "z")).toEqual([])
  })
  it("returns [] for an empty or whitespace-only needle", () => {
    expect(findMatchOffsets("abc", "")).toEqual([])
    expect(findMatchOffsets("abc", "   ")).toEqual([])
  })
})

describe("wrapIndex", () => {
  it("steps forward and wraps at the end", () => {
    expect(wrapIndex(0, 3, 1)).toBe(1)
    expect(wrapIndex(2, 3, 1)).toBe(0)
  })
  it("steps back and wraps at the start", () => {
    expect(wrapIndex(0, 3, -1)).toBe(2)
    expect(wrapIndex(1, 3, -1)).toBe(0)
  })
  it("returns 0 when total is 0", () => {
    expect(wrapIndex(0, 0, 1)).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/shared/find/match.test.ts`
Expected: FAIL — cannot find module `./match`.

- [ ] **Step 3: Implement**

Create `lib/shared/find/match.ts`:

```typescript
/** Case-insensitive, non-overlapping start offsets of `needle` within
 *  `haystack`, left to right. A needle that is empty or only whitespace
 *  yields no matches (so an all-spaces query doesn't "match everything"). */
export function findMatchOffsets(haystack: string, needle: string): number[] {
  if (needle.trim() === "") return []
  const hay = haystack.toLowerCase()
  const nee = needle.toLowerCase()
  const out: number[] = []
  let i = hay.indexOf(nee)
  while (i !== -1) {
    out.push(i)
    i = hay.indexOf(nee, i + nee.length)
  }
  return out
}

/** Next/prev index with wrap-around. `dir` is 1 (next) or -1 (prev).
 *  Returns 0 when there are no items. */
export function wrapIndex(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return 0
  return (current + dir + total) % total
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/shared/find/match.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/shared/find/match.ts lib/shared/find/match.test.ts
git commit -m "feat(find): pure match-offset + wrap-index helpers"
```

---

## Task 2: Highlight util (DOM walk + CSS.highlights)

**Files:**
- Create: `lib/client/find/highlight.ts`

**Interfaces:**
- Consumes: `findMatchOffsets` (Task 1).
- Produces:
  - `supportsHighlightApi(): boolean`
  - `computeFindRanges(root: HTMLElement, query: string): Range[]` — clears prior highlights, builds a `Range` per occurrence under `root`, registers them under the `find-all` highlight, returns them in document order (`[]` if unsupported / empty / no match).
  - `setCurrentFindRange(range: Range | null): void` — registers/clears the `find-current` highlight.
  - `clearFindHighlights(): void`.

> No unit test (DOM + `CSS.highlights` aren't available in `bun test`; the
> pure offset logic is tested in Task 1). Verify with `bun run check`.
> **TS lib note:** `Highlight` + `CSS.highlights` are in recent
> `lib.dom.d.ts`. If typecheck reports them missing, add a minimal ambient
> declaration at the top of this file:
> `declare class Highlight { constructor(...ranges: Range[]) } ;`
> `declare const CSS: { highlights: Map<string, Highlight> } & typeof globalThis.CSS`
> — only if needed; prefer the built-in lib types.

- [ ] **Step 1: Implement**

Create `lib/client/find/highlight.ts`:

```typescript
import "client-only"

import { findMatchOffsets } from "@/shared/find/match"

const ALL = "hb-find-all"
const CURRENT = "hb-find-current"

export function supportsHighlightApi(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  )
}

interface Located {
  node: Text
  offset: number
}

/** Map a global offset (into the concatenated text) back to a (textNode,
 *  localOffset) pair via binary search over per-node start offsets. */
function locate(nodes: Text[], starts: number[], globalOffset: number): Located | null {
  let lo = 0
  let hi = nodes.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = starts[mid]
    const e = s + nodes[mid].data.length
    if (globalOffset < s) hi = mid - 1
    else if (globalOffset > e) lo = mid + 1
    else return { node: nodes[mid], offset: globalOffset - s }
  }
  return null
}

/** Walk text nodes under `root`, build a Range per case-insensitive
 *  occurrence of `query`, register them under the "find-all" highlight,
 *  and return them in document order. Clears prior highlights first.
 *  Returns [] when unsupported, the query is blank, or there's no match. */
export function computeFindRanges(root: HTMLElement, query: string): Range[] {
  clearFindHighlights()
  if (!supportsHighlightApi() || query.trim() === "") return []

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const starts: number[] = []
  let flat = ""
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text
    nodes.push(t)
    starts.push(flat.length)
    flat += t.data
  }

  const offsets = findMatchOffsets(flat, query)
  if (offsets.length === 0) return []
  const len = query.length
  const ranges: Range[] = []
  for (const off of offsets) {
    const start = locate(nodes, starts, off)
    const end = locate(nodes, starts, off + len)
    if (!start || !end) continue
    const r = document.createRange()
    r.setStart(start.node, start.offset)
    r.setEnd(end.node, end.offset)
    ranges.push(r)
  }
  CSS.highlights.set(ALL, new Highlight(...ranges))
  return ranges
}

export function setCurrentFindRange(range: Range | null): void {
  if (!supportsHighlightApi()) return
  if (range) CSS.highlights.set(CURRENT, new Highlight(range))
  else CSS.highlights.delete(CURRENT)
}

export function clearFindHighlights(): void {
  if (!supportsHighlightApi()) return
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}
```

- [ ] **Step 2: Verify**

Run: `bun run check`
Expected: PASS (typecheck + lint). If `Highlight`/`CSS.highlights` aren't
in the TS lib, add the minimal ambient declaration noted above and re-run.

- [ ] **Step 3: Commit**

```bash
git add lib/client/find/highlight.ts
git commit -m "feat(find): CSS-highlight range builder over message text nodes"
```

---

## Task 3: `useConversationFind` hook

**Files:**
- Create: `lib/client/hooks/use-conversation-find.ts`

**Interfaces:**
- Consumes: `computeFindRanges` / `setCurrentFindRange` / `clearFindHighlights` / `supportsHighlightApi` (Task 2), `wrapIndex` (Task 1).
- Produces: `useConversationFind(opts: { viewportRef: React.RefObject<HTMLElement | null>; messageCount: number; messages: { id: string; content: string }[] }) => { open, query, setQuery, total, current, next, prev, openFind, close }`.

> No render test (no harness). Verify with `bun run check`. This hook holds
> the orchestration; the testable offset/wrap logic lives in Task 1.

- [ ] **Step 1: Implement**

Create `lib/client/hooks/use-conversation-find.ts`:

```typescript
import "client-only"

import { useCallback, useEffect, useRef, useState } from "react"

import { wrapIndex } from "@/shared/find/match"
import { findMatchOffsets } from "@/shared/find/match"
import {
  clearFindHighlights,
  computeFindRanges,
  setCurrentFindRange,
  supportsHighlightApi,
} from "@/client/find/highlight"

const VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]'
const DEBOUNCE_MS = 120
const FLASH_MS = 1200

interface Opts {
  viewportRef: React.RefObject<HTMLElement | null>
  messageCount: number
  messages: { id: string; content: string }[]
}

export function useConversationFind({ viewportRef, messageCount, messages }: Opts) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [total, setTotal] = useState(0)
  const [current, setCurrent] = useState(0)

  // Highlight-API path keeps ranges; fallback path keeps message ids.
  const rangesRef = useRef<Range[]>([])
  const fallbackIdsRef = useRef<string[]>([])
  const usingApi = supportsHighlightApi()

  const scrollRangeIntoView = useCallback((range: Range) => {
    const el =
      range.startContainer.parentElement ??
      (range.startContainer as unknown as HTMLElement)
    el?.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [])

  const scrollMessageIntoView = useCallback((id: string) => {
    const el = document.getElementById(`chat-message-${id}`)
    if (!el) return
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    el.classList.add("hb-find-flash")
    window.setTimeout(() => el.classList.remove("hb-find-flash"), FLASH_MS)
  }, [])

  const goTo = useCallback(
    (idx: number) => {
      if (usingApi) {
        const ranges = rangesRef.current
        if (!ranges.length) return
        setCurrentFindRange(ranges[idx])
        scrollRangeIntoView(ranges[idx])
      } else {
        const ids = fallbackIdsRef.current
        if (!ids.length) return
        scrollMessageIntoView(ids[idx])
      }
    },
    [usingApi, scrollRangeIntoView, scrollMessageIntoView],
  )

  // Recompute matches (debounced) whenever the query, open state, or the
  // message list changes while open.
  useEffect(() => {
    if (!open) return
    const handle = window.setTimeout(() => {
      const root = viewportRef.current?.closest(VIEWPORT_SELECTOR) as HTMLElement | null
      if (usingApi) {
        const ranges = root ? computeFindRanges(root, query) : []
        rangesRef.current = ranges
        setTotal(ranges.length)
        setCurrent(0)
        if (ranges.length) {
          setCurrentFindRange(ranges[0])
          scrollRangeIntoView(ranges[0])
        }
      } else {
        const ids =
          query.trim() === ""
            ? []
            : messages
                .filter((m) => findMatchOffsets(m.content, query).length > 0)
                .map((m) => m.id)
        fallbackIdsRef.current = ids
        setTotal(ids.length)
        setCurrent(0)
        if (ids.length) scrollMessageIntoView(ids[0])
      }
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
    // messageCount in deps so streaming re-walks; viewportRef is stable.
  }, [open, query, messageCount, usingApi, messages, viewportRef, scrollRangeIntoView, scrollMessageIntoView])

  const next = useCallback(() => {
    setCurrent((c) => {
      const i = wrapIndex(c, total, 1)
      goTo(i)
      return i
    })
  }, [total, goTo])

  const prev = useCallback(() => {
    setCurrent((c) => {
      const i = wrapIndex(c, total, -1)
      goTo(i)
      return i
    })
  }, [total, goTo])

  const openFind = useCallback((prefill?: string) => {
    setOpen(true)
    if (prefill && prefill.trim() !== "") setQuery(prefill)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setQuery("")
    setTotal(0)
    setCurrent(0)
    rangesRef.current = []
    fallbackIdsRef.current = []
    clearFindHighlights()
  }, [])

  // Safety net: clear highlights on unmount.
  useEffect(() => () => clearFindHighlights(), [])

  return { open, query, setQuery, total, current, next, prev, openFind, close }
}
```

- [ ] **Step 2: Verify**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/client/hooks/use-conversation-find.ts
git commit -m "feat(find): useConversationFind hook (engine + fallback)"
```

---

## Task 4: Find bar component + CSS

**Files:**
- Create: `components/panels/conversation-find-bar.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: the hook's API shape (`query`, `setQuery`, `total`, `current`, `next`, `prev`, `close`).

> Not render-tested. Verify with `bun run check`.

- [ ] **Step 1: Add the CSS**

Append to `app/globals.css`:

```css
/* In-conversation find (⌘F) highlights. No DOM mutation — these style
   ranges registered via the CSS Custom Highlight API. */
::highlight(hb-find-all) {
  background: color-mix(in srgb, gold 55%, transparent);
}
::highlight(hb-find-current) {
  background: color-mix(in srgb, orange 70%, transparent);
}
/* Fallback flash for browsers without CSS.highlights — a brief ring on
   the jumped-to message. */
.hb-find-flash {
  animation: hb-find-flash 1.2s ease-out;
  border-radius: 0.375rem;
}
@keyframes hb-find-flash {
  0% { box-shadow: 0 0 0 2px color-mix(in srgb, orange 70%, transparent); }
  100% { box-shadow: 0 0 0 2px transparent; }
}
```

- [ ] **Step 2: Create the bar**

Create `components/panels/conversation-find-bar.tsx`:

```typescript
"use client"

import { useEffect, useRef } from "react"
import { ChevronDown, ChevronUp, X } from "lucide-react"

import { cn } from "@/shared/utils"
import { Button } from "@/components/ui/button"

export function ConversationFindBar({
  query,
  setQuery,
  total,
  current,
  next,
  prev,
  close,
}: {
  query: string
  setQuery: (q: string) => void
  total: number
  current: number
  next: () => void
  prev: () => void
  close: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      if (e.shiftKey) prev()
      else next()
    } else if (e.key === "Escape") {
      e.preventDefault()
      close()
    }
  }

  const count = query.trim() === "" ? "" : total === 0 ? "No results" : `${current + 1} / ${total}`

  return (
    <div className="absolute right-4 top-2 z-20 flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--popover)] px-2 py-1 shadow-md">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in conversation…"
        className="w-48 bg-transparent text-sm outline-none placeholder:text-[var(--muted-foreground)]"
      />
      <span
        className={cn(
          "min-w-[3.5rem] text-right text-[11px] tabular-nums",
          total === 0 && query.trim() !== ""
            ? "text-[var(--destructive)]"
            : "text-[var(--muted-foreground)]",
        )}
      >
        {count}
      </span>
      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={prev} disabled={total === 0} aria-label="Previous match">
        <ChevronUp size={14} />
      </Button>
      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={next} disabled={total === 0} aria-label="Next match">
        <ChevronDown size={14} />
      </Button>
      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={close} aria-label="Close find">
        <X size={14} />
      </Button>
    </div>
  )
}
```

- [ ] **Step 3: Verify + commit**

Run: `bun run check`
Expected: PASS.

```bash
git add components/panels/conversation-find-bar.tsx app/globals.css
git commit -m "feat(find): ConversationFindBar + highlight CSS"
```

---

## Task 5: Wire ⌘F into the chat panel

**Files:**
- Modify: `components/panels/chat.tsx`

**Interfaces:**
- Consumes: `useConversationFind` (Task 3), `ConversationFindBar` (Task 4). Uses the existing `messagesEndRef` (from `useChatScroll`), `messages` (the memoized array, ~line 247), `activeConversation`, and `captureSelectionSnapshot`.

> Not render-tested. Verify with `bun run check` + the runbook.

- [ ] **Step 1: Imports + hook wiring**

In `components/panels/chat.tsx`:

1. Add imports:

```typescript
import { useConversationFind } from "@/client/hooks/use-conversation-find"
import { ConversationFindBar } from "@/components/panels/conversation-find-bar"
import { captureSelectionSnapshot } from "@/client/selection/snapshot"
```

(Confirm the `captureSelectionSnapshot` import path by checking how
`components/command-palette.tsx` imports it; match that path exactly.)

2. Instantiate the hook after `messages`/`messagesEndRef` are in scope
   (the hook reuses `messagesEndRef` to find the viewport):

```typescript
  const find = useConversationFind({
    viewportRef: messagesEndRef,
    messageCount: messages.length,
    messages,
  })
```

- [ ] **Step 2: ⌘F keydown listener**

Add a `useEffect` (mirroring the ⌘K pattern). It must fire only when the
chat view is active and a conversation is open:

```typescript
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key?.toLowerCase() === "f") {
        if (!activeConversation) return
        e.preventDefault()
        const snap = captureSelectionSnapshot()
        find.openFind(snap?.text)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [activeConversation, find])
```

(If `captureSelectionSnapshot` returns a different shape than `{ text }`,
read its definition and pass the plain selected-text string; the prefill
is just `string | undefined`.)

- [ ] **Step 3: Render the bar**

Inside the messages-column `<div className="flex flex-col flex-1 min-w-0 min-h-0 relative">`
(the one at ~line 768, which is already `relative`), render the bar when
open — place it as the first child (it's `absolute`-positioned, so order
doesn't affect layout):

```tsx
{find.open && (
  <ConversationFindBar
    query={find.query}
    setQuery={find.setQuery}
    total={find.total}
    current={find.current}
    next={find.next}
    prev={find.prev}
    close={find.close}
  />
)}
```

- [ ] **Step 4: Verify**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/panels/chat.tsx
git commit -m "feat(chat): wire Cmd-F in-conversation find"
```

---

## Task 6: Manual-test runbook

**Files:**
- Create: `docs/SMOKE-TEST-in-conversation-find.md`

- [ ] **Step 1: Write the runbook**

Create `docs/SMOKE-TEST-in-conversation-find.md`:

```markdown
# Smoke test — in-conversation Find (⌘F)

Manual checks (need a running app: `bun dev`, a chat with several
messages). Use a modern browser (Chromium/Safari/Firefox) for the
highlight path.

1. [ ] **Open + intercept.** In an open conversation press ⌘F (Ctrl+F on
   Windows/Linux). The find bar appears top-right of the messages column;
   the **browser's** native find does NOT open.
2. [ ] **Highlight all + current.** Type a word that appears several
   times. Every occurrence is highlighted (gold); the active one is
   emphasized (orange); the count shows `1 / N`.
3. [ ] **Navigate + wrap.** `Enter` (and the ↓ button) moves to the next
   match, scrolling it into view; at the last it wraps to the first.
   `Shift+Enter` / ↑ goes backward and wraps.
4. [ ] **No results.** Type gibberish → "No results"; nav buttons
   disabled; no highlights.
5. [ ] **Prefill from selection.** Select some text in a message, then
   ⌘F → the query is pre-filled with the selection.
6. [ ] **Close.** `Esc` (or ✕) closes the bar and clears all highlights.
7. [ ] **Streaming.** Open find, then send a message; as the reply
   streams, matching new text becomes findable (count updates).
8. [ ] **Citations intact.** Search text in an assistant message that has
   `[1]`-style citation buttons → highlighting does not break or
   duplicate the citation buttons (no DOM mutation).
9. [ ] **Scope.** ⌘F while NOT in the chat view (or with no conversation)
   → the browser's native find still works (we don't intercept).
```

- [ ] **Step 2: Commit**

```bash
git add docs/SMOKE-TEST-in-conversation-find.md
git commit -m "docs: smoke-test runbook for in-conversation find"
```

---

## Final verification (after all tasks)

- [ ] `bun run check && bun run test` — typecheck + lint clean; all tests pass (the intentional `postgres unreachable` throw at `route.handler.test.ts:240` is NOT a failure).
- [ ] Manual: follow `docs/SMOKE-TEST-in-conversation-find.md`.

---

## Self-Review

**Spec coverage:**
- `findMatchOffsets` + `wrapIndex` pure helpers → Task 1. ✓
- CSS Custom Highlight API engine (DOM walk, ranges, no mutation) → Task 2. ✓
- `useConversationFind` (debounced re-walk on query/open/messages, nav, scroll, cleanup, fallback) → Task 3. ✓
- `ConversationFindBar` (input, count, prev/next, Esc/Enter/Shift+Enter, close) → Task 4. ✓
- `::highlight` CSS + fallback flash → Task 4. ✓
- ⌘F wiring (preventDefault, chat-active+conversation gate, selection prefill) → Task 5. ✓
- Fallback when `CSS.highlights` absent → Tasks 2 (guards) + 3 (message-level path). ✓
- No backend/store/schema change → none in any task. ✓
- Runbook → Task 6. ✓

**Type consistency:** `findMatchOffsets(haystack, needle): number[]` + `wrapIndex(current, total, dir): number` (Task 1) are consumed in Task 2 (offsets) and Task 3 (wrap + fallback filter). `computeFindRanges(root, query): Range[]` / `setCurrentFindRange(range)` / `clearFindHighlights()` / `supportsHighlightApi()` (Task 2) are consumed by the hook (Task 3). The hook's returned shape (`open, query, setQuery, total, current, next, prev, openFind, close`) matches the bar's props (Task 4) and the chat wiring (Task 5). The bar consumes everything except `open`/`openFind` (chat uses those).

**Placeholder scan:** none — every code step carries complete code. The only conditional instructions ("confirm the `captureSelectionSnapshot` path", "add the ambient declaration only if typecheck complains") are explicit fallback directions with the exact code to use, not deferred work.
