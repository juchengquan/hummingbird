# Plan: Aider-style architect / editor pair for Plate.js AI edits

Status: **⏸ deferred / low priority** (deprioritised in the 2026-06-09
market refresh — see [MASTER_PLAN § Parked / low priority](MASTER_PLAN.md#parked--low-priority)).
The single-call Plate edit path + the shipped diff-review surface
(#49) work today; the two-call planner/editor split is a quality
optimisation, not a gap. **Re-open when** structured-patch edit quality
becomes a measured pain point, or the code-interpreter work makes a
fast-model patch loop cheap to reuse. The plan below is preserved as-is.
Item #11 from `docs/PLAN-cross-product-inspirations.md`. Scope: **S–M**
(one PR, plan-then-ship in one session).

## Why

The editor's AI command surface (`app/api/ai/command/route.ts`)
runs one model call per intent: `chooseTool` →
`generate`/`edit`/`comment`, with the tool's model fixed in code
(`openai/gpt-5.5` for generate/edit, `google/gemini-2.5-flash`
for selection-mode edits). One model has to do everything —
parse the intent, decide *what* to change, and emit the *exact*
new text. The result is what users describe as "good but
expensive" — Sonnet-class output, Sonnet-class billing on every
keystroke-triggered edit.

Aider's split:

1. **Architect** — a strong reasoning model (Sonnet, GPT-5)
   emits a short natural-language plan describing *what changes
   to make*. It doesn't write the final text.
2. **Editor** — a fast cheap model (Haiku, GPT-5-mini) emits
   structured search/replace patches against the source. It
   doesn't reason; it follows the plan.

The same pattern transplants to the Plate.js editor with two
wins:

- **Cost** — fast-model token rate is ~10× cheaper than the
  strong model. Most of the output tokens flow through the
  fast path.
- **Reliability** — fast models reliably emit structured edits
  (search/replace patches) but flail on open-ended generation.
  Strong models reliably reason but waste tokens on rote
  transformations. The split plays to each.

The cohort survey ranked this as M because the editor already
ships a diff-mode review surface (`PLAN-editor-diff-mode.md`,
#49) — patches go straight into that surface unchanged. The
architect/editor split adds **one extra model call per edit**
in exchange for cheaper, more reliable patches.

## Non-goals — what this PR is NOT

- **Not a redesign of the chat-route AI command surface.** Chat
  turns continue to use a single model — they're conversational,
  not "apply this edit." The split is specific to **edit** mode
  in the editor.
- **Not a generic "agentic editor."** No multi-step planning,
  no tool use, no file-tree awareness. Two model calls per edit,
  done.
- **Not a replacement for the existing diff-mode review.** The
  editor surface (accept/reject per chunk) stays as-is; patches
  flow into it.
- **Not generate / comment.** Those don't need a planner —
  generate is open-ended; comment is structurally constrained
  to the comment schema. Edit is the only intent where the split
  pays off.

## Decisions to pin before code

1. **Which intent gets the split.** Only `edit` — both selection
   edits and whole-document edits. Generate / comment / table
   stay single-call.
2. **Model defaults.** Architect = `openai/gpt-5.5` (the existing
   default). Editor = `google/gemini-2.5-flash` (the existing
   fast model). Same model ids the route already picks; the
   user can override either independently. **Same provider
   namespace as today — no new env vars.**
3. **Patch shape.** Aider's CLI uses `<<<<<<< SEARCH` /
   `=======` / `>>>>>>> REPLACE` markdown-style blocks. For the
   Plate editor we adapt:
   ```
   <<<EDIT block-id-abc>>>
   <<<old>>>
   Original paragraph text.
   <<<new>>>
   Replacement paragraph text.
   <<<end>>>
   ```
   - `block-id-abc` ties the patch to a specific Slate block id
     (already on every node via Plate).
   - Multiple `<<<EDIT>>>` blocks per response let one edit
     touch N paragraphs.
   - `<<<old>>>` must match the block's plain-text content
     exactly; mismatches reject the patch and surface as a
     toast.
4. **What the architect sends.** Not the full document — just
   the selection (or the affected paragraphs for whole-doc edits)
   + the user's instruction. Architect output: a short
   bulleted plan ("1. Tighten paragraph 2 by half. 2. Add a
   transition sentence before paragraph 3."). The plan is sent
   to the editor as a system message; the editor's prompt
   includes the source AND the plan.
5. **Failure modes.** When the editor model emits a malformed
   patch (search text doesn't match, missing block id, syntactically
   broken block), the route falls back to the **current single-call
   path** — the architect's output is discarded and the editor
   is re-prompted as a single-model edit. Better to spend the
   tokens than fail the user's edit. The fallback emits a debug
   log so we can tune the patch format if it happens often.
6. **Streaming.** Architect output is NOT streamed to the
   client — it's an intermediate artefact, ~50–200 tokens, and
   the user doesn't need to see it. Editor output IS streamed
   into the diff-review surface as patches arrive. End-to-end
   latency: architect (1–2s) + editor (streams immediately).

## Shape — code surface

### Wire — `lib/shared/api-schemas.ts`

`CommandRequestSchema` (already exists for the editor command
route) gains an optional `editMode: 'single' | 'architect-editor'`
field. Default `'single'` keeps existing behaviour. The editor
component flips to `'architect-editor'` for edit-intent calls
when the user has it enabled (settings toggle, default on).

### Route — `app/api/ai/command/route.ts`

The `edit` branch of `prepareStep` becomes a two-step pipeline:

```ts
if (toolName === 'edit') {
  const [editPrompt, editType] = getEditPrompt(editor, { /* … */ })

  // Architect/editor split is opt-in via wire field; default
  // honours the existing single-call shape so latency-sensitive
  // users opt out cleanly.
  if (body.editMode === 'architect-editor' && editType !== 'table') {
    // Step A — architect emits a short plan (50–200 tokens,
    // not streamed to the client).
    const plan = await generateText({
      model: pickModel(model || 'openai/gpt-5.5'),
      prompt: getArchitectPrompt(editor, editPrompt, messagesRaw),
    })
    // Step B — fast editor emits structured patches; stream them
    // into the existing diff-review surface.
    return {
      ...step,
      activeTools: [],
      model: pickModel(model || 'google/gemini-2.5-flash'),
      messages: [
        { content: getEditorPrompt(editPrompt, plan.text), role: 'user' },
      ],
    }
  }
  // … existing single-call path stays unchanged …
}
```

Two new pure prompt builders:

- `getArchitectPrompt(editor, userInstruction, messagesHistory)` —
  emits "you are a senior editor; describe what changes to make
  in 3–6 bullet points; don't write the final text." Lives in
  `app/api/ai/command/prompt/getArchitectPrompt.ts`.
- `getEditorPrompt(userInstruction, plan)` — emits "apply this
  plan to the source by emitting one or more `<<<EDIT>>>` patch
  blocks; do not write any text outside patch blocks." Lives in
  `app/api/ai/command/prompt/getEditorPrompt.ts`.

### Patch parser — `lib/shared/editor/patches.ts`

Pure helper. Takes the editor model's output text + the current
Slate value, returns a list of `{ blockId, oldText, newText }`
triples + a list of `{ blockId, reason }` rejection records.

```ts
export interface ParsedPatch {
  blockId: string
  oldText: string
  newText: string
}

export interface RejectedPatch {
  blockId: string
  reason: "block-not-found" | "old-text-mismatch" | "malformed"
}

export function parseEditorPatches(
  rawOutput: string,
  blocks: Array<{ id: string; text: string }>,
): { patches: ParsedPatch[]; rejected: RejectedPatch[] }
```

The patch regex is intentionally strict — better to reject and
fall back than to silently apply a wrong patch.

### Client — `components/editor/use-chat.ts`

The edit-intent path checks the `editor.editMode` user-pref
(stored in the existing editor settings dialog, defaults to
`'architect-editor'`). When patches arrive, they convert to the
existing diff-review surface format and stream in chunk by chunk.

### Settings — editor preferences dialog

One new toggle: **"Use architect/editor split for edits"** (on
by default). Tooltip explains: "Two model calls per edit — the
first plans what to change, the second writes the patch. Cheaper
and more reliable, but adds ~1 second to the first byte."

Stored as `editor.editMode: 'single' | 'architect-editor'` in the
ui slice (existing). No migration needed — absent value defaults
to `'architect-editor'`.

## Sequencing — one PR, three commits

1. **Commit 1 — pure parser + tests.** `lib/shared/editor/patches.ts`
   + parser tests covering: well-formed patch round-trips,
   block-not-found rejection, old-text-mismatch rejection,
   multi-patch output, malformed input falling cleanly to
   `rejected: ['malformed']`.
2. **Commit 2 — route + prompt builders.** New
   `getArchitectPrompt` / `getEditorPrompt`, two-step edit
   branch, fallback to single-call on patch parse failure.
   `editMode` field added to `CommandRequestSchema`. Route
   tests stay as-is; pure builders get their own tests.
3. **Commit 3 — client wiring + settings toggle.** Editor
   prefs surface, store mutator, `use-chat.ts` reads the pref
   and sets `editMode` on the wire. Falls cleanly through
   to existing path when off.

## Tests

- **`parseEditorPatches` (commit 1)** — pure parser, ~8 cases
  including all rejection paths.
- **`getArchitectPrompt` / `getEditorPrompt` (commit 2)** —
  snapshot the prompt shape; assert the user instruction and
  source are interpolated; assert the plan output is referenced
  in the editor prompt.
- **No new route integration test** — the route doesn't get
  a new test scaffold (matches the existing pattern from #166,
  #169). Manual smoke covers the architect-editor handshake.
- **Manual smoke (PR description checklist)**:
  - With the toggle ON, select a paragraph, type "make this
    half as long" — confirm two model calls happen (visible in
    Langfuse traces once that ships), the patch lands in the
    diff-review surface, accept/reject works.
  - With the toggle OFF, the same flow uses the existing
    single-call path (regression check).
  - Force a malformed patch (e.g. via a fake editor that
    returns gibberish) — confirm the fallback fires and the
    edit lands via the single-call path.

## What's NOT in scope

- **Generate / comment intents.** Single-call stays.
- **Table edits.** The existing `table` tool stays single-call
  because table cells have a different schema; the
  `<<<EDIT block-id>>>` shape doesn't fit. Future work could
  add `<<<EDIT-CELL row-col>>>` if there's demand.
- **Multi-turn chat with the architect.** Aider's CLI supports
  back-and-forth with the planner; the Plate command surface is
  one-shot per invocation. Out of scope; users can re-invoke
  the command if the first plan was wrong.
- **Diff preview between architect plan and final patch.** Some
  users would want to see the plan before patches stream in.
  Adds UI surface; defer until someone asks.
- **Auto-pick between architect-editor and single-call based on
  edit size.** The toggle is binary; a heuristic ("small edits
  go single, big edits go split") is a refinement nobody's
  asked for.

## Open questions before commit 1

1. **Patch format — exact delimiters.** The `<<<EDIT>>>` block
   syntax is one of several reasonable choices (XML-style
   `<edit>`, JSON-line `{"blockId":...}`, Aider's exact `<<<<<<<
   SEARCH` shape). **Default: the markdown-style `<<<EDIT>>>`
   block shown in this plan — readable in logs, parseable with
   a tight regex, robust to one stray character.**
2. **What the architect sees from message history.** The
   command route already passes `messagesRaw` (the editor's chat
   history). The architect should see the immediate user
   instruction + the current selection; full chat history
   would just confuse it. **Default: last user message only +
   selection.**
3. **Token budget on the architect.** Plans should be short.
   **Default: cap at 400 output tokens — covers 6-7 bullets;
   anything longer reads as the architect doing the editor's
   job.**

## Reopen triggers

A v2 of this plan justifies itself when:
- Editor traffic shows >70% of edit operations go through the
  fallback path (means the patch format isn't matching reality
  often enough to keep the split worth it), OR
- Generate / comment intents start asking for the same split
  (different prompt shapes; would warrant its own follow-up), OR
- Cost telemetry shows the architect call costs more than the
  editor call (means the model defaults need flipping; the
  pattern itself is still fine).
