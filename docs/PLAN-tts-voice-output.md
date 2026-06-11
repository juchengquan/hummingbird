# Plan: Read-aloud / TTS voice output

Status: **⏸ deferred** (parked 2026-06-11). Drafted in the
2026-06-09 fourth research round; the rest of Tier 2 + half of
Tier 1 drew down ahead of it without anyone hitting "I wish
Hummingbird could read this aloud" as a real pain point. **Re-open
when:** (a) a user actually requests voice-out, (b) full voice mode
(STT-in + barge-in) goes on the roadmap and we need the output half
as a foundation, or (c) a self-hostable open-source TTS adapter
becomes a 1-day plug-in (the field is moving fast — Chatterbox-Turbo,
MeloTTS, Hume TADA already qualify). Origin: 2026 streaming
open-source TTS — see [Sources](#sources). Scope when reopened:
**M** (one PR, phased commits).

## Why

Hummingbird tracks "voice input (Whisper)" as a catch-up note, but
**voice out** — read the assistant's reply aloud, hands-free — is a
distinct, low-risk feature and the foundation for a full voice mode. The
2026 open-source TTS field makes it cheap: Chatterbox-Turbo (sub-200 ms,
350M params), MeloTTS (CPU-real-time), Hume TADA (~11× realtime), all
self-hostable. A read-aloud control on assistant messages is a small,
satisfying add that reuses the model-provider adapter pattern.

## Non-goals — what this is NOT

- **Not full duplex voice mode.** v1 is read-*aloud* of replies (TTS
  out). Realtime speech-to-speech (STT in + barge-in) is future work —
  this plan lays the output half.
- **Not a bundled heavyweight model.** TTS runs behind an adapter (self-
  host endpoint or hosted voice); absent config → the control hides.
- **Not narration of everything.** Per-message, on-demand (and an opt-in
  auto-read setting), not forced.

## Decisions to pin before code

1. **Engine + adapter.** A `TtsProvider` interface behind a base-URL
   adapter (the Minimax/Ollama pattern): a self-host Chatterbox/MeloTTS
   endpoint, or a hosted voice. Env: `TTS_BASE_URL` (+ optional key).
   Absent → no TTS.
2. **Streaming.** Stream audio chunks as they synthesise (sub-200 ms
   first-chunk targets make this worthwhile); play progressively.
3. **What gets read.** The assistant message's text (strip markdown /
   code fences to plain speech). Per-message **Read aloud** button +
   an opt-in "auto-read replies" workspace setting.
4. **Where synthesis runs.** Server route (`/api/tts`) so the engine key
   stays server-side; returns a streamed audio response the client
   plays via the Web Audio / `<audio>` MediaSource API.
5. **Voice + rate.** A small voice picker + speed control; per-workspace
   default. Reuse the existing settings surfaces.

## Shape — code surface

### Server — `/api/tts` + adapter

- `lib/server/tts/types.ts` — `TtsProvider { synth(text, voice, opts):
  ReadableStream<audio> }` + `selectTtsProvider()` (null when
  unconfigured).
- `lib/server/tts/chatterbox-client.ts` (or generic OpenAI-compatible
  audio) behind the base-URL adapter.
- `app/api/tts/route.ts` — `{ text, voice?, speed? }` → streamed audio;
  per-IP budget gate; text length cap.

### Client — read-aloud control

- A speaker button on assistant messages (`components/panels/chat-
  message.tsx`) that POSTs to `apiUrls.tts()` and plays the streamed
  audio; play/pause/stop; highlight while playing.
- A `voice.autoRead` + `voice.voiceId` + `voice.speed` settings block
  (ui slice); no migration if stored in ui prefs.

### Wire

- `apiClient`/`apiUrls` entry + a request schema in
  `lib/shared/api-schemas.ts`.

## Sequencing — one PR, two commits

1. **Commit 1 — `/api/tts` + adapter.** The provider interface +
   self-host client + the route (streamed, budget-gated, capped) + the
   request schema + apiClient entry. Env-gated.
2. **Commit 2 — read-aloud UI + settings.** The message control,
   progressive playback, voice/speed picker, auto-read setting.

## Tests

- **Text→speech prep (commit 1)** — markdown/code stripped to clean
  speech text; length cap; pure.
- **Provider gate (commit 1)** — no `TTS_BASE_URL` → route 503 / control
  hidden (regression guard).
- **Manual smoke (commit 2)** — Read aloud plays streamed audio; stop
  works; auto-read reads new replies; absent config hides the control.

## Open questions before commit 1

1. **Self-host vs hosted default.** **Default: support both via the
   adapter; document self-host Chatterbox as the privacy path.**
2. **Caps.** **Default: 5k chars per request; longer messages chunk +
   queue.**
3. **Mobile/autoplay constraints.** Browser autoplay rules need a user
   gesture. **Default: read-aloud is gesture-initiated; auto-read only
   after the user has interacted.**

## Reopen / future work

- **Full voice mode** — pair with streaming STT (the catch-up
  voice-input item) for hands-free conversation + barge-in.
- **Local in-browser TTS** — a WebGPU/transformers.js voice for zero-
  server narration (pairs with the local-first direction).
- **Per-persona voice** — a persona picks its voice.

## Sources

- [Open-source TTS models 2026](https://www.bentoml.com/blog/exploring-the-world-of-open-source-text-to-speech-models)
- [Chatterbox (Resemble AI)](https://www.resemble.ai/learn/models/chatterbox)
- [Popular open-source TTS 2026](https://www.hyperstack.cloud/blog/guides/popular-open-source-text-to-speech-models)
