# Smoke test — generated files + file-URL refresh

Manual, end-to-end verification for two features that **cannot be checked
by the unit suite** (they need a live microsandbox microVM, Supabase
Storage, a real model, and a browser):

- **Generated files from the code interpreter** (PR #265) — the `runCode`
  sandbox captures files written to `/tmp/outputs/`, shows them as
  download chips, and saves them as `file` artifacts.
- **File-URL refresh on click** (PR #267) — a file chip re-signs its
  Supabase URL on click (re-sign happens on **every** click for a
  cloud-stored file, not only after expiry).

Designs: `docs/superpowers/specs/2026-06-25-generated-files-design.md`,
`docs/superpowers/specs/2026-06-25-file-url-refresh-design.md`.

> **Already verified at runtime (no Supabase needed):** the new
> `POST /api/files/refresh-url` route mounts, returns `503` when Supabase
> is unconfigured (config-guard runs before body-parse), `405` on `GET`,
> and behaves byte-for-byte like `POST /api/images/refresh-url`. This
> runbook covers everything that probe could **not** reach.

---

## 0. Prerequisites

You need a host that can run the microsandbox runtime (libkrun — HVF on
Apple Silicon, KVM on Linux) and a configured `.env`.

- [ ] **`.env`** (copy `.env.example`, then set):
  - `AI_GATEWAY_API_KEY` — required, or chat falls back to a mock that
    never calls `runCode`.
  - `CODE_SANDBOX_ENABLED=1` — or the `runCode` skill isn't registered.
  - `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` — for
    Storage upload + cross-device sync + the refresh-url route (without
    them, files fall back to `data:` URLs and refresh is a no-op).
- [ ] **microsandbox runtime** installed and the Python image pullable
  (it's multi-GB; the sandbox is airgapped, so the image must already
  contain pandas/numpy/matplotlib). See `docs/PLAN-execution-sandbox.md`.
- [ ] **Supabase schema applied** (`supabase/migrations/`, through
  `0018_message_generated_files.sql`) — see `docs/SUPABASE_SETUP.md` or
  `docs/SUPABASE_LOCAL.md`.
- [ ] **Start the app** and **sign in** (email magic-link). A signed-in
  session is required: generated files are stored under
  `user-files/<your-uid>/generated/...`, and the refresh route's
  403 owner-check keys on `auth.uid()`.

```bash
bun dev    # http://localhost:3000
```

Open DevTools → **Network** tab; keep it open for the whole run.

---

## Test A — generated files (#265)

1. [ ] Open a chat with the **code interpreter** skill enabled. Prompt:

   > "Write a CSV with two columns (name, score) and ten rows to a file I
   > can download."

   The model should call `runCode` and write the file to `/tmp/outputs/`.

2. [ ] **Chip appears.** In the assistant message, a download chip shows
   the filename, a human-readable size, and a download icon. **Click it
   → the CSV downloads** and its contents are the ten rows.

3. [ ] **Artifact appears.** Open the right-hand **Resources sidebar →
   Artifacts** tab. There's a `file`-kind entry with the filename. Open
   it → the detail view shows a **download row** → clicking downloads the
   same file.

4. [ ] **Survives reload (sync).** Hard-reload the page. The chip **and**
   the artifact are still present and still download — confirms the
   `messages.generated_files` column + artifact row round-tripped through
   Supabase.

5. [ ] **Multiple files / large file (probe).** Ask for two files in one
   run (e.g. a CSV and a JSON). Both chips appear. Ask for a chunky file
   (a few MB) — it still captures (no new cap; bounded by the microVM).

**Expected storage layout** (optional cross-check in the Supabase
dashboard): `user-files/<your-uid>/generated/<toolCallId>-file-<i>-<name>`.

---

## Test B — file-URL refresh (#267)

The chip **re-signs on every click** for a cloud-stored file (one that
has a `storagePath`), so the happy path is simply "click and watch the
network." The expiry-recovery assertion needs you to break the stored URL
first.

1. [ ] **Re-sign fires on click.** With a generated file from Test A,
   click its chip. In the **Network** tab you see **`POST
   /api/files/refresh-url` → 200** with `{ "url": "<fresh signed URL>" }`,
   and the file downloads. (The chip's `href` in the store is updated to
   the fresh URL.)

2. [ ] **Recovers a broken/expired URL.** This is the point of the
   feature. Make the stored URL bad, then confirm a click still works:
   - In DevTools, find the message in the Zustand-persisted store
     (localStorage key for the app state) and replace that file's `url`
     with a clearly-broken value (e.g. append `XXX` to the signature) —
     **leave `storagePath` untouched**. Reload so the chip renders the
     broken URL.
   - Click the chip. Because re-sign uses the durable `storagePath` (not
     the broken `url`), you see `POST /api/files/refresh-url → 200` and
     **the file downloads correctly anyway.**

3. [ ] **Local / data-URL file does NOT call the route (probe).**
   Generate a file with Supabase disabled (or "Store files locally"), so
   the file has **no** `storagePath` and a `data:` URL. Click the chip →
   it downloads with **no `POST /api/files/refresh-url`** request in the
   Network tab (native `<a download>`).

4. [ ] **Security branches (probe — run while signed in).** In the
   browser console (so the auth cookie rides along):

   ```js
   // 403 — someone else's path (first segment != your uid)
   await fetch('/api/files/refresh-url', {method:'POST',
     headers:{'content-type':'application/json'},
     body: JSON.stringify({storagePath:'not-your-uid/generated/x.csv'})}).then(r=>r.status)
   // → 403

   // 400 — path traversal guard
   await fetch('/api/files/refresh-url', {method:'POST',
     headers:{'content-type':'application/json'},
     body: JSON.stringify({storagePath:'../etc/passwd'})}).then(r=>r.status)
   // → 400
   ```

   Then sign out and repeat the first call → **401**.

---

## Result

Record PASS/FAIL per checkbox. A clean run means: chips + artifacts
appear and download, survive reload (sync), the route re-signs on click
and recovers a broken URL, local files skip the network, and the
401/403/400 guards hold.

If anything fails, capture the Network response + the console, and note
which step — the failing branch points straight at the seam (capture vs.
persist vs. sync vs. re-sign).
