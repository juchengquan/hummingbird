# Plan: MCP Apps — interactive server-driven UI inside chat

Status: **🪜 phased — phase 1 (read-only render) + phase 2 (tool-call
bridge) shipped; persistence/refresh polish remains.** Phase 1: #188
(2026-06-11). Phase 2 (this PR): the `mcp-app` postMessage bridge — a
panel can call a tool back through `/api/mcp/:id/call` (same-server only,
per-app call cap). Drafted in the 2026-06-09 market refresh; item
from [MASTER_PLAN § Later](MASTER_PLAN.md) promoted to **Next**. Scope:
**M** (~400–600 LOC + a postMessage protocol shim, one PR with three
commits). Origin: the MCP Apps extension (announced 2026-01-26, spec
finalising 2026-07-28) — see [Source](#sources).

## Why

The MCP Apps extension lets an MCP **tool** return a reference to a
`ui://…` resource — bundled HTML/JS the host renders in a **sandboxed
iframe** directly in the conversation. Instead of a JSON blob, an MCP
tool can paint a dashboard, a form, a multi-step widget. ChatGPT,
Claude, Goose, and VS Code already ship host support.

Hummingbird is unusually well-positioned because it already owns **both
halves** of what MCP Apps needs:

1. **A sandboxed-iframe renderer** — `components/live-artifact/`
   (`LiveArtifactFrame`, shipped via PLAN-live-artifacts / #36). It
   already renders untrusted HTML in `sandbox="allow-scripts"` with a
   null origin, a locked CSP (`connect-src 'none'`), and a
   `postMessage` error/ready bridge namespaced `live-artifact`.
2. **A full MCP integration** — `lib/server/mcp/` builds in-process
   tools (`buildMcpTool` → `mcp__{serverId}__{toolName}`), resolves
   cloud + local servers (`loadEffectiveMcpServers`), and already
   exposes a proxy route (`app/api/mcp/[serverId]/[action]`) with a
   **`read`** action that reads an MCP resource (`readResource`).

So this is mostly *wiring two existing surfaces together*: when an MCP
tool result references a `ui://` resource, read that resource and route
its HTML into the artifact sandbox, then add a `postMessage` bridge so
the rendered UI can call tools back through the same MCP server.

## Non-goals — what this is NOT

- **Not a full MCP Apps host-conformance implementation.** We target
  the subset Hummingbird's surfaces already support: read a `ui://`
  resource, render it sandboxed, allow tool-call callbacks to the
  **same** server. Streamed/reference result types and the broader
  Extensions framework are out of scope for v1.
- **Not the OpenAI Apps SDK.** MCP Apps is the standardised
  superset; we follow the MCP spec, not the OpenAI variant.
- **Not arbitrary network access from the iframe.** The iframe keeps
  `connect-src 'none'`. Its *only* IO channel is `postMessage` to the
  parent; the parent does the network (through the existing MCP proxy,
  server-side, with the user's credentials). This is the security
  invariant.
- **Not a new artifact kind authored by the model.** This renders UI
  authored by an MCP *server*, not TSX the chat model emits — that's
  live-artifacts (#36) and generative-UI-parts (sibling plan).

## Decisions to pin before code

1. **Where the `ui://` resource is fetched.** Server-side, via the
   existing MCP proxy `read` action — keeps server credentials off the
   client and reuses `readResource()`. The resource HTML rides to the
   client inside a new `data-mcp-app` stream part, *not* a client
   `ui://` fetch. **Default: server-side read.**
2. **The stream part shape.** A new AI SDK v5 custom data part
   `data-mcp-app` carrying `{ id, serverId, toolCallId, resourceUri,
   html }`. Mirrors how `data-tool-image` already carries persisted
   image payloads. The emitter helper sits beside `emitter.toolImage`.
3. **The iframe shell.** Reuse `buildShell('html', …)` from
   `lib/client/live-artifact/iframe-shell.ts` unchanged for the CSP +
   sandbox posture, but add a **second** `postMessage` namespace
   `mcp-app` (alongside `live-artifact`) for the tool-call bridge.
4. **The callback bridge protocol.** Iframe → parent:
   `{ ns: "mcp-app", type: "tool-call", callId, name, args }`. Parent
   forwards to `POST /api/mcp/{serverId}/call` (existing proxy action),
   then posts the result back: `{ ns: "mcp-app", type: "tool-result",
   callId, result | error }`. Source-filtered by
   `e.source === iframeRef.current.contentWindow`, exactly like the
   error bridge does today.
5. **Which server a UI may call.** Only the server that produced the
   app (`serverId` is pinned on the part). No cross-server calls from
   an embedded UI. This caps the blast radius.
6. **Rate + budget.** Bridge tool calls flow through the existing MCP
   proxy, which already carries the per-IP budget + auth. No new gate;
   add a per-app call ceiling (e.g. 50 calls) to stop a runaway widget.

## Shape — code surface

### Server — capture UI metadata at tool-build time

`lib/server/mcp/tools.ts` — when `buildMcpTool(server, descriptor,
credentials)` reads a tool descriptor, also capture
`descriptor._meta?.ui?.resourceUri` (the `ui://…` string, if present)
onto the tool's closure. After the tool executes and returns a result,
if the descriptor declared a UI resource, the chat route reads it:

```ts
// app/api/chat/route.ts — after an mcp__… tool returns
const uiRef = mcpUiRefFor(toolName) // from the build-time capture
if (uiRef) {
  const html = await readMcpResource(server, credentials, uiRef.resourceUri)
  emitter.mcpApp({ id, serverId: server.id, toolCallId, resourceUri: uiRef.resourceUri, html })
}
```

`readMcpResource` is a thin wrapper over the existing
`readResource()` in `lib/server/mcp/client.ts`. A new
`emitter.mcpApp(payload)` emits the `data-mcp-app` AI SDK part (beside
`emitter.toolImage`).

### Wire — translator + store

`lib/client/chat/sse-frame-translator.ts` — `translateFrame` gains a
`"data-mcp-app"` case → `{ type: "mcp_app", id, serverId, toolCallId,
resourceUri, html }`. `NormalisedFrame` union extended with the
`mcp_app` variant.

`lib/client/hooks/store/slices/messages.ts` — new
`appendMessageMcpApp(messageId, app)` mutator pushing onto a new
`Message.mcpApps?: McpApp[]` field (additive; persisted-shape contract
→ migration + `STORE_VERSION` bump per `store/persist.test.ts`).

### Client — the rendered app component

`components/live-artifact/mcp-app-frame.tsx` (new) — wraps the existing
iframe shell and adds the `mcp-app` bridge:

```tsx
export function McpAppFrame({ app }: { app: McpApp }) {
  // srcDoc = buildShell("html", app.html)
  // listen for { ns: "mcp-app", type: "tool-call", callId, name, args }
  //   → apiClient.mcp.proxy({ serverId: app.serverId, action: "call", … })
  //   → postMessage back { ns: "mcp-app", type: "tool-result", callId, result }
  // hard cap on calls per app; surface errors as a toast
}
```

`components/panels/chat-message.tsx` (`ChatMessageImpl`) renders
`<McpAppFrame>` for each entry in `message.mcpApps`, beside the existing
`MessageLiveArtifacts` / `GeneratedImagesGallery` blocks.

### API client

`apiClient.mcp.proxy` already exists (`discover` / `call` / `read`) and
honours the backend selector. The bridge reuses `call`; no new endpoint.

## Sequencing — one PR, three commits

1. **Commit 1 — read-only render (static apps).** Capture
   `_meta.ui.resourceUri` at build time, read the resource server-side,
   emit `data-mcp-app`, translate + store + render in the sandbox. No
   callbacks yet — covers dashboards / visualizations that don't call
   back. Migration + `STORE_VERSION` bump for `Message.mcpApps`.
2. **Commit 2 — the tool-call bridge (interactive apps).** Add the
   `mcp-app` postMessage namespace, the parent-side forward to the
   proxy `call` action, the result round-trip, the per-app call cap,
   and same-server enforcement.
3. **Commit 3 — persistence + polish.** Re-render persisted
   `message.mcpApps` on reload (HTML is stored on the message, so no
   re-read needed); a "refresh" affordance that re-reads the `ui://`
   resource; size cap + truncation toast for oversized resources.

## Tests

- **`translateFrame` (commit 1)** — `data-mcp-app` → `mcp_app` frame,
  fields preserved; unknown shape → `null` (existing robustness).
- **Bridge protocol (commit 2)** — a pure
  `lib/client/live-artifact/mcp-app-bridge.ts` parser/validator for the
  postMessage payloads (tool-call request shape, ignore foreign `ns`,
  call-count ceiling). ~6 cases.
- **Server read path (commit 1)** — `readMcpResource` returns HTML;
  missing `_meta.ui` → no `data-mcp-app` emitted (regression guard so
  ordinary MCP tools are unaffected).
- **Manual smoke (PR checklist)** — point at a reference MCP Apps
  server (the spec repo ships examples), confirm a tool renders a
  panel, a button in the panel round-trips a tool call, and a reload
  re-renders the persisted app.

## Open questions before commit 1

1. **Resource size cap.** `ui://` bundles can be large. **Default: 512
   KB; over that, render a "UI too large" stub + a link to run the
   tool in raw mode.**
2. **Do we persist the HTML or re-read on reload?** Persisting bloats
   localStorage; re-reading needs a live server + credentials.
   **Default: persist (apps are usually small; re-read is the manual
   "refresh" affordance), revisit if storage pressure shows up.**
3. **Theming.** MCP Apps can request host theme tokens. **Default: pass
   a minimal `{ colorScheme: 'dark'|'light' }` on an init postMessage;
   full token passing deferred.**

## Reopen / future work

- **Streamed + reference result types** (on the 2026 MCP roadmap) —
  render progressive updates inside a live app. Defer until the spec
  ships them.
- **Generative-UI-parts convergence** — the in-process React-component
  path (sibling plan) and this iframe path are twins; once both ship,
  document when to reach for which (trusted in-process kinds vs
  untrusted server HTML).

## Sources

- [MCP Apps announcement (2026-01-26)](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
- [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)
- [ext-apps spec + SDK repo](https://github.com/modelcontextprotocol/ext-apps/)
- [mcp-ui](https://mcpui.dev/)
- [MCP 2026 roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
