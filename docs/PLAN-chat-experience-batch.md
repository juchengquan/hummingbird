# Plan: Chat experience batch — markdown bubbles, vision, system prompts

## Context

Coming off a product audit on `claude/dev-followups` (post-merge of the chat-overhaul PR). Three changes that materially improve the chat experience without committing to a strategic direction. All three are "no-regret" — they make sense whatever vertical / collaboration / local-first direction the product eventually picks.

Three independent commits, in order of risk (low → medium). Each can ship on its own.

## 1. Streaming markdown in chat bubbles

**Problem.** Assistant messages render as `<p className="text-sm whitespace-pre-wrap">{message.content}</p>` in `components/panels/chat-message.tsx:~377`. The model returns markdown with tables, code blocks, lists, headings — we render the source as plain text. Meanwhile `components/markdown-preview.tsx` already does proper rendering (via `marked`, already a transitive dep) and we use it for markdown-kind artifacts. The chat bubble is the highest-traffic surface in the app and it's the worst-rendered.

**Approach.**

- Reuse `MarkdownPreview` for assistant message content. User messages stay as plain `<p>` (no point parsing user input).
- Render markdown unconditionally during streaming. `marked` is fast enough that re-parsing on every token won't be perceptible, and `useMemo` already caches per content value. Partial fences just render as text until they close — acceptable.
- Add a chat-bubble-friendly variant of the markdown CSS. The current rules style `pre` with `background: var(--secondary)`, which is the assistant bubble's bg — code blocks would be invisible. Either a `.chat-markdown` class with overrides or pass through a different background variable.
- Skip markdown rendering when `message.error` is set (the ErrorBubble owns its own UI) and when `isEditing` (user is editing in a textarea).

**Critical files.**
- `components/panels/chat-message.tsx` — swap the `<p>` for `<MarkdownPreview>` in the assistant non-error path
- `components/markdown-preview.css` — add a `.chat-bubble` variant (or new component variant) with a darker code-block background

**Out of scope.** Streaming code-block highlighting in the bubble (we already do this in the artifact preview; bubble keeps plain `<pre>` from marked).

## 2. Vision image input

**Problem.** `lib/upload-config.ts` accepts `.png/.jpg/.jpeg`. The `+` button uploads them. They go into the workspace files panel. Then nothing — `/api/extract` returns `kind: 'unsupported'`, `app/api/chat/route.ts`'s `buildSystemPrompt` skips files without text, and the chat request body only carries `{ name, size, type, text }`. Three of the models we already list (Claude Sonnet 4.5, GPT-4o, Gemini 2.5 Pro) support vision. Today the image-upload UI is dead weight.

**Approach.**

- Detect images at upload time (in `lib/file-utils.tsx`'s `processSelectedFiles` or in `lib/extract.ts`'s `runExtraction`). For image MIME types, read as a base64 data URL via `FileReader` and store on `UploadedFile.imageDataUrl`.
- Add `imageDataUrl?: string` to `UploadedFile` in `lib/types.ts`. Persisted in localStorage like everything else.
- In `components/panels/chat.tsx`'s `callChatAPI`, when building the request: for the most recent user message, if the active conversation has selected image files, transform that message's content into a multimodal `content` array (`[{ type: 'text', text: ... }, { type: 'image', image: dataUrl }, ...]`). Past messages keep their text-only form (no point re-sending images on every turn, and would explode the token bill).
- Server-side `app/api/chat/route.ts`: the AI SDK's `streamText` accepts multimodal `ModelMessage` natively — `messages: body.messages` already passes them through. The route's type annotation needs to widen to accept the array variant. `buildSystemPrompt` doesn't need to change (images aren't text).
- The extraction route stops returning `unsupported` for images — instead returns a noop success (`kind: 'image'`, empty text, not truncated) so the status badge shows nothing weird.

**Critical files.**
- `lib/types.ts` — add `imageDataUrl?: string` to `UploadedFile`
- `lib/file-utils.tsx` or `lib/extract.ts` — read image as data URL at upload time
- `components/panels/chat.tsx` — transform the outgoing user message when images are attached
- `app/api/chat/route.ts` — widen `messages` type to accept multimodal `ModelMessage`
- `app/api/extract/route.ts` — return success (no text) for image MIME types instead of `unsupported`

**Caveats.**
- localStorage bloat. A 1 MB JPEG is ~1.4 MB base64. Combined with the existing 5 MB file-size cap, a single upload can consume a quarter of the localStorage quota. **Limit images to 2 MB at upload time** to keep the headroom usable. Document this as a known constraint until Supabase Storage migration moves binary files server-side.
- Historical context. Past user messages won't visually show which images were attached when sent. Adding a `Message.attachedFileIds?: string[]` snapshot is a small follow-up but out of scope here.
- Only the last user message gets images forwarded. Re-sending images on every turn would blow the token budget and isn't how ChatGPT/Claude.ai handle attachments either.

## 3. Custom system prompts per workspace

**Problem.** Workspaces today carry a name and a creation timestamp — nothing else. They function as a folder. Adding per-workspace system prompts is the cheapest "make workspaces feel like a real concept" change available.

**Approach.**

- Add `systemPrompt?: string` to `Workspace` in `lib/types.ts`. Persisted via the existing partialize.
- Store version bump 4 → 5 in `lib/hooks/use-store.ts` with a migration that backfills `systemPrompt: ''` on each existing workspace.
- Add a textarea to the workspace edit UI in `components/panels/workspaces.tsx`. Per-workspace, with a "save" action that updates the store.
- New mutator `setWorkspaceSystemPrompt(workspaceId, prompt)`.
- Client side in `components/panels/chat.tsx`'s `callChatAPI`: read the active workspace's `systemPrompt` and include it in the request body as `workspaceSystemPrompt`.
- Server side in `app/api/chat/route.ts`: accept `workspaceSystemPrompt?: string` in the body and **prepend** it to the base system prompt in `buildSystemPrompt`. Empty string is a no-op.

**Critical files.**
- `lib/types.ts` — add `systemPrompt?: string` to `Workspace`
- `lib/hooks/use-store.ts` — partialize already covers it; add `setWorkspaceSystemPrompt` mutator; bump version to 5 with v4→v5 migration
- `components/panels/workspaces.tsx` — textarea in the workspace edit row / modal
- `components/panels/chat.tsx` — include `workspaceSystemPrompt` in chat request body
- `app/api/chat/route.ts` — `ChatRequestBody` gains `workspaceSystemPrompt?: string`; `buildSystemPrompt` prepends it

**Out of scope.** Per-conversation override of workspace prompt (would compound complexity — defer until anyone asks). Templating / variables in the prompt. Validation / length cap (rely on token-budget feedback from the model for now).

## Order

1. Markdown bubbles — touches only `chat-message.tsx` + CSS. Lowest risk. Visible immediately.
2. System prompts — small, isolated, requires a migration. Medium risk (migration must not break anything).
3. Vision input — touches store, upload flow, chat client, and chat route. Highest risk.

Splitting into three commits so each can be reviewed in isolation; if any one is rough, the other two still ship.

## Verification

Each commit gets type-checked (`bunx tsc --noEmit`) and dev-server smoke-tested (`bun dev`, `/dashboard` returns 200, `/api/chat` returns 401 with the expected JSON shape when no key is set). Interactive checks I cannot drive from here, to be done in the browser:

- **Markdown bubbles** — send a prompt that returns a markdown table, a fenced code block, a numbered list, a heading. Expected: each renders properly inside the assistant bubble.
- **System prompts** — set a distinctive prompt on a workspace (`"Always answer in haiku."`), send a message, confirm the model obeys. Switch workspace, confirm the new workspace's prompt takes effect.
- **Vision input** — set `AI_GATEWAY_API_KEY`, pick a vision-capable model (Claude Sonnet 4.5 / GPT-4o / Gemini 2.5 Pro), attach a small image via the `+` button, ask "what's in this image?". Expected: the model describes the image. Confirm images >2 MB are rejected with a toast. Confirm non-vision models (e.g. `deepseek/deepseek-r1`) still work for text-only chat.

## Followups (not in this batch)

- Snapshot `attachedFileIds` on each Message so chat history shows image chips
- Compress images client-side before base64 (for >1 MB JPEGs)
- Per-conversation system prompt override
- Move binary file storage to Supabase Storage (blocked on project provisioning — see `docs/ROADMAP.md` Phase 1)
