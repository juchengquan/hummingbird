# Plan: Browser / computer use as a `browse` skill

Status: **planning.** Promoted from [MASTER_PLAN § Later](MASTER_PLAN.md)
(second research round, 2026-06-09) to **Next**. Scope: **L** (sandbox +
auth + safety; a phased PR series). Origin: the 2026 browser-agent wave
(browser-use, Stagehand, Claude computer use) — see [Sources](#sources).

## Why

Hummingbird's web tools today are read-thin: `webFetch` does a static
GET, `searchFiles` is local FTS, `webSearch` returns result snippets.
None can *operate* a website — log into a portal, fill a multi-step
form, click through a flow, extract from a JS-rendered page behind
interaction. browser-use (open-source, ~95k★, SOC2) and Claude computer
use made that production-grade in 2026.

A `browse` skill is a natural new `ServerSkill` beside `generateImage` /
`webSearch`, and it composes with infrastructure the
[code-interpreter](PLAN-code-interpreter.md) plan establishes — a
sandboxed, budget-gated, HITL-approvable execution surface. Screenshots
ride the **existing** `data-tool-image` → `GeneratedImagesGallery` path,
so the user watches the agent work with no new render code.

## Non-goals — what this is NOT

- **Not desktop/computer control.** Browser only (a headless Chromium),
  not OS-level mouse/keyboard. Full computer use is a much larger
  safety surface; out of scope.
- **Not unattended authenticated automation in v1.** Logging into a
  user's accounts is the highest-risk capability; it's the *last*
  phase, heavily gated, behind an explicit credential vault.
- **Not a scraper farm.** Bounded by step caps, wall-clock timeout, and
  the per-IP/user budget. One task per tool call.
- **Not its own sandbox infra.** Backed by browser-use (Python, runs in
  `services/agent-py`) or a hosted Browserbase-style endpoint behind an
  adapter — the Minimax/E2B custom-base-URL pattern.

## Decisions to pin before code

1. **Backend + provider.** browser-use is Python and drives
   Playwright/Chromium — natural home is `services/agent-py`. Wrap
   behind a `BrowserRunner` interface so a hosted endpoint (Browserbase
   / Steel) drops in via env without touching call sites. **Default:
   browser-use self-host first; hosted adapter as an option.**
2. **Safety posture — read-only by default.** Phase 1 navigates +
   extracts only (no clicks that mutate, no form submits, no auth).
   Mutating actions (Phase 2) are **HITL-gated** — the model proposes
   the action, the approval card shows it, a human approves before it
   executes (reuse the gated-tool / `askUser` mechanism).
3. **Network + SSRF.** Browsing is inherently outbound, so the sandbox
   is the isolation boundary (no access to the app's network/secrets).
   Apply a **domain allow/deny list** + the existing SSRF guard on the
   *start* URL (block loopback/private/metadata endpoints).
4. **Result channels — reuse what exists.** Step-by-step progress →
   `tool_output` events (the tool-pill / Sources strip). Screenshots →
   `persistGeneratedImages` → `data-tool-image` → the gallery.
   Extracted text/data → the tool's structured return.
5. **Budget + caps.** `consumeBudget()` gate + a wall-clock timeout +
   a max-steps cap per task. A runaway browse is bounded.
6. **Env-gated registration.** Registers only when a browser backend is
   configured (`BROWSER_RUNNER_URL` / browser-use deps present),
   exactly like image-gen degrades without a Minimax key. No mock.

## Shape — code surface

### Runner abstraction — `services/agent-py` (+ adapter)

```python
# services/agent-py/src/agent_py/browser/runner.py
class BrowserRunResult(TypedDict):
    ok: bool
    steps: list[BrowserStep]      # action + url + note per step
    screenshots: list[ScreenshotResult]  # base64 PNGs
    extracted: str | None         # text/data the task asked for
    error: BrowserError | None    # timeout | navigation | blocked | budget

class BrowserRunner(Protocol):
    async def run(self, *, task: str, start_url: str | None,
                  max_steps: int, allow_domains: list[str] | None,
                  approve: ApproveFn | None) -> BrowserRunResult: ...
```

- `browser_use_runner.py` — wraps the browser-use library; maps its
  step/screenshot stream onto `BrowserRunResult`; tears the browser
  down in a `finally`.
- `select_runner.py` — self-host vs hosted endpoint from env.

### Skill — `lib/server/skills/browse.ts` (+ agent-py twin)

A `ServerSkill` (id `"browse"`, toolName `"runBrowserTask"`):

```ts
buildTool(entry, ctx) {
  if (!hasBrowserRunner()) return null
  return tool({
    description: "Operate a headless browser to complete a web task and return findings + screenshots.",
    inputSchema: z.object({
      task: z.string(),
      startUrl: z.string().url().optional(),
      allowDomains: z.array(z.string()).optional(),
    }),
    async execute({ task, startUrl, allowDomains }, { abortSignal }) {
      const gate = ctx.consumeBudget?.(); if (gate && !gate.allowed) return { ok: false, code: "budget" }
      assertNotSsrf(startUrl)
      return runBrowserTask({ task, startUrl, allowDomains, maxSteps: BROWSE_MAX_STEPS, signal: abortSignal })
    },
  })
}
```

`promptFragment` tells the model when to reach for `runBrowserTask` vs
`webFetch`/`webSearch`.

### Emission — `app/api/chat/route.ts`

A `maybeEmitBrowseFrames()` beside `maybeEmitImageFrame()`: step notes →
`tool_output`; screenshots → `persistGeneratedImages` +
`emitter.toolImage(...)`; extracted text → the tool result summary.

### HITL gate (Phase 2)

Mutating browse actions use the gated-tool pattern (no `execute` →
suspend) or mid-run `askUser` approvals; the existing approval card
(`task-strip.tsx`) renders "Allow the agent to submit this form?" with
the action details.

## Sequencing — PR series

1. **PR 1 — read-only browse (agent-py).** `BrowserRunner` + browser-use
   wrapper; the `browse` skill (navigate + extract + screenshot, no
   mutation, no auth); SSRF + domain allow-list + budget + timeout;
   screenshots via the gallery path. Env-gated.
2. **PR 2 — HITL-gated mutating actions.** Clicks/form-fills proposed by
   the model, approved via the card before execution. The approval
   payload shows the concrete action.
3. **PR 3 — agent-ts parity** (or a hosted-runner adapter so the TS
   backend can call the Python runner over HTTP).
4. **PR 4 (gated) — authenticated flows.** A per-site credential vault
   (reuse the encrypted cloud-MCP credential store) so the agent can
   log in. Heaviest safety review; explicit per-site opt-in.

## Tests

- **Result marshalling (PR 1)** — provider step/screenshot stream →
  `BrowserRunResult` (step ordering, screenshot capture, error
  classification). Pure, no real browser.
- **SSRF + allow-list (PR 1)** — loopback/private/metadata start URLs
  rejected; off-allow-list navigation blocked.
- **Skill gate (PR 1)** — no browser backend → skill absent from
  `SERVER_SKILLS`.
- **HITL approval (PR 2)** — a mutating action suspends + resumes on
  approve; reject synthesises a "declined" result (reuse the
  ask-user/approval tests).
- **Manual smoke** — "find the price of X on this docs site" navigates +
  extracts + shows screenshots; a destructive action prompts for
  approval; an infinite navigation hits the step cap.

## Open questions before PR 1

1. **Self-host vs hosted runner default.** Self-host (browser-use +
   Chromium in the agent-py container) is private but heavier to
   operate; hosted is turnkey but adds a vendor. **Default: support
   both via the adapter; document self-host as the privacy path.**
2. **Caps.** **Default: 20 steps, 60 s wall-clock, screenshots capped
   at 10 per task.**
3. **Where the headless browser runs relative to the executor.** In the
   same container as agent-py vs a sidecar. **Default: sidecar
   container (clean resource + crash isolation), reached over localhost
   by the runner.**

## Reopen / future work

- **Computer use (desktop)** — only if a concrete need appears; far
  larger safety surface.
- **Recorded macros** — save a successful browse as a replayable
  parametrised task (pairs with portable skills / scheduled tasks).
- **Subagent synergy** — a "research" orchestrator
  ([subagent plan](PLAN-subagent-orchestration.md)) spawning parallel
  browse subagents across sites.

## Sources

- [browser-use (open source)](https://github.com/browser-use/browser-use)
- [Computer-use agents 2026 — Claude / OpenAI / Gemini](https://www.digitalapplied.com/blog/computer-use-agents-2026-claude-openai-gemini-matrix)
- [The agentic browser landscape 2026](https://nohacks.co/blog/agentic-browser-landscape-2026)
