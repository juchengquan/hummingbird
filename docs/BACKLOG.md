# Feature backlog

Distinctive feature ideas — not yet planned, not yet started, not just
catch-up with other AI chat apps. Each entry has rough effort, what
makes it distinctive, and pointers to existing surfaces it would build
on.

Living document: when an item moves to "planned", it gets its own
`PLAN-*.md` file and the row here links to it.

---

## ~~Conversation graph view~~ ✅ shipped (`5666f0b`)

Indented tree dialog accessible from the chat-header kebab → Branches.
Cards show title + msg count + branch-point snippet; click to switch.
`Conversation.parentId` + `forkedFromMessageId` added via migration
`0009_conversation_lineage`. `forkConversation` records lineage going
forward.

---

## Cross-conversation memory with retrieval

**Why distinctive.** Solves "the model forgets between chats" with a
proper retrieval layer instead of a hand-curated "memories" list. Few
AI chat apps do this well; the ones that do (Mem, Pi) are entire
products built around it.

**Sketch.**
- Embed every persisted message with a small model
  (`text-embedding-3-small` or open-weight). Store the vector in a
  new `message_embeddings (message_id, embedding vector(1536))` table.
- New `/api/recall` route: takes the user's current question, returns
  the top-K past messages by cosine similarity, scoped to the user.
- Surface as either:
  - **A `memoryRecall` skill** in the Skills cascade — when on, every
    chat turn prepends "From your past conversations: …" to the
    system prompt with the top-3 hits.
  - **A "Related" strip** under the chat input showing 1–3 past
    conversation cards the user can click to include explicitly.

**Builds on.** Skills surface (`lib/skills/registry.ts`),
`messages` table, the chat route's system-prompt assembly.

**Effort.** Large (~500–700 lines + ops). Requires `pgvector`
extension in Supabase, an embedding budget (cheap, but real),
async embedding pipeline (don't block chat saves). Phase 1 could
gate this behind a per-user toggle in AccountMenu to control
embedding cost.

---

## ~~Inline citations from web search~~ ✅ shipped

- `ToolCallRecord` now carries `results?: ToolCallResult[]` (title /
  url / snippet). Server includes them in the `tool_result` SSE frame
  for `webSearch`; client persists onto the message so they survive
  reload.
- System prompt instructs the model to cite using `[N]` markers in the
  order results were returned.
- `MarkdownPreview` decorates in-range `[N]` markers into clickable
  buttons; out-of-range (model hallucinated index) stays plain text.
- New `components/panels/sources-strip.tsx` renders a horizontal
  scrollable strip of source cards (favicon + domain + title +
  snippet + `[N]` corner badge) below the assistant message. Cards
  are inline at ≤2 sources, snap-scrolling carousel at ≥3, with
  peek-next-card and chevron buttons on `md+`. Clicking a `[N]`
  marker scrolls the matching card into view and flashes a ring.
- `docs/API.md` updated with the new optional `results` field on
  `tool_result` frames.

**Deferred.** Hover-cards on the `[N]` markers themselves. The strip
already shows the snippet, so cards may be redundant; revisit if user
testing shows the inline marker without context is too opaque.

---

## Long-running task mode

**Why distinctive.** Most chat apps are turn-based: prompt → answer →
done. Long-running tasks ("research the top 10 React frameworks and
write a comparison") need an async-task surface with progress
visibility. Differentiator vs chat-only apps; positions Hummingbird
closer to an agent surface.

**Sketch.**
- New `tasks` table: `{ id, user_id, conversation_id, status, goal,
  started_at, finished_at }`.
- A "Run as task" toggle on the input bar (or per-prompt slash command
  `/task`). When on, the message is dispatched to a server worker that
  runs `streamText` in a loop, calling tools (web search, page fetch,
  …) until either the model emits a "done" signal or a step cap hits.
- The chat shows a **task strip** at the top of the conversation with
  live progress ("Step 3 of N · Searching the web for X…") and a
  Cancel button. Final result lands as a normal assistant message
  when done.
- Notification when the task finishes (browser notification + a small
  badge on the conversation sidebar entry).

**Builds on.** Skills cascade, `stopWhen: stepCountIs(N)` (already in
chat route), live tool-call strip.

**Effort.** Large (~600+ lines plus a worker process or Vercel
background function). Probably needs a queue (Supabase pg-boss or
Inngest). Requires careful think on what happens when the user closes
the browser mid-task.

---

## Workspace canvas

**Why distinctive.** Combines the editor, chat, and artifacts into a
freeform drag-and-drop canvas where messages, artifacts, and files
become movable cards. Lets the user spatially organize a research
session instead of scrolling through linear chat.

**Sketch.** A new view alongside Workspaces / Chat / Editor. Canvas
backed by `react-flow` or `tldraw`. Each node carries a `kind`:
`chat-message`, `artifact`, `file`, `note`. Drag to rearrange; arrows
between nodes capture relationships. Persisted as JSON on the
workspace row (or a new `canvas_state jsonb`).

**Builds on.** Existing artifacts + notes + per-conversation editor
doc + chat messages — same data already exists; this is a different
spatial *view* of it.

**Effort.** Large (~800+ lines), but ships independently — doesn't
change anything else.

---

## ~~Annotated PDF viewer~~ ✅ shipped (`a1fcc45`)

Sheet from the right edge rendering the PDF via pdfjs-dist (legacy
build, worker inline). Toolbar: page nav, zoom (50–300%), close.
`[p.N]` citation markers in assistant messages become clickable pills
that open the viewer at that page; the cited PDF is resolved per
assistant message by walking back to the nearest user message with a
PDF in `attachedFileIds`. System prompt instructs the model to cite
pages when any attached file's kind is 'pdf'.

Stretch items not yet shipped: text highlighting within the page,
side-by-side layout option, multi-PDF disambiguation (citation
`[file.pdf, p.4]`).

---

## Project mode

**Why distinctive.** Promote a workspace to a "project" with a goal, a
small set of milestones, and AI that helps move items through a
Kanban-style task surface. Combines the workspace + tasks + AI agent
patterns into one product surface.

**Sketch.** New optional fields on `Workspace`: `goal text`,
`milestones jsonb`. A new "Tasks" tab in the right sidebar with
columns (To-do / In progress / Done). AI can be asked to break down
the goal into tasks; each task card can be "worked on" by spawning a
long-running task (above) that returns an artifact.

**Builds on.** Workspace system prompts, workspace skill prefs,
artifacts, long-running task mode (depends on it).

**Effort.** Very large (~1,000+ lines). Effectively a sub-product.
Defer until long-running tasks land.

---

## Diff mode for documents

**Why distinctive.** Editor docs are per-conversation. When AI suggests
changes via the Editor, today they're applied in place. A diff mode
would show before/after with accept/reject per chunk — like
GitHub's PR review for chat-driven writing.

**Sketch.** When an AI command modifies the editor doc, snapshot the
pre-change content; render the post-change content with a side-by-side
or inline diff (`diff-match-patch`) and Accept / Reject buttons per
hunk. Accepted hunks merge into the doc; rejected ones revert.

**Builds on.** Editor (Plate.js), `setConversationDocument`, the
existing AI command routes (`/api/ai/command`).

**Effort.** Medium (~300–400 lines). `diff-match-patch` is small.

---

## ~~Pinned default model per workspace~~ ✅ shipped (`624558e`)

`Workspace.defaultModel` + a Select on the Workspaces panel card.
Switching into a workspace auto-applies the pinned model unless the
user has touched the chat-input picker this session
(`sessionModelOverridden` flag). Cascade: session-picked →
workspace.defaultModel → global `DEFAULT_CHAT_MODEL`. Migration
`0010_workspace_default_model.sql`.

---

## ~~Smart context-window indicator~~ ✅ partially shipped

The meter itself shipped: `components/panels/context-meter.tsx` renders
a `12k / 200k` chip next to the model picker, color-coded muted →
amber → red via `contextZone` in `lib/shared/tokens.ts`.
`contextWindow` added to each entry in `lib/shared/models.ts`. Token
count uses a chars/4 heuristic (see the file-level comment for why
not a real tokenizer).

**Still open (deferred):**
- A "Summarize older messages" button when in the danger zone that
  compresses the first N messages into a single recap via a quick
  `generateText` call. Skipped in v1 because it's a separate concern
  with its own UX (which messages get summarised? how is the recap
  presented? does it edit history or insert a synthetic message?).
- Accurate per-family token counting. The heuristic is fine for a
  "you're getting close" cue but undercounts code/JSON heavy chats.
  Would need `js-tiktoken` for OpenAI, separate encoders for
  Claude/Gemini.

---

## Slash commands for skill chaining

**Why distinctive.** Power-user input shortcut that composes with the
Skills system. Lets users explicitly request specific capabilities
without going through the Skills tab.

**Sketch.** Type `/search latest React 19 changes` → the message
sends with Web Search on for this turn even if the chip is off. Other
slashes: `/image <prompt>`, `/code <task>`, `/explain <selection>`.
Autocomplete dropdown under the input as the user types `/`.

**Builds on.** Skills cascade, per-message skill override (already
shipped in `55064a8`).

**Effort.** Small-to-medium (~200 lines).

---

## Prompt library

**Why distinctive.** Saved templates with variables, surfaced via
`/<name>` autocomplete in the chat input. Power-user feature; absent
today.

**Sketch.** `prompts` slice: `{ id, name, template, variables[] }`.
Typing `/<name>` in the input expands the template (with placeholder
inputs for variables). Manage from a new dialog opened from the chat
header kebab.

**Builds on.** Chat input, store / sync layer (would need a new
`prompts` table + sync handler).

**Effort.** Medium (~300 lines).

---

## What's NOT here

Catch-up features that are table stakes for AI chat apps in 2026 —
worth shipping eventually but not "distinctive":

- Image generation
- Voice input (Whisper)
- Semantic search in `⌘K` (already partially covered if cross-conv
  memory ships)
- Browser extension
- Quick actions on selected text
- Side-by-side model comparison
- Mobile PWA install + offline drafting
- Weekly digest emails

These are tracked informally — pick them up if a user explicitly asks
or a particular need arises.
