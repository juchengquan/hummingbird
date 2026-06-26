# Smoke test — artifact version history + diffs

Manual checks (need a running app: `bun dev`). The live editable artifact
today is a **citation table** (table-kind), so use one.

1. [ ] **Versions accrue on edit.** Open/create a chat that produces a
   citation-table artifact. Open it in the Artifacts tab, edit a cell
   (changes `content`). Edit a second cell. A **History** button (the
   lucide `History` icon) appears in the dialog header.
2. [ ] **History + diff.** Click History → the panel lists prior versions
   (newest first) + "Current". Select a prior version → the diff shows the
   pretty-printed JSON line diff (red = removed, green = added) between that
   version and current.
3. [ ] **Restore is non-destructive.** Click "Restore this version" → the
   artifact content reverts to that version, AND a new version (the
   pre-restore content) appears in the list — nothing is lost.
4. [ ] **Cap.** Make 11+ edits → the history holds at most 10 prior
   versions (oldest dropped).
5. [ ] **No history for binary kinds.** Open an `image`/`file` artifact →
   no History button.
6. [ ] **Persistence (Supabase mode).** Reload → versions survive; with
   Supabase configured they sync across devices (the new `versions`
   column round-trips).
