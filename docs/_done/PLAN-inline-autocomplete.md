# Plan: Inline editor ghost-text autocomplete

Status: **✅ shipped** — [#186](https://github.com/juchengquan/hummingbird/pull/186)
on 2026-06-11. Plate's already-installed `CopilotKit` plugin wired to a
new streamed `/api/ai/complete` route (`maxOutputTokens: 60`, `temp:
0.2`, default `google/gemini-2.5-flash`), per-IP 60/min sliding window.
Per-user **opt-in toggle** in the account menu (Wand2 icon →
`editorPrefs.inlineComplete: boolean`, default off); `STORE_VERSION`
25 → 26 with a backfill migration. The dead `/api/ai/copilot` template
stub deleted. Two commits: route + prompt builder + schema + tests
(commit 1), CopilotKit wire + toggle (commit 2). Origin: the 2026
Copilot-for-prose bar — see [Sources](#sources).

## Why

The 2026 bar for a writing surface is Copilot-style **ghost text** —
inline grey completions that appear as you pause and accept with Tab.
Hummingbird's editor has AI *commands* (generate/edit/comment on
request) but no *ambient* completion as you type.

The lift is unusually small because the survey confirmed Plate's
`EditorKit` (`components/editor/editor-kit.tsx`) **already bundles
`CopilotKit`** (and `CursorOverlayKit`). The plugin exists; it's just
not wired to a completion endpoint. So this is "activate + tune the
installed plugin," not "add autocomplete from scratch."

## Non-goals — what this is NOT

- **Not a new AI subsystem.** Reuses Plate's Copilot plugin + the
  existing fast-model provider path.
- **Not chat autocomplete.** Editor document only — the chat composer
  keeps its current behaviour.
- **Not multi-line block generation.** Ghost text completes the current
  phrase/sentence; whole-section drafting stays the `generate` command.
- **Not always-on by default in a way that surprises users.** A clear
  per-document toggle; opt-in default TBD (see open questions).

## Decisions to pin before code

1. **Model.** The fast model the editor already uses for selection edits
   (`google/gemini-2.5-flash` class) — low latency is the whole point.
   Same provider path, no new env.
2. **Trigger + accept.** Debounced on typing pause (~400 ms); ghost text
   on completion; **Tab** accepts, any keystroke dismisses (Plate
   Copilot's built-in interaction).
3. **Context window.** Send the current block + a bounded prefix of the
   document (not the whole doc) — latency + cost. Cap at ~1–2k tokens of
   preceding context.
4. **Endpoint shape.** A dedicated lightweight completion route
   (`app/api/ai/complete/route.ts`) separate from the command route —
   it returns a *single short continuation*, not a structured command.
   Streamed for first-token speed.
5. **Cost control.** Debounce + a short max-output (≤ 60 tokens) +
   the per-IP budget gate. Off when the document is idle.
6. **Toggle storage.** `editor.inlineComplete: boolean` in the ui slice
   (existing pattern, like the diff-mode toggle); no migration.

## Shape — code surface

### Route — `app/api/ai/complete/route.ts` (new)

A minimal handler: `{ prefix, blockText, model? }` → streamed text
continuation via `streamText` with a tight token cap + temp ~0.2. A
pure `getCompletePrompt(prefix, blockText)` builder under
`app/api/ai/command/prompt/` ("continue the user's text naturally; emit
only the continuation, no preamble").

### Client — wire the Copilot plugin

`components/editor/editor-kit.tsx` — configure the already-present
`CopilotKit` with a `getNextCompletion` that calls `apiUrls.aiComplete()`
(new entry in `lib/client/api-client.ts` `apiUrls`). Respect the
`editor.inlineComplete` toggle.

### Settings — toggle

The editor preferences surface gains **"Inline autocomplete (ghost
text)"** with a tooltip on latency/cost; stored in the ui slice.

## Sequencing — one PR, two commits

1. **Commit 1 — completion route + prompt builder.** The
   `/api/ai/complete` route, the pure prompt builder + its test, the
   `apiClient`/`apiUrls` entry, the request schema in
   `lib/shared/api-schemas.ts`.
2. **Commit 2 — wire Copilot + toggle.** Configure `CopilotKit` against
   the route; the settings toggle + ui-slice field; debounce + budget.

## Tests

- **`getCompletePrompt` (commit 1)** — interpolates prefix + block;
  instructs "continuation only." Snapshot + interpolation assertions.
- **Schema (commit 1)** — request validates; over-long prefix is
  truncated.
- **Manual smoke (commit 2)** — type a sentence, pause, see ghost text;
  Tab accepts; typing dismisses; toggle off disables it; budget
  exhaustion silently stops suggesting (never errors mid-type).

## Open questions before commit 1

1. **Default on or off?** Ghost text divides users. **Default: OFF
   initially (opt-in), revisit once latency/quality are confirmed
   good.**
2. **Whole-document vs block context.** **Default: current block + ~1k
   tokens of preceding text; never the whole doc (latency).**
3. **Multi-suggestion cycling.** Plate Copilot can offer alternatives.
   **Default: single suggestion in v1; cycling later if asked.**

## Reopen / future work

- **Local model option** — route completions to an Ollama fast model
  for a zero-cost/private autocomplete (pairs with the Ollama provider).
- **Personalised tone** — bias completions toward the workspace voice /
  persona prompt.
- **Whole-line vs next-word acceptance** — partial-accept (accept one
  word) like VS Code.

## Sources

- [Ghost-text autocomplete for writing (2026)](https://gentext.ai/blog/en/ghost-text-autocomplete-academic-writing/)
- [Copilot inline suggestions](https://code.visualstudio.com/docs/editing/ai-powered-suggestions)
