# SUPABASE_TEST — file full-text retrieval smoke test

Recipe to verify the file full-text retrieval pipeline end-to-end:
the model can pull additional sections from an attached file via
`searchFiles({ fileId, query })` when the inline view is truncated.

Covers Phases 1–5 of `PLAN-file-full-text-retrieval.md` (PRs #33,
#35, #40, #41).

Two flows are documented:

- **Quick check** (no Supabase, no model key) — verifies the
  extraction + storage + UI badge surfaces that flow through
  Zustand. ~5 minutes.
- **Full check** (Supabase + model key) — adds the actual
  `searchFiles` tool round-trip through the model. ~15 minutes.

The quick check is what runs automatically when this verification
gets re-driven by the [`/verify`](https://docs.claude.com/en/docs/agents-and-tools/claude-code/skills)
skill in a remote container. The full check requires infrastructure
the container can't reach (`supabase start` needs an ECR image pull;
the chat model needs a real API key).

---

## Prerequisites

| | Quick | Full |
|---|---|---|
| `bun install`, port 3000 free | ✅ | ✅ |
| Playwright at `/opt/node22/lib/node_modules/playwright` (or local) | ✅ | ✅ |
| `bun run supabase:start` + `bun run supabase:reset` | — | ✅ |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` set | — | ✅ |
| `AI_GATEWAY_API_KEY` set (any other working model provider works too) | — | ✅ |
| Migration `0007_file_full_text.sql` applied | — | ✅ |
| Migration `0009_search_file_sections.sql` applied | — | ✅ |

Both checks need a sufficiently large file. Plain text works fine —
the same fixture serves both flows.

```bash
python3 - <<'PY' > /tmp/large.txt
import random
random.seed(42)
words = "retrieval embedding tsvector paragraph cascade workspace algorithm phenomenology".split()
paras = []
for i in range(2500):
    para = " ".join(random.choice(words) for _ in range(random.randint(30, 60)))
    paras.append(f"Paragraph {i+1}: {para}.")
# Sentinel for the Full check — distinctive phrase past the 100 KB
# inline cap so we can confirm searchFiles retrieved it.
paras[2200] = (
    "Paragraph 2201: This paragraph deliberately mentions the "
    "PINEAPPLE_SUBMARINE_42 sentinel for end-to-end retrieval testing. "
    "The model should be able to fetch this section via searchFiles "
    "even though it sits well past the inline truncation cap."
)
import sys; sys.stdout.write("\n\n".join(paras))
PY
wc -c /tmp/large.txt   # ~1.1 MB — well past the 100 KB inline cap
```

---

## Quick check (no Supabase, no model key)

What this verifies:
- Phase 1 — `EXTRACTION_BUDGET` of 100 KB really kicks in
- Phase 2 — `extractedFullText` lands on the file row past the inline cap
- Phase 5 — the **"Truncated · +N KB indexed"** badge surfaces in the UI
- Phase 5 — the **File search** skill appears in the right-rail skills tab
  with the FileSearch icon and full description copy

### Run

```bash
bun dev > /tmp/dev.log 2>&1 &
until grep -q "Ready in" /tmp/dev.log; do sleep 1; done
```

Then drive with Playwright:

```js
// /tmp/drive.mjs
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs"

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
await page.goto("http://localhost:3000/dashboard", { waitUntil: "networkidle" })
await page.waitForTimeout(800)

await page.locator('input[type="file"]').first().setInputFiles("/tmp/large.txt")
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(500)
  if (await page.locator("text=/indexed/i").count()) break
}

const badge = await page.locator("text=/Truncated/i").first().textContent()
console.log("badge:", badge)
await browser.close()
```

```bash
node /tmp/drive.mjs
```

### Expected output

- Console prints `badge: 'Truncated · +924 KB indexed'`
- The right-rail file row shows the scissors icon + amber-coloured
  `Truncated · +924 KB indexed` text underneath `large.txt · 1.1 MB`
- The Skills tab (sparkles icon, right activity bar) lists four
  skills, with **File search** at the bottom and the description
  starting with "Let the model pull additional sections from your
  attached files…"

### Math check

```
file size              1148 KB
inline cap                100 KB     (EXTRACTION_BUDGET)
full cap                 1024 KB     (FULL_EXTRACTION_BUDGET)
indexed extra =          924 KB      (1024 - 100)
```

If the badge reads anything other than `+924 KB indexed` for a
1148 KB fixture, one of the caps changed — re-check
`app/api/extract/route.ts` and the math above.

### Boundary probe

Upload a small file (under 100 KB) and confirm the badge is **absent**.
The conditional in `components/panels/extraction-status-badge.tsx`
gates the `+N KB indexed` suffix on `extractedFullText > extractedText`
— a file that fits inline shouldn't trip it.

```bash
python3 -c "print('Small file. ' * 4000, end='')" > /tmp/small.txt
# Re-run drive.mjs with /tmp/small.txt → expect no 'indexed' text.
```

### What this *doesn't* cover

The 401 console error during the quick check is expected — it's the
anonymous-mode Supabase auth poll. Doesn't affect the verified
surfaces.

The `searchFiles` tool itself can't fire in this mode:
`searchFilesSkill.buildTool` resolves the Supabase server client lazily,
and without Supabase env vars it stays null. The tool returns
`code: 'not_signed_in'` for every invocation. That's the boundary
between Quick and Full.

---

## Full check (Supabase + model key)

What this adds beyond the Quick check:
- The `searchFiles` tool actually fires through the model
- The Postgres FTS RPC `search_file_sections` returns sensible
  fragments
- The tool-call-strip pill flips to `Searched attached files · N excerpts`
  with the FileSearch icon
- The model uses the returned fragments to answer a question whose
  answer is past the inline cap

### Setup

```bash
# 1. Start Supabase + apply migrations
bun run supabase:start
bun run supabase:reset       # applies 0001-0009 fresh

# 2. Set Supabase env (these come from `supabase status`)
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
export NEXT_PUBLIC_SUPABASE_ANON_KEY=<from supabase status>

# 3. Set a working model provider key — any of these works
export AI_GATEWAY_API_KEY=<your gateway key>
# or MINIMAX_CN_API_KEY=… with MINIMAX_CN_BASE_URL=…

# 4. Boot the app
bun dev
```

### Run

1. Open http://localhost:3000/dashboard
2. Sign in via magic link (the link arrives at http://localhost:54324
   — Inbucket, the local SMTP catcher Supabase ships)
3. Upload `/tmp/large.txt` from the prerequisites step
4. Wait for the badge to read `Truncated · +924 KB indexed`
5. Open the Skills tab (sparkles icon) → toggle **File search** on
6. Open a new chat and ask:
   > In the attached large.txt, find the paragraph mentioning
   > "PINEAPPLE_SUBMARINE_42" and quote it.

### Expected behavior

- The tool-call strip shows two pills in sequence:
  1. `Searching attached files for "PINEAPPLE_SUBMARINE_42"…` (running,
     loader spinning)
  2. `Searched attached files · 1 excerpt` (done, FileSearch icon)
- The model's response includes the sentinel paragraph text, with
  the matched term wrapped in `«…»` markers from `ts_headline`:
  > Paragraph 2201: This paragraph deliberately mentions the
  > «PINEAPPLE_SUBMARINE_42» sentinel for end-to-end retrieval
  > testing…

### Failure modes worth recognising

| Symptom | Likely cause |
|---|---|
| Tool fires but returns `code: 'not_signed_in'` | Browser cookie session didn't reach the route — sign in via magic link before opening the chat |
| Tool fires but returns `code: 'not_indexed'` | File row hasn't synced to Postgres yet (sync layer is debounced). Wait ~5s and retry, or check `select id, length(full_text) from files;` in Studio |
| Tool fires but returns `code: 'no_match'` for a phrase you know is there | Postgres FTS stems with English rules — exact-string matching won't work for very unusual tokens. Try a phrase from the surrounding sentence |
| Pill stays in "Searching…" forever | Tool execution exceeded the per-turn cap or upstream timed out. Check the chat route logs for the per-IP rate-limit message |
| `Truncated · +924 KB indexed` badge missing despite 1.1 MB file | Extraction failed (check Network tab for `/api/extract` response) or sync layer hasn't run yet (check Network for `files` upsert) |
| Model never calls the tool | Skill toggle in the workspace prefs isn't on, or the system prompt note didn't include searchFiles (check the request payload's `skills` array) |

### Cleanup

```bash
bun run supabase:stop
pkill -f "next dev"
```

---

## What's left to verify if/when more infrastructure lands

Three follow-ups are documented in `PLAN-file-full-text-retrieval.md`
but not yet shipped. Each would extend this recipe:

- **Cross-file search** (drop `WHERE id = p_file_id` in the RPC) —
  ask a question without specifying the file; confirm the model picks
  the right one.
- **Real codegen-in-CI types check** — current CI guard only enforces
  diff-pairing. A real version would `supabase start` + regen + diff.
  The Full check above is effectively a manual version.
- **Multilingual FTS** — `to_tsvector('english', …)` only stems English.
  Drop a non-English document and confirm the failure mode is graceful
  (no match, not crash).
