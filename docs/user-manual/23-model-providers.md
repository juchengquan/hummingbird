<!-- related: config/providers.json, config/models.json, lib/server/model-provider.ts, lib/server/skills/minimax-image-client.ts -->

# Model providers

## What it is
Hummingbird talks to model providers through `config/providers.json`
and `config/models.json`. The first declares how to talk to each
provider; the second declares which models exist and how to route
them.

## Supported providers

| Provider | Type | Auth |
|---|---|---|
| `gateway` (Vercel AI Gateway) | `gateway` | `AI_GATEWAY_API_KEY` |
| `minimax-cn` (Anthropic-compatible) | `anthropic` | `MINIMAX_CN_BASE_URL` + `MINIMAX_CN_API_KEY` |
| `ollama` (local) | `openai` | Optional `OLLAMA_API_KEY`; `allowInsecureBaseUrl: true` |
| `openrouter` | `openai` | `OPENROUTER_API_KEY` |

## Adding a model

Two files, one PR:

1. **Provider entry** in `config/providers.json` if it's a new
   provider. Existing providers already there.
2. **Model entry** in `config/models.json`. Each model has an id
   (e.g. `openrouter/anthropic/claude-sonnet-4.5`), a list of
   `routes` (one or more `{via, ...}` entries that pick the
   provider), and optionally a `fallbacks` array of upstream ids
   the provider should try in order.

## Per-route fallback list

For OpenRouter models, declare a `fallbacks: [...]` array of
upstream model ids in `config/models.json`. The dispatcher injects
this as `body.models` on every OpenRouter request, so when the
primary upstream is overloaded or errored, OpenRouter tries the
fallbacks in order without re-sending.

## Tips & gotchas
- Only enable the Ollama provider for endpoints you control. By
  setting `OLLAMA_BASE_URL` you accept that the URL is trusted
  not to exfiltrate any header the AI SDK may attach.
- The `minimax-cn` provider requires BOTH
  `MINIMAX_CN_BASE_URL` AND `MINIMAX_CN_API_KEY` to activate.
  Either var unset -> falls through to the gateway.
- `openrouter/auto` lets OpenRouter pick the upstream per request
  based on prompt length, latency budget, and price. Use it for
  one-id-fits-all setups.

## Related
- [Environment variables](21-environment-variables.md)
- [Architecture overview](27-architecture-overview.md)
