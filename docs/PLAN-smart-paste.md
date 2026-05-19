# Plan: Smart paste

Status: **draft** — not yet implemented.

## Goal

When the user pastes content into the chat input, recognize what kind
of content it is (URL, code, JSON, CSV, long prose) and offer one-click
context-aware actions instead of making them write the prompt
scaffolding by hand.

Daily-use polish: the kind of detail people notice immediately and
tell others about. Zero new infra, no env vars, no migrations.

## UX

1. User pastes into the textarea. Pasted content lands as usual.
2. A small chip strip appears **above the chat input** (under the
   active-skills chips), styled distinctly to signal "we recognized
   what you pasted":

   ```
   📋 URL detected · [Summarize] [Open] [×]
   📋 JSON detected · [Format & explain] [Generate TS types] [×]
   📋 Code detected · [Explain] [Refactor] [Find bugs] [×]
   📋 CSV detected · [Summarize columns] [Plot] [×]
   📋 Long text · [Summarize] [Translate] [Rewrite] [×]
   ```

3. Click an action → the textarea is **replaced** with a templated
   prompt wrapping the pasted content (e.g. `Summarize this URL: <url>`).
   Focus returns to the input so the user can edit before sending.
4. Click `×` → chip disappears, input stays as-is (just pasted text).
5. Chip auto-dismisses when:
   - The user sends a message
   - The user edits the input enough that the pasted content is gone
     or substantially changed (simple heuristic: input no longer
     contains the detected snippet)
   - A new paste happens (re-run detection)

Only one chip at a time per paste. Detection picks the highest-precedence
match: **URL → JSON → CSV → Code → long text**.

## Detection rules

All pure-function; no external calls.

| Kind | Rule |
|---|---|
| `url` | Single trimmed token matching `^https?://[^\s]+$` |
| `json` | Trimmed text starts with `{` or `[`, parses via `JSON.parse` |
| `csv` | ≥ 3 lines, each non-empty line has ≥ 1 comma, comma count consistent within ±1 across the first 5 lines |
| `code` | Either: contains a triple-backtick fence; or contains ≥ 2 keywords from `[function, const, let, var, import, export, def, class, public, private, async, await, return, => , type ]` |
| `longText` | ≥ 500 characters and none of the above matched |

Each detection returns `{ kind, snippet, length, lineCount }`. `snippet`
is the pasted text (possibly trimmed); other fields are for chip
display ("CSV · 1,240 rows").

## Actions

Each `kind → action[]` maps to a `buildPrompt(snippet, meta)` function
returning the templated string the input gets replaced with.

| Kind | Actions |
|---|---|
| `url` | `Summarize this URL: <url>` — pairs naturally with Web Search skill when on. *Open this URL* opens `<url>` in a new tab (no chat). |
| `json` | `Format this JSON and explain its shape:\n\`\`\`json\n<json>\n\`\`\`` — runs through markdown rendering. *Generate TS types* uses a more specific prompt. |
| `csv` | `Look at this CSV and tell me what the columns mean and what's interesting:\n\`\`\`\n<csv>\n\`\`\`` — *Plot* asks for a recommended chart kind in markdown table form (real plotting is out of v1 scope). |
| `code` | `Explain this code:\n\`\`\`\n<code>\n\`\`\`` / *Refactor* / *Find bugs* — uses the same fence wrap. |
| `longText` | `Summarize this in 3 bullet points:\n\n<text>` / *Translate to English* / *Rewrite more concisely* |

The chip's primary action (first in the row) is the most-likely-useful
one per kind.

## Files

**New**

- `lib/smart-paste/detect.ts` — `detectPasteKind(input: string):
  PasteDetection | null`
- `lib/smart-paste/actions.ts` — `ACTIONS_BY_KIND: Record<PasteKind,
  PasteAction[]>` with `buildPrompt`
- `components/chat/smart-paste-chip.tsx` — the chip UI; takes
  `detection`, `onApply(prompt)`, `onDismiss()`

**Modified**

- `components/panels/chat.tsx`:
  - `onPaste` on `InputGroupTextarea` runs `detectPasteKind` against
    the to-be-pasted text and stashes the detection in component state
    (alongside `mutedSkillsForNext`).
  - `<SmartPasteChip>` rendered above the input, beneath
    `<ActiveSkillsChips>`.
  - Chip's `onApply(prompt)` sets `inputValue = prompt`, refocuses the
    textarea, auto-resizes.
  - Chip dismiss conditions wired (effects watching `inputValue`,
    `isStreaming`, etc.).

**Untouched**

- Store — chip state is component-local; never persists.
- Sync — no schema changes.
- Skills — composes naturally (if `webSearch` is on, the URL summary
  triggers a real search; otherwise the model answers from training).

## Risks / tradeoffs

- **Detection false positives** — a 3-line bash script with commas
  could trip the CSV rule. Mitigation: code rule outranks CSV when
  ≥ 2 code keywords appear. We accept occasional misclassification —
  the chip is dismissable and doesn't block sending.
- **JSON `parse` overhead on big pastes** — capped by checking length
  ≤ 1 MB before parsing. Heavier pastes fall through to `code` /
  `longText`.
- **Pasting into a partially-filled input** doesn't trigger detection
  because we run detection on the full new input value. The chip
  appears only when the *only* content is the recognized snippet (or
  it's a clearly-bounded paste like a URL). Simplifies cancel logic.
- **Mobile paste menus** — long-press paste fires the same `paste`
  event, so the chip works there too. No special handling needed.

## Verification

1. Paste `https://example.com` — URL chip with [Summarize] [Open].
   Click Summarize → input becomes `Summarize this URL: https://...`.
2. Paste a fenced JSON object — JSON chip. Click Format & explain →
   input becomes the templated prompt.
3. Paste a 5-line CSV — CSV chip. Click Summarize columns → input is
   the templated prompt.
4. Paste a TS function definition — Code chip. Click Explain → input
   is the wrapped fence + prompt.
5. Paste a 600-char Wikipedia paragraph — Long text chip.
6. Type extra characters into the input after pasting — chip stays as
   long as the snippet is still substantially present; dismisses once
   it's edited away.
7. Click × on the chip — chip dismisses, input unchanged.
8. Send the message (or hit Enter) — chip dismisses.
9. Paste then paste again — first chip is replaced by the new
   detection.
10. Paste a code snippet while the Web Search skill is on → the
    Explain action still works; web search isn't invoked because the
    model's tool list is per-turn and Explain doesn't need it.

## Scope cuts

- **No real plotting.** CSV → Plot just asks the model to suggest one
  in markdown. Real charts would be a follow-up using a chart library.
- **No TS-type generation as a separate route.** JSON → Generate TS
  types is a templated prompt; the model writes the types inline.
  Phase 2 could add a `quicktype`-based deterministic path.
- **No paste-from-image OCR.** Out of scope.
- **No undo for the input replacement.** The user can dismiss the
  chip before clicking, and the input still has the raw paste in
  scrollback they can ctrl-Z to. Adding explicit undo is bloat.

---

~3 files new, 1 file modified (`chat.tsx`). Estimated ~250 lines.
Single PR-sized.
