# Security headers & Content-Security-Policy

Operational notes for the browser-facing security headers. Code:

| Piece | Where |
|---|---|
| Policy builder (pure, unit-tested) | `lib/server/security/csp.ts` |
| Per-request nonce + CSP header | `proxy.ts` (Next 16's name for `middleware.ts`) |
| Nonce on the inline theme script | `app/layout.tsx` (`x-nonce` request header) |
| Report intake | `app/api/csp-report/route.ts` → `lib/server/security/csp-report.ts` |
| Artifact / MCP-app frame shell + its own CSP | `app/sandbox/frame/route.ts` → `lib/server/security/sandbox-frame.ts` |
| Frame handshake (protocol, iframe) | `lib/shared/sandbox-frame.ts`, `components/live-artifact/sandboxed-frame.tsx` |
| Static headers | `next.config.ts` → `headers()` |
| Zod JIT opt-out (keeps eval out of reports) | `instrumentation-client.ts` |

## Modes — `CSP_MODE`

| Value | Header | Effect |
|---|---|---|
| `report-only` (default; also unset / unknown) | `Content-Security-Policy-Report-Only` | Nothing blocked; violations reported |
| `enforce` | `Content-Security-Policy` | Violations blocked and reported |
| `off` | none | No CSP. Static headers below still apply |

Switching mode is a config change plus restart, no rebuild. Pages render
dynamically either way: the root layout reads `headers()` for the nonce,
and a prerendered page couldn't carry a per-request nonce.

## The policy

Example (production, Supabase configured, no remote backends):

```
default-src 'self';
script-src 'self' 'nonce-<per request>' 'strict-dynamic';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:;
media-src 'self' data: blob: https:;
font-src 'self' data:;
connect-src 'self' https://<project>.supabase.co wss://<project>.supabase.co https://react-tweet.vercel.app data: blob:;
worker-src 'self' blob:;
frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://www.dailymotion.com https://coub.com https://player.youku.com;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';
report-uri /api/csp-report; report-to csp-endpoint
```

Dev (`NODE_ENV=development`) adds `'unsafe-eval'` to `script-src`, which
React's dev tooling needs.

Why each non-obvious source is there:

- **Scripts.** Nonce + `'strict-dynamic'`. Next stamps the nonce on its
  own scripts after reading it from the request's CSP header. Chunks the
  runtime loads later are trusted through `'strict-dynamic'`. No
  `'wasm-unsafe-eval'`: nothing on the main thread compiles WebAssembly.
  pdfjs decodes inside its worker, and the Excalidraw plugin isn't
  mounted.
- **Styles: `'unsafe-inline'`, no nonce.** React SSR emits `style="…"`
  attributes. KaTeX renders through `innerHTML` with style attributes.
  Radix, floating-ui, Plate and sonner inject inline styles and `<style>`
  tags. Nonces can't cover style *attributes*, and a nonce in
  `style-src` makes browsers ignore `'unsafe-inline'`. CSS injection is
  much weaker than script injection: scripts stay strict, and
  `connect-src` / `img-src` limit what injected CSS can exfiltrate.
- **`img-src` / `media-src` `https:`.** Images and media come from an
  open-ended host set: generated images, Supabase signed URLs, markdown
  images in model output, favicons, YouTube and tweet thumbnails, and
  editor media nodes. Pinning that list would break real content.
- **`connect-src`.** Same origin, plus Supabase (https for REST/Storage,
  wss for Realtime `task_events`), plus the `NEXT_PUBLIC_API_BASE_URL` /
  `NEXT_PUBLIC_AGENT_PY_URL` / `NEXT_PUBLIC_AGENT_TS_URL` origins when
  set, plus react-tweet's API. `data:` / `blob:` cover the editor's
  export (`fetch(canvas.toDataURL())`) and viewers that re-read object
  URLs they created. MCP servers are reached through `/api/mcp/*`, never
  directly from the browser.
- **`worker-src 'self' blob:`.** The pdfjs worker is a same-origin module
  script under `/_next/static/media/`.
- **`frame-src`.** `'self'` for the sandbox frame shell (`/sandbox/frame`,
  next section), plus the media-embed players
  (`components/ui/media-embed-node.tsx`).
- **`frame-ancestors 'none'`.** No page is meant to be embedded, share
  links included. Browsers ignore this directive in a Report-Only
  policy, so `X-Frame-Options: DENY` enforces it in every mode.

Adding a new third-party origin that the browser fetches, frames or
connects to means updating the builder and its test.

## Live-artifact and MCP-app frames: `/sandbox/frame`

Live artifacts (`components/live-artifact/live-artifact-frame.tsx`) and
MCP-app panels (`mcp-app-frame.tsx`) run untrusted HTML. Both render
through `SandboxedFrame` (`components/live-artifact/sandboxed-frame.tsx`):

```html
<iframe src="/sandbox/frame?n=<per-navigation nonce>" sandbox="allow-scripts" referrerpolicy="no-referrer">
```

**Why not `srcdoc`.** A `srcdoc` document inherits the parent's policy
container, so the app policy applied inside those frames on top of
their `<meta>` CSP. Under `enforce` that blocked every artifact script:
inline scripts, the unpkg / jsdelivr / tailwind CDN scripts and Babel's
eval. `'unsafe-inline'` can't be added to the app policy because a nonce
makes browsers ignore it. The frames used to be the only blocker for
`enforce`; they no longer are.

**The shell.** `GET /sandbox/frame` returns a tiny static document whose
response CSP (`lib/server/security/sandbox-frame.ts`) is written for
untrusted code and is **always enforced**, whatever `CSP_MODE` says — it
is the frame's security boundary, as the `<meta>` CSP always was:

```
default-src 'none';
script-src 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.tailwindcss.com https://cdn.jsdelivr.net;
style-src 'unsafe-inline' https://unpkg.com https://cdn.tailwindcss.com https://cdn.jsdelivr.net;
img-src data: blob: https:; font-src data: blob: <CDN hosts>;
connect-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors 'self'; sandbox allow-scripts
```

- The CDN hosts are `CDN_HOSTS` in `lib/shared/live-artifact/cdn-urls.ts`,
  shared with the `<meta>` CSP that `iframe-shell.ts` still writes into
  each document (defense in depth; the two stack).
- `img-src https:` is deliberate: generated pages routinely show remote
  images, and the frame can't be made exfiltration-proof anyway (it can
  navigate itself; WebRTC and DNS prefetch aren't governed by
  `connect-src`). It only holds what it was given — its own source and
  MCP tool results — never the app's cookies or storage. `font-src` has
  no such need and is limited to inline fonts and the CDN hosts.
- `connect-src 'none'`: generated code can't fetch anywhere. MCP-app
  tool calls go through the parent's postMessage bridge, which keeps its
  same-server, `enabled` and `requiresApproval` checks.
- `sandbox allow-scripts` repeats the iframe attribute, so the shell is
  an opaque origin even when opened top-level or framed without the
  attribute. `frame-ancestors 'self'` stops other sites from framing it.
- No `report-uri`: violations in here are untrusted code hitting the
  fence (blocked fetches), not app regressions.
- `proxy.ts` excludes the route from its matcher and also skips it in
  code, so the app policy never overwrites the shell's. `next.config.ts`
  sends `X-Frame-Options: SAMEORIGIN` for it instead of `DENY`.
- `Cache-Control: no-cache` + ETag: every load revalidates (304), so a
  deploy that changes the policy takes effect at once.

**Never add `allow-same-origin`** to these iframes. The shell is served
from the app's origin, so with that flag the artifact would run
same-origin with full access to cookies, storage and the API.
`components/live-artifact/sandbox-guard.test.ts` pins the attribute.

**Handshake** (`lib/shared/sandbox-frame.ts`). The frame is an opaque
origin, so both sides post with target `"*"` and check the sender
instead:

1. The shell (once loaded) posts `{ ns: "sandbox-frame", type:
   "shell-ready", nonce }` to its parent, echoing the `?n=` nonce of its
   URL. Every navigation the parent starts gets a fresh random nonce.
2. The parent checks `event.source === iframe.contentWindow` and that the
   nonce is the one it just navigated with, then posts `{ ns:
   "sandbox-frame", type: "render", nonce, html }` — once per navigation.
   Without the nonce the previous, already-rendered (untrusted) document
   could answer first and be handed the next artifact's source.
3. The shell accepts it only if `event.source === window.parent` and
   `event.origin === location.origin` (the app page that framed it),
   removes its listener and replaces itself with the HTML
   (`document.open/write/close`). The policy container survives
   `document.open`, so the shell's CSP keeps applying.
4. It then hooks `pagehide` and posts `{ type: "navigating", nonce }`
   when the rendered document is navigated away from. The iframe keeps
   its `contentWindow` across a self-navigation, so `event.source` alone
   would keep trusting whatever page loads next; this message (delivered
   with `event.source === null` — the nonce authenticates it) arrives
   before anything the next document posts. `SandboxedFrame` reports it
   (`onNavigatedAway`, with an extra-`load` backstop) and the MCP-app
   frame drops its tool-call bridge and shows a "navigated away —
   reload" plate.

New HTML (artifact edit, MCP-app refresh, theme change) or the panel's
Refresh button re-navigates the frame and runs the handshake again —
the same full reload a `srcdoc` change caused. After the swap, the frame
speaks only the content's own protocols (`live-artifact` ready/error,
`mcp-app` tool calls), whose parent listeners keep their `event.source`
filters.

## Other headers (`next.config.ts`, every response)

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security: max-age=31536000`, production builds only.
  Browsers ignore it over plain http, so `bun run start` on localhost is
  unaffected. It has no `includeSubDomains` / `preload`, because sibling
  subdomains may not be https. Raise it once the domain is settled.

## Per-IP rate limits need a reverse proxy

Anonymous callers are rate-limited per client IP (`rateLimitKey` in
`lib/server/rate-limit.ts`: `/api/extract`, `/api/url/fetch`,
`/api/ai/complete`, the MCP proxy without Supabase, chat web tools,
CSP reports). Route handlers never see the socket peer, so the IP comes
from `X-Forwarded-For`, read `TRUSTED_PROXY_HOPS` entries from the right.

That only works with a reverse proxy (Caddy, Nginx, a platform edge)
that appends the real peer to `X-Forwarded-For`. `next start` itself
sets the header only when the request has none, so with Next.js exposed
directly a client that sends `X-Forwarded-For: <anything>` chooses its
own key and gets a fresh bucket per value. `TRUSTED_PROXY_HOPS=0` closes
that, but then every anonymous caller shares one bucket.

At boot (`instrumentation.ts` → `warnOnProxyConfig`) a production server
outside a known platform (Vercel, Render, Fly, Railway, Cloud Run,
Netlify) logs a warning when `TRUSTED_PROXY_HOPS` is unset or `0`.
Setting it explicitly to the number of proxies confirms the setup and
silences the warning. Signed-in limits (MCP proxy, `/api/embed`) key on
the user id and don't depend on any of this.

## Reading reports

Each violation is logged as one line through `console.warn`:

```json
{"evt":"csp_violation","via":"report-uri","directive":"script-src-elem","blocked":"https://cdn.example.com/x.js","document":"https://app/dashboard","source":"https://app/_next/static/chunks/abc.js","line":1,"column":2345,"disposition":"report"}
```

To get them, grep the server logs for `"evt":"csp_violation"` and group
by `directive` + `blocked`. Logged URLs are cut to origin + path, and
share tokens are redacted. The script sample and the original policy
are never logged. The endpoint accepts `application/csp-report`
(`report-uri`), `application/reports+json` (Reporting API) and
`application/json`. It caps bodies at 16 KiB, allows 60 posts per
minute per client IP, and always answers with an empty body.

The `via` field shows which delivery path the browser used. Chrome
switches to `report-to` / `Reporting-Endpoints` whenever it is present
and then ignores `report-uri`. The Reporting API batches reports and
sends them out of band. Firefox and Safari use `report-uri` right away.

**Unverified: Chrome delivery through the Reporting API.** Headless
Chrome on `http://localhost` delivered `report-uri` reports right
away. It never delivered a Reporting-API report, whether the endpoint
was relative or absolute, even after 200 seconds. Before treating "no
reports" as "clean", confirm that `"via":"reporting-api"` lines appear
from the real https deployment. If none appear, remove `report-to` from
the builder so Chrome falls back to `report-uri`.

To watch violations live while testing, use the DevTools console, which
logs every Report-Only violation, or a `securitypolicyviolation`
listener.

Triage:

| Pattern | Meaning |
|---|---|
| `blocked` = `chrome-extension:` / `moz-extension:` / `safari-web-extension:` | Browser extension noise. Ignore |
| `"srcdoc":true` | A `srcdoc` frame inheriting the app policy. Live-artifact and MCP-app frames no longer use `srcdoc`, so find the new one and move it to `/sandbox/frame` |
| `script-src` `eval` from a `_next/static` chunk | A library probing or using `eval`. Known benign case: the `is-generator-function` probe in the Node `util` polyfill, about once per `/editor` load. It's a `try/catch` probe, so `enforce` won't break anything |
| `connect-src` / `img-src` / `frame-src` with a real host | A feature talks to a host the builder doesn't list. Add the host if legitimate |
| `script-src-elem` `inline` on an app page | An inline script without the nonce. Fix the code (pass the `x-nonce` value) rather than loosening the policy |

## When to flip to `enforce`

1. ~~Move the srcdoc frames off `srcdoc`.~~ Done: they load
   `/sandbox/frame` (above). Checked with `bun run build && CSP_MODE=enforce
   bun run start` in headless Chromium and WebKit: inline artifact
   scripts, the Tailwind and Mermaid CDN scripts, Babel's eval, the error
   bridge, the MCP-app tool-call bridge (including the disabled-server
   refusal) and the panel's Refresh all work; the app page logged no
   violations; the frames' only violations were the expected
   `connect-src 'none'` blocks.
2. Run report-only in production long enough to cover real use: chat
   with artifacts, the editor (equations, embeds, export), file viewers
   (PDF / DOCX / CSV), signed-in sync and task runs.
3. Confirm that the remaining reports are only extension noise and the
   known benign probes listed above.
4. Confirm Chrome's Reporting-API delivery from the https deployment
   (see "Unverified" above), or drop `report-to`, so a quiet log really
   means no violations.
5. Set `CSP_MODE=enforce` and restart. Keep watching the reports.
   `CSP_MODE=report-only` is the one-line rollback.

Found during that check and since fixed: TSX artifacts didn't render
(enforce or not), because the React 19 UMD URLs were a 404 (React 19
publishes no UMD build). The TSX shell now loads React / ReactDOM
18.3.1 UMD. `iframe-shell.ts` compiles the artifact with Babel standalone
(TypeScript + React presets, ES modules → CommonJS) and runs it through
`new Function` with a `require` shim mapping `react` / `react-dom` /
`react-dom/client` to the globals, so `import React, { useState } from
"react"`, multi-line imports and every `export default` form work. Every
`CDN_SCRIPTS` entry is pinned to an exact version. All of them carry an
SRI hash (`integrity` + `crossorigin="anonymous"`) except Tailwind:
`cdn.tailwindcss.com` sends no CORS headers, so an integrity check there
would always fail. `CDN_HOSTS` is unchanged, and a test checks that it
lists exactly the pinned scripts' origins. Checked with
`bun run build && bun run start` under both `CSP_MODE=report-only` and
`enforce` in headless Chromium. A TSX counter (`useState` + `onClick` +
Tailwind classes) rendered and counted clicks in all three import
styles, with no violations in the frame or on the app page. As negative
controls, a tampered hash was blocked and a `fetch()` hit
`connect-src 'none'`.
