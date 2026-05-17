# Branch Analysis: Recommended New Functionalities

## Context

The branch `claude/analyze-codebase-improvements-bYvAH` currently sits on top of two recent feature commits:

- **62c7637** — refactored types/hooks to introduce workspaces, resources, and uploadthing-based file upload; added two real AI API routes (`/api/ai/command`, `/api/ai/copilot`) for the Plate.js editor.
- **790827a** — moved `selectedFileIds` from session-level state onto each `Conversation`, and rebuilt the chat panel as a two-column layout with `ChatResourcesPanel` for per-conversation file attachment.

After this work, the **editor side** of the app has real LLM integration via the AI Gateway (`@ai-sdk/gateway`, `streamText`, tools for comment/table). The **chat side**, by contrast, is still a UI shell: `simulateAIResponse()` in `components/panels/chat.tsx:90` returns a random hard-coded string with a 300 ms `setTimeout` — there is no LLM call, no streaming, and no use of the attached files even though the per-conversation attachment plumbing now exists. Most store mutators (`updateMessage`, `deleteMessage`) also have no UI bindings.

This plan is **recommendations only** — a prioritized list of new functionalities to consider next, with rationale and pointers to the existing code each idea would build on. No implementation is included.

## Recommended new functionalities

Ordered roughly by leverage (impact ÷ effort), given what already exists in the branch.

### 1. Real chat AI integration (highest leverage)

The biggest gap: chat is the headline feature but currently fake. Everything needed to make it real already exists in the codebase.

- **Replace** `simulateAIResponse()` in `components/panels/chat.tsx:90-119` with a streamed call to a new route `app/api/chat/route.ts`.
- **Reuse** the AI Gateway setup pattern from `app/api/ai/command/route.ts:55-57` (`createGateway({ apiKey })`) and `app/api/ai/copilot/route.ts` — same env var (`AI_GATEWAY_API_KEY`), same `streamText` from `ai`.
- **Reuse** `markdownJoinerTransform` from `lib/markdown-joiner-transform.ts` as `experimental_transform` so streamed markdown renders cleanly.
- **Wire in attachments**: the active conversation's `selectedFileIds` (added in 790827a, stored on `Conversation` in `lib/types.ts`) should be resolved to `Resource`/`UploadedFile` objects and injected into the system prompt or message content. Files already flow through `app/api/uploadthing/route.ts` — surface text/PDF content (or at least file metadata) to the model.
- **Streaming UX**: update the assistant message in place as tokens arrive instead of using the all-at-once `addMessage` + `isTyping` flag at `components/panels/chat.tsx:109-117`. The store already has `updateMessage` — use it.

Critical files: `components/panels/chat.tsx`, `lib/hooks/use-store.ts` (add a streaming-state slice), new `app/api/chat/route.ts`, `lib/types.ts` (consider `Message.status: 'streaming' | 'complete' | 'error'`).

### 2. Message-level actions (low effort, high polish)

The store already exposes `updateMessage` and `deleteMessage`, but no UI calls them. Each chat bubble in `components/panels/chat.tsx:195-242` is a good place to add a hover-revealed action row:

- **Copy** message content (clipboard).
- **Delete** message (calls existing `deleteMessage`).
- **Edit** user message → re-trigger AI from that point (requires "truncate-after" semantics — drop messages after the edited one before re-sending).
- **Regenerate** assistant message — same idea: drop the failed/unwanted message and re-call the chat route.
- **Send to editor** already exists implicitly via `setEditorContent`; expose it as an explicit button per assistant message instead of auto-syncing on every send (`components/panels/chat.tsx:115, 132`), which is currently noisy.

Critical files: `components/panels/chat.tsx`, no store changes needed.

### 3. Search & navigation

Once conversations and messages multiply, navigation becomes painful. There is currently no search anywhere.

- **Conversation search in the sidebar**: filter the list in `components/sidebars/conversation-item.tsx` / the sidebar that renders it. Match on title and (optionally) message content.
- **In-conversation message search**: a `⌘F`-style overlay on the chat panel that highlights and jumps to matches.
- **Global cross-workspace search**: optional, but the store already keys conversations by `workspaceId`, so a flat search across all workspaces is straightforward.
- **Keyboard navigation**: `j`/`k` between conversations, `⌘K` command palette for "new conversation / switch workspace / jump to file". The codebase has no shortcuts beyond the sidebar toggle today — a `cmdk`-style palette would pay for itself quickly.

Critical files: the sidebars under `components/sidebars/`, a new `components/command-palette.tsx`.

### 4. Export & sharing

The app produces two artifact types — conversations and editor documents — but neither can leave the browser.

- **Export conversation** as Markdown (trivial: messages → `# user / # assistant` blocks). Add a button to the conversation header.
- **Export editor document** as Markdown / HTML / DOCX. Plate.js has serializers for Markdown and HTML; DOCX would need an extra dep (e.g. `docx` or server-side conversion).
- **Export as PDF**: cheapest path is browser `window.print()` with a print stylesheet; nicer path is server-side via a headless renderer (heavier).
- **Share link**: requires backend persistence — see "Beyond the four areas" below. Without a backend, a "copy as Markdown to clipboard" button is the realistic v1.

Critical files: new `lib/export/` utilities, buttons in `components/panels/chat.tsx` and `components/panels/editor.tsx`.

### Beyond the four areas (worth flagging)

While exploring, several gaps surfaced that are out of scope for this plan but worth naming so you can decide whether to fold them into a follow-up:

- **No backend persistence** — everything is in `localStorage` (`hummingbird-storage`, version 3 in `lib/hooks/use-store.ts`). Chat history, files, and workspaces are device-local and quota-limited. A real DB + auth would unlock share links, multi-device sync, and larger file storage.
- **File content is never extracted** — uploaded PDFs/DOCXs are stored as blobs; nothing parses them into text, so even after wiring real chat AI, the model would only "see" filenames unless extraction is added (e.g. `pdf-parse`, `mammoth`).
- **No error states** — both AI routes swallow errors into a generic 500 (`app/api/ai/command/route.ts:171-176`); the UI has no surface for "AI failed, retry?".

## Verification

This is a recommendations plan with no code changes, so verification is limited to confirming the analysis itself:

1. `git log --oneline -5` on `claude/analyze-codebase-improvements-bYvAH` shows commits `790827a` and `62c7637` as the latest substantive work — confirms the "what changed" framing.
2. `grep -n "simulateAIResponse\|mock response" components/panels/chat.tsx` confirms the chat panel is still mocked (lines ~90-119).
3. `grep -n "updateMessage\|deleteMessage" components/panels/chat.tsx` returns nothing — confirms message-level actions have no UI today.
4. `ls app/api/` shows `ai/command`, `ai/copilot`, `uploadthing` but no `chat` route — confirms #1 is greenfield.

Next step (when you're ready to implement): pick one of the four items above and ask for a focused implementation plan.

## Status (post-implementation)

All four items have shipped on `claude/analyze-codebase-improvements-bYvAH`:

- **Export & sharing** — `6eef625`: `lib/export.ts`, conversation popover entries, editor toolbar buttons, sonner Toaster.
- **Message-level actions** — `9ee6c6a`: `components/panels/chat-message.tsx`, hover-revealed Copy / Edit / Regenerate / Delete; `truncateMessagesAfter` store action.
- **Search & navigation** — `542dc78`: sidebar chat search input, global ⌘K command palette (`components/command-palette.tsx`).
- **Real chat AI integration** — `2186e11`: `app/api/chat/route.ts` via Vercel AI Gateway, `lib/models.ts` (10 models incl. Qwen + DeepSeek), `chatModel` in the store, streaming `callChatAPI` with mock fallback on 401, provider-grouped model picker; later commit added Stop-button / in-flight cancellation.

## Known follow-ups (not yet scoped)

These surfaced during implementation and remain open. Each is a separate piece of work that should be planned before being picked up.

### 1. File content extraction
Currently the chat route only passes file **metadata** (name, size, type) into the system prompt. The model is explicitly told it does not have file contents and should ask the user to paste in the relevant portions. To make attachments genuinely useful:

- Extract text from common file types at upload time (or lazily on first use):
  - `.txt` / `.md` / `.csv` / `.json` — read as UTF-8 directly.
  - `.pdf` — `pdf-parse` or `pdfjs-dist`.
  - `.docx` — `mammoth` (server-side) for text + light formatting.
  - Images — out of scope unless we add multimodal models.
- Store the extracted text alongside the `UploadedFile` (new `extractedText?: string` field on `lib/types.ts`).
- Update `app/api/chat/route.ts` to send the extracted text in the system prompt, truncated to a budget (e.g. 32k chars total across all attachments, with the model told what was truncated).
- Decide where extraction runs: client-side (smaller deps, no infra) vs server-side route (heavier but consistent).

### 2. Reasoning / thinking token surfacing
Models that emit reasoning (DeepSeek R1, Claude thinking variants, OpenAI o1-style) currently stream their reasoning inline with the answer because we use a plain text stream. To surface them properly:

- Switch the chat route from `.toTextStreamResponse()` to a UI message stream (`createUIMessageStream` + `streamText().toUIMessageStream()`) so reasoning parts come through as distinct stream events.
- On the client, replace the raw `ReadableStream` reader with a parser that distinguishes `text` parts from `reasoning` parts.
- Render reasoning in a collapsible "Thinking…" section above the answer, similar to Claude.ai or ChatGPT, with a toggle to hide.
- Persist reasoning separately from the answer on `Message` (new `reasoning?: string`) so it survives reloads but doesn't leak into Copy / Export by default.

### 3. Backend persistence
Everything lives in `localStorage` under `hummingbird-storage` (version 3, see `lib/hooks/use-store.ts`). This blocks share links, multi-device sync, and large file storage. A real implementation needs:

- Auth: NextAuth / Clerk / Supabase Auth. Probably Supabase for the path of least resistance, since it also covers DB + storage.
- DB schema mirroring `Workspace`, `Conversation`, `Message`, `UploadedFile`, `Resource`. Most tables are obvious; the trickier piece is migrating existing local state on first sign-in.
- File storage: Supabase Storage / S3 / R2. Uploadthing is already used as a transport — its files would move into our bucket.
- Share links: server-rendered read-only conversation/document pages keyed by a public token; revocable in settings.

### 4. Richer error and connectivity states
Today both `app/api/ai/command/route.ts` and `app/api/chat/route.ts` collapse model errors into a generic 500. The chat panel surfaces those as a sonner toast and injects an `_Error: …_` placeholder message. Better UX:

- Distinguish error categories on the server: missing key (401), rate limit / quota (429), provider outage (5xx upstream), invalid model id (400), aborted (408).
- On the client, render the error inside the placeholder bubble with a **Retry** button (re-call `callChatAPI` with the same history) and a **Change model** shortcut.
- Surface the model id and HTTP status in a small "details" disclosure so users can self-diagnose.
- For aborted requests (Stop button), drop the placeholder entirely instead of leaving an "_Error_" line.

