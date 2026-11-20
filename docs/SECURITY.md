# Security headers & Content-Security-Policy

Operational notes for the browser-facing security headers. Code:

| Piece | Where |
|---|---|
| Policy builder (pure, unit-tested) | `lib/server/security/csp.ts` |
| Per-request nonce + CSP header | `proxy.ts` (Next 16's name for `middleware.ts`) |
| Nonce on the inline theme script | `app/layout.tsx` (`x-nonce` request header) |
| Report intake | `app/api/csp-report/route.ts` → `lib/server/security/csp-report.ts` |
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
frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://www.dailymotion.com https://coub.com https://player.youku.com;
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
- **`frame-src`.** The media-embed players (`components/ui/media-embed-node.tsx`).
  Live-artifact and MCP-app frames use `srcdoc`, which `frame-src` does
  not govern. See the next section.
- **`frame-ancestors 'none'`.** No page is meant to be embedded, share
  links included. Browsers ignore this directive in a Report-Only
  policy, so `X-Frame-Options: DENY` enforces it in every mode.

Adding a new third-party origin that the browser fetches, frames or
connects to means updating the builder and its test.

## Prerequisite before `enforce`: sandboxed `srcdoc` frames

`components/live-artifact/live-artifact-frame.tsx` and `mcp-app-frame.tsx`
render untrusted HTML in `<iframe sandbox="allow-scripts" srcdoc=…>`.
Per the HTML spec, a `srcdoc` document **inherits the parent's policy
container**, so this app policy applies inside the frame on top of the
frame's own `<meta>` CSP. The browser check confirmed it: an inline
script in a sandboxed `srcdoc` frame raised a `script-src-elem`
violation for the parent's policy. In report-only mode the frame still
works and reports arrive with `"srcdoc":true` and `"document":"about:srcdoc"`.
In `enforce` mode, every artifact and MCP-app script would be blocked:
inline scripts, the unpkg / jsdelivr / tailwind CDN scripts, and Babel's
eval. A policy tweak can't fix this, because `'unsafe-inline'` is ignored
whenever a nonce is present.

Before flipping to `enforce`, move those frames off `srcdoc`. For
example, load them from a dedicated route (`src="/sandbox/…"`,
`sandbox="allow-scripts"`, excluded from the proxy matcher) that sends
the shell's own CSP as a response header, and post the HTML in. Or host
them on a separate origin. Then drop the srcdoc lines from the
checklist below.

## Other headers (`next.config.ts`, every response)

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security: max-age=31536000`, production builds only.
  Browsers ignore it over plain http, so `bun run start` on localhost is
  unaffected. It has no `includeSubDomains` / `preload`, because sibling
  subdomains may not be https. Raise it once the domain is settled.

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
| `"srcdoc":true` | Live-artifact / MCP-app frame (see above). Expected until those frames move off `srcdoc` |
| `script-src` `eval` from a `_next/static` chunk | A library probing or using `eval`. Known benign case: the `is-generator-function` probe in the Node `util` polyfill, about once per `/editor` load. It's a `try/catch` probe, so `enforce` won't break anything |
| `connect-src` / `img-src` / `frame-src` with a real host | A feature talks to a host the builder doesn't list. Add the host if legitimate |
| `script-src-elem` `inline` on an app page | An inline script without the nonce. Fix the code (pass the `x-nonce` value) rather than loosening the policy |

## When to flip to `enforce`

1. Move the srcdoc frames as described above.
2. Run report-only in production long enough to cover real use: chat
   with artifacts, the editor (equations, embeds, export), file viewers
   (PDF / DOCX / CSV), signed-in sync and task runs.
3. Confirm that the remaining reports are only extension noise and the
   known benign probes listed above.
4. Set `CSP_MODE=enforce` and restart. Keep watching the reports.
   `CSP_MODE=report-only` is the one-line rollback.
