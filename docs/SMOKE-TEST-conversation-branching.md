# Smoke test — conversation branching (non-destructive edit/regenerate + viewer)

Manual checks for behavior the unit suite can't cover (needs a running app
+ a model). Run `bun dev`, open a chat with an AI gateway key configured.

1. [ ] **Edit is non-destructive.** Send 3+ turns. Edit an earlier **user**
   message → a new conversation titled `… (edit)` becomes active with the
   edit applied and a fresh reply; the toast reads "Edited — original kept
   as a branch"; the **original** conversation still exists intact in the
   sidebar.
2. [ ] **Regenerate is non-destructive.** On an assistant reply, click
   Regenerate → a `… (retry)` sibling becomes active with a new reply; the
   original reply is preserved on the source conversation.
3. [ ] **Branches viewer.** Open the chat header menu → **Branches**. The
   dialog shows the fork tree (root → edit/retry children) with "forked
   at: <snippet>" captions; the current node is highlighted; clicking the
   parent switches back to it.
4. [ ] **Persistence.** Reload — the branches + lineage survive (and, with
   Supabase configured, sync across devices).
5. [ ] **First-message edge.** Edit the very first user message → a fork
   with just that (edited) turn + reply; original preserved.
