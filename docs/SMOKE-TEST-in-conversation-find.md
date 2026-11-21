# Smoke test — in-conversation find (⌘F)

Manual checks for behaviour the unit suite can't cover (DOM ranges and the
CSS Custom Highlight API). Run `bun dev` and open a chat with several
messages; no AI key is needed (mock replies are fine). Use a current
Chromium, Safari or Firefox for the highlight path.

1. [ ] **Open + intercept.** In an open conversation press ⌘F (Ctrl+F on
   Windows/Linux). The find bar appears top-right over the messages with
   its input focused; the browser's own find does NOT open.
2. [ ] **Highlight all + current.** Type a word that appears several times.
   Every visible occurrence is highlighted (gold); the active one is orange;
   the count reads `1 / N`, and N matches what you can see.
3. [ ] **Navigate + wrap.** `Enter` (or ↓) moves to the next match and
   scrolls it into view; from the last it wraps to the first. `Shift+Enter`
   (or ↑) goes back and wraps. A match in the first message is not hidden
   under the bar.
4. [ ] **No results.** Type gibberish: "No results" in red, nav buttons
   disabled, no highlights.
5. [ ] **Prefill from a selection.** Select a word in a message, then ⌘F:
   the query is filled in and searched. ⌘F again re-focuses and selects the
   input.
6. [ ] **Close.** `Esc` (or ✕) closes the bar and clears every highlight.
7. [ ] **Live content.** With the bar open on a word, send a message that
   contains it: the count goes up without retyping; while a reply streams,
   new matches appear and the view doesn't jump.
8. [ ] **Collapsed reasoning.** On a reply with a collapsed "Reasoning"
   block, a word that occurs only inside the reasoning gives "No results".
9. [ ] **Markup intact.** Search text in an assistant reply with citation
   buttons or code blocks: nothing is duplicated or broken (the DOM is never
   modified).
10. [ ] **Scope.** In Workspaces / Editor / Canvas, or a chat with no
    messages, ⌘F opens the browser's own find. Switching conversations
    closes the bar.
11. [ ] **Fallback (optional).** In a browser without `CSS.highlights`
    (or with `window.Highlight` removed by an init script before the app
    loads), the bar counts matching messages, and next/prev scroll to each
    with a brief orange outline, one message at a time.

When this landed, a headless-Chromium driver covered 1–8, 10 (Workspaces
view only) and 11, plus 9 as "message DOM byte-identical before and after a
search" on mock replies (no citations or code blocks). Not yet driven:
re-focus on a repeated ⌘F, the no-jump behaviour during a real stream,
switching conversations, and real citation / code-block replies.
