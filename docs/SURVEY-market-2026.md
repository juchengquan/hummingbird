# Market survey + feature gap analysis (Q1 2026)

Status: 🗺 research + recommended slate. Not yet shaped into per-feature
`PLAN-*.md` files — picks promoted from §6 will each get one.

This is a one-time competitive scan run on 2026-05-29 covering three
categories:

- **Commercial AI chat assistants** — ChatGPT, Claude.ai, Gemini, Perplexity,
  Microsoft Copilot.
- **AI code + research tools** — Cursor 2.0, Windsurf / Cascade, Zed, GitHub
  Copilot Coding Agent, Cline / Roo, Aider, Devin, Claude Code, v0 / Bolt /
  Lovable / Replit Agent, Perplexity Pages, ChatGPT Deep Research, Claude
  Research, Gemini Deep Research, Manus, NotebookLM.
- **Open-source self-hosted UIs** — LibreChat, Open WebUI, AnythingLLM,
  LobeChat, Chatbot UI, Khoj, Big-AGI, TypingMind, Msty, GPT4All / LM Studio.

Source links are aggregated in §7.

## TL;DR

- Humm leads its open-source peers in queue-backed agent tasks (HITL +
  chunking + Realtime live tail), workspace canvas, project mode (Kanban +
  per-card Run-as-task), sandboxed live artifacts spanning
  TSX / HTML / SVG / Mermaid, and the per-conversation file-FTS pipeline.
- The clearest table-stakes gap is **voice in/out** — 5 of 10 OSS peers ship
  it, every commercial product treats it as standard. Closing this is mostly
  plumbing.
- The most-leveraged distinctive bet is a **Deep Research mode** that composes
  the task queue + web search + the Plate editor into a single "thread →
  cited report" flow. Humm is one of the only OSS UIs with a peer rich-text
  editor, so this composition is genuinely unique.
- The most-imitated novel output of 2025 is **NotebookLM-style Audio / Video
  / Mind-map Overviews**. Humm's file-FTS + Sources rail + workspace canvas
  make this a composition exercise, not a stack rewrite.
- One unique-to-AnythingLLM differentiator worth taking: **outbound MCP
  server** — expose a Humm workspace as an MCP endpoint that external clients
  (Claude Desktop, Cursor, LM Studio, ChatGPT Atlas) can read from.

## 1. Where Humm leads the open-source self-hosted field

| Surface | Humm | Closest peer |
|---|---|---|
| Queue-backed task queue with HITL approvals + chunking + Realtime live tail | ✅ Phases 1–6 ([#82](https://github.com/juchengquan/hummingbird/pull/82), [#85](https://github.com/juchengquan/hummingbird/pull/85), [#88](https://github.com/juchengquan/hummingbird/pull/88)) | AnythingLLM Agent Flows is offline-style, no live tail; no peer combines HITL + chunking + Realtime |
| Workspace canvas (react-flow spatial view) | ✅ Phases 1–3 ([#83](https://github.com/juchengquan/hummingbird/pull/83), [#90](https://github.com/juchengquan/hummingbird/pull/90)) | Msty Flowchat is conversation-tree only, not a free canvas |
| Project mode (workspace = goal + milestones + Kanban + Run-as-task) | ✅ Phases 1–5 ([#81](https://github.com/juchengquan/hummingbird/pull/81)/[#86](https://github.com/juchengquan/hummingbird/pull/86)/[#89](https://github.com/juchengquan/hummingbird/pull/89)/[#91](https://github.com/juchengquan/hummingbird/pull/91)/[#94](https://github.com/juchengquan/hummingbird/pull/94)) | LobeChat Projects is light; no peer links a Kanban card to a runnable agent task |
| Sandboxed live artifacts (TSX / HTML / SVG / Mermaid) | ✅ ([#36](https://github.com/juchengquan/hummingbird/pull/36)) | LibreChat + Big-AGI cover code/HTML; SVG support is unique |
| Per-conversation files + cross-conversation FTS + sectioned file FTS | ✅ shipped | Most peers have one of the three; few have all |
| Plate.js rich-text editor as a peer panel | ✅ shipped | LobeChat Pages is the closest analogue but not Plate-grade |

## 2. Where commercial assistants pull ahead

| Feature | ChatGPT | Claude.ai | Gemini | Perplexity | Humm today |
|---|---|---|---|---|---|
| Advanced voice mode (real-time, interruptible) | ✅ | ✅ (Q4 2025 web) | ✅ Live (screen + webcam) | ✅ | ❌ |
| Vision + screen share | ✅ | partial | ✅ | partial | image input ✅ / no screen share |
| Computer Use / browser agent | ChatGPT Agent VM | Computer Use GA | Spark | Comet browser global | ❌ |
| Deep Research mode | ✅ (in Agent) | ✅ Advanced Research | ✅ | ✅ (Pages / Pro) | ❌ |
| NotebookLM-style Audio / Video / Mind-map overviews | partial via Apps | ❌ | ✅ Canvas | partial | ❌ |
| Connectors (Drive / Gmail / Notion / Slack / …) | 15+ native | Native MCP + Workspace | Workspace + apps | Comet 400+ apps | MCP (user-config) |
| Persistent cross-conversation memory | ✅ | ✅ Q1 2026 | ✅ | ✅ Mar 2026 | 📐 planned ([`PLAN-cross-conversation-memory.md`](PLAN-cross-conversation-memory.md)) |
| Scheduled / recurring tasks | ✅ Tasks | indirect | indirect | ✅ Pro | 📋 queue step 7 |
| Mobile native apps | ✅ | ✅ | ✅ | ✅ | ❌ (web PWA only) |
| Browser extension / sidebar | Atlas browser | n/a | Chrome native | Comet | ❌ |
| Custom personas / agents marketplace | GPTs Store | Skills | Gems | Spaces | prompt library partial |

Realistic chase list for a small team: **voice, deep research, NotebookLM-style
overviews, memory, custom agents**. The full Computer Use / browser-as-agent
arms race is out of scope for a self-hosted target.

## 3. Cross-cutting table-stakes gaps (≥3 OSS peers ship it)

Numbered roughly by effort, ascending.

1. **Voice in/out (STT/TTS, streaming)** — LibreChat / Open WebUI / LobeChat /
   Khoj / Big-AGI all ship it. _Effort: small-medium (Whisper API + Web
   Audio + a transport)._
2. **Quick actions on selected text** (Explain / Rewrite / Translate from a
   right-click in chat or editor) — every commercial app has it.
   _Effort: small._
3. **Side-by-side multi-model comparison ("Beam")** — Big-AGI, Msty, LobeChat
   Agent Groups. Already listed in `BACKLOG.md`'s "What's NOT here."
   _Effort: medium._
4. **Mobile PWA install + offline drafting** — already in `BACKLOG.md`.
   _Effort: small._
5. **Browser sidebar extension** — closes the Comet / Atlas gap at a small
   fraction of the cost. _Effort: medium._
6. **Code interpreter / Python sandbox** — LibreChat, Open WebUI, LobeChat,
   Khoj, Big-AGI. Humm has sandboxed *display* artifacts but no server-side
   code execution. _Effort: medium-large._
7. **Cross-conversation persistent memory** — LibreChat memory agent, Open
   WebUI memory, LobeChat agent memory. Humm has
   `PLAN-cross-conversation-memory.md` already; promotion is overdue.
   _Effort: medium._
8. **Scheduled task runs delivered out-of-app (email / Slack / webhook)** —
   Khoj, LobeChat, Msty. Composes with the task queue Step 7 (scheduling).
   _Effort: medium._
9. **Enterprise auth (LDAP / OIDC / SCIM / RBAC roles + groups)** — Open
   WebUI and LibreChat dominate here. Only relevant if pursuing enterprise
   self-host. _Effort: large._

## 4. Distinctive opportunities (would be a real differentiator)

Each card: **the idea**, **why it composes with existing Humm surfaces**,
**rough effort**.

### 4.1 Deep Research mode (thread → cited Pages-style report)

**Idea.** A new task action that takes a research goal, runs an iterative
multi-step loop (search → read → synthesize → search again) over web +
workspace files, and produces a structured cited Markdown document that
opens in the Plate editor as a peer artifact.

**Why it composes uniquely.** Humm is one of the only OSS UIs with both a
chat panel and a peer rich text editor. The natural output of Deep Research
is a document, and the editor is ready to hold it. The task queue already
supports chunking + HITL, which a long multi-step research run needs. The
Sources rail already renders cited sources from web search. The
combination is something no peer can ship without rebuilding three
surfaces.

**Effort.** Medium-large (~500–700 lines): a `runDeepResearch` task action,
a structured-plan tool, source aggregation, citation post-processing, and
the "Open in editor" hand-off.

### 4.2 NotebookLM-style Audio / Video / Mind-map overviews

**Idea.** A "Generate overview" button on a workspace (or conversation, or
selected source set). A server task assembles a script grounded in selected
sources, then renders to audio (TTS), video (with simple Nano-Banana-style
image scenes), or expands into an interactive mind map. Output stored as a
workspace artifact.

**Why it composes uniquely.** Sources rail + file FTS + Realtime task tail
are already in place. The artifact storage + workspace canvas can host the
audio / video / mind-map nodes. The mind-map case maps directly onto the
existing react-flow canvas.

**Effort.** Medium per format. Audio first (~400 lines: TTS provider, script
prompt, Storage upload), video and mind-map as follow-ons.

### 4.3 Outbound MCP server — Humm workspace as MCP endpoint

**Idea.** Expose `workspace` / `files` / `conversations` / `artifacts` as
tools and resources on an MCP server endpoint that external clients (Claude
Desktop, Cursor, LM Studio, ChatGPT Atlas) can connect to. Auth via a
per-user PAT.

**Why it composes uniquely.** Humm's per-conversation FTS + sectioned file
FTS + prompt library are exactly the surfaces external agents most want to
reach for. No OSS UI except AnythingLLM offers this today, and AnythingLLM's
surface is shallower.

**Effort.** Medium (~400 lines). Reuses existing search RPCs.

### 4.4 Custom agents / personas with scoped tool perms

**Idea.** A first-class "agent" object: name + system prompt + model +
KB scope + tool allow-list (skills + MCP servers). Slash invocation
(`/<agent>`), inline mention, or a per-conversation pin. A simple
share-via-URL primitive for trusted swaps (not a marketplace — yet).

**Why it composes uniquely.** Skills + prompt library + MCP cloud-mode are
already the substrate. The persona is the missing glue layer. Pairs naturally
with §4.5 (subagents).

**Effort.** Medium (~350 lines).

### 4.5 Subagents + Live agent visibility window

**Idea.** Two patterns combined. (a) **Subagents** in the task queue — a
parent task spawns a child task with an isolated context window and consumes
its summary (Claude Code pattern). (b) **Live agent visibility window** —
a slide-out panel during a running task that streams what the agent is doing
step-by-step and lets the user interject mid-step ("change direction",
"give me more X", "skip this step") without aborting (Manus pattern).

**Why it composes uniquely.** Task queue + HITL + Realtime tail are already
the carrier signals; this layer on top makes long tasks intelligible and
steerable.

**Effort.** Medium-large per side (~400 + ~300 lines).

## 5. Agent-depth additions (build on the existing task queue)

These extend the queue rather than open new product surfaces.

- **5.1 Parallel agents on the same project** (Cursor 2.0 pattern): fan out
  N agents over Kanban cards in parallel, each with its own checkpoint,
  gather results into the project. Natural extension of project mode + queue.
- **5.2 Hooks** (Claude Code pattern): deterministic lifecycle commands on a
  task — pre-run, post-step, post-suspend. E.g. always run a typecheck before
  letting the agent finalize a code change. Tiny but high-leverage on trust.
- **5.3 Plan / Act split with visible plan editing** (Cline pattern): on
  task start, show the proposed plan, let the user edit / reorder steps,
  then enter Act. Composes with the existing HITL approval surface.
- **5.4 Outbound destinations for finished tasks** (Khoj pattern): email /
  Slack / webhook on settle. Composes with Step 7 (scheduling) for the
  "weekly digest" case.

## 6. Recommended slate (in priority order)

Order chosen to maximize "1 PR moves the product visibly" early, distinctive
bets in the middle, infrastructure last. Each item below would get its own
`PLAN-*.md` if/when picked.

1. **Voice in/out (STT/TTS streaming)** — the most visible "1 PR" gap-closer;
   every peer ships it, no architectural surprises. Promotes the product feel
   an order of magnitude. _Effort: small-medium._
2. **Cross-conversation memory** — `PLAN-cross-conversation-memory.md`
   already exists; promote from 📐 planned to 🚧 in progress. Every
   commercial assistant ships this now. _Effort: medium._
3. **Deep Research mode** — highest distinctiveness-per-effort given the
   chat-plus-editor architecture. Builds on the task queue. _Effort:
   medium-large._
4. **Audio overviews (Phase 1 of §4.2)** — ship audio first; video and
   mind-map as follow-ons. _Effort: medium._
5. **Custom agents / personas with scoped tool perms** — unlocks future
   agent marketplace work. Built from existing skills + prompt library.
   _Effort: medium._
6. **Outbound MCP server (workspace-as-MCP)** — a moat move; no peer except
   AnythingLLM has this. _Effort: medium._
7. **Subagents + Live agent visibility window** — extends queue depth and
   makes long tasks intelligible. _Effort: medium-large per side._

Items deliberately deferred: Computer Use (out of scope for self-host),
enterprise auth (relevant only if pursuing enterprise), browser extension
(medium ROI, large maintenance), code interpreter sandbox (large effort,
less leverage than §4.1 + §4.2), mobile PWA install (small but no clear
"now or never" forcing function).

## 7. Sources

Aggregated from the three research passes that produced this survey.

**Commercial chat assistants.**
- [ChatGPT Atlas](https://openai.com/index/introducing-chatgpt-atlas/)
- [ChatGPT release notes](https://help.openai.com/en/articles/11391654-chatgpt-business-release-notes)
- [Company Knowledge](https://openai.com/index/introducing-company-knowledge/)
- [Claude features 2026](https://suprmind.ai/hub/claude/features/)
- [Claude integrations](https://claude.com/blog/integrations)
- [Claude voice features](https://www.datastudios.org/post/claude-voice-features-explained-current-status-and-upcoming-real-time-updates)
- [Claude Cowork + Code](https://o-mega.ai/articles/claude-desktop-cowork-and-code-complete-guide)
- [Gemini 3 in Gemini app](https://blog.google/products/gemini/gemini-3-gemini-app/)
- [Gemini Deep Research](https://gemini.google/overview/deep-research/)
- [Perplexity changelog — Computer + enterprise](https://www.perplexity.ai/changelog/improved-computer-models-and-enterprise-updates---may-4-2026)
- [Copilot Researcher](https://support.microsoft.com/en-us/topic/get-started-with-researcher-in-microsoft-365-copilot-e63ab760-f3de-4c47-ae87-dad601b0e9c4)

**AI code + research tools.**
- [Cursor 2.0](https://cursor.com/blog/2-0)
- [Windsurf Cascade docs](https://docs.windsurf.com/windsurf/cascade/cascade)
- [Zed 2025 recap](https://zed.dev/2025)
- [GitHub Copilot coding agent GA](https://github.blog/changelog/2025-09-25-copilot-coding-agent-is-now-generally-available/)
- [Devin 2.0](https://cognition.ai/blog/devin-2)
- [Devin 2.2](https://cognition.ai/blog/introducing-devin-2-2)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [v0 / Lovable / Bolt / Replit comparison](https://www.digitalapplied.com/blog/v0-lovable-bolt-ai-app-builder-comparison)
- [Perplexity Pages](https://www.perplexity.ai/hub/blog/perplexity-pages)
- [OpenAI Deep Research](https://openai.com/index/introducing-deep-research/)
- [Manus](https://en.wikipedia.org/wiki/Manus_(AI_agent))
- [NotebookLM Studio upgrade](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-video-overviews-studio-upgrades/)

**Open-source self-hosted UIs.**
- [LibreChat features](https://www.librechat.ai/docs/features)
- [LibreChat MCP](https://www.librechat.ai/docs/features/mcp)
- [LibreChat user memory](https://www.librechat.ai/docs/features/memory)
- [Open WebUI features](https://docs.openwebui.com/features/)
- [Open WebUI pipelines](https://docs.openwebui.com/features/extensibility/pipelines/)
- [AnythingLLM agents](https://docs.anythingllm.com/agent/overview)
- [AnythingLLM Agent Flows](https://docs.anythingllm.com/agent-flows/overview)
- [LobeHub](https://lobehub.com/)
- [Khoj features](https://docs.khoj.dev/category/features/)
- [Big-AGI repo](https://github.com/enricoros/big-AGI)
- [TypingMind features](https://docs.typingmind.com/feature-list)
- [Msty Studio](https://msty.ai/studio/)
- [LM Studio docs](https://lmstudio.ai/docs/app)
