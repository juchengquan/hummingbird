"""Provider probe (wave 10, Q114 / Q120): can each catalog model be reached
in the Anthropic Messages format through its catalog route?

For every model in `config/models.json` whose route's provider has a key in
the repo's `.env`, one real call each:

  stream    a streamed reply ("Say OK")
  tools     a tool call when asked to (`tool_choice: auto`)
  thinking  extended thinking, only where `supportsReasoningEffort`
  vision    a 2x2 PNG described, only where `supportsVision`
  fallback  OpenRouter only: a bogus primary with the route's `fallbacks`
            as `models` — answered means OpenRouter honours the list (Q118)

Reads only the provider variables from `.env` (never printed). Prints one
row per model and writes the table as JSON to the path given with `--out`.

    cd services/agent-py && uv run python scripts/probe_providers.py --out /path/probe.json
    ... --only openai/gpt-5.5   # one model
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic

ROOT = Path(__file__).resolve().parents[3]
KEYS = (
    "AI_GATEWAY_API_KEY",
    "OPENROUTER_API_KEY",
    "MINIMAX_CN_API_KEY",
    "MINIMAX_CN_BASE_URL",
    "OLLAMA_BASE_URL",
    "OLLAMA_API_KEY",
    "ANTHROPIC_API_KEY",
)
GATEWAY_URL = "https://ai-gateway.vercel.sh"
# An 8x8 red PNG.
PNG = base64.b64encode(
    bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000080000000808020000004b6d29"
        "dc0000001249444154789c63f8cfc0801561171db4120028ff3fc16eecdf6100"
        "00000049454e44ae426082"
    )
).decode()
WEATHER = {
    "name": "get_weather",
    "description": "The current weather in a city.",
    "input_schema": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}


def read_env() -> dict[str, str]:
    env: dict[str, str] = {}
    path = ROOT / ".env"
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        name, sep, value = line.partition("=")
        if sep and name.strip() in KEYS:
            env[name.strip()] = value.strip().strip('"').strip("'")
    return {k: v for k, v in env.items() if v}


def strip_v1(url: str) -> str:
    url = url.rstrip("/")
    return url[: -len("/v1")] if url.endswith("/v1") else url


def client_for(via: str, env: dict[str, str]) -> AsyncAnthropic | None:
    """The route's provider in the Messages format, or None without a key."""
    if via == "anthropic" and "ANTHROPIC_API_KEY" in env:
        return AsyncAnthropic(api_key=env["ANTHROPIC_API_KEY"])
    if via == "gateway" and "AI_GATEWAY_API_KEY" in env:
        return AsyncAnthropic(
            base_url=GATEWAY_URL, auth_token=env["AI_GATEWAY_API_KEY"], api_key=None
        )
    if via == "openrouter" and "OPENROUTER_API_KEY" in env:
        return AsyncAnthropic(
            base_url="https://openrouter.ai/api", auth_token=env["OPENROUTER_API_KEY"], api_key=None
        )
    if via == "minimax-cn" and "MINIMAX_CN_API_KEY" in env and "MINIMAX_CN_BASE_URL" in env:
        return AsyncAnthropic(
            base_url=strip_v1(env["MINIMAX_CN_BASE_URL"]), api_key=env["MINIMAX_CN_API_KEY"]
        )
    if via == "ollama" and "OLLAMA_BASE_URL" in env:
        return AsyncAnthropic(
            base_url=strip_v1(env["OLLAMA_BASE_URL"]), api_key=env.get("OLLAMA_API_KEY") or "ollama"
        )
    return None


def short(err: BaseException) -> str:
    text = f"{type(err).__name__}: {err}"
    return text if len(text) <= 160 else text[:157] + "..."


async def check(name: str, coro: Any) -> tuple[str, str]:
    try:
        return name, await asyncio.wait_for(coro, timeout=90)
    except Exception as err:  # the probe reports every failure
        return name, "FAIL " + short(err)


async def probe_model(model: dict[str, Any], env: dict[str, str]) -> dict[str, Any]:
    row: dict[str, Any] = {"id": model["id"], "route": None, "checks": {}}
    routes = list(model["routes"])
    if model["id"].startswith("anthropic/") and "ANTHROPIC_API_KEY" in env:
        # Q115: Anthropic directly when its key is set, else the catalog route.
        upstream_id = model.get("anthropicModelId") or model["id"].removeprefix("anthropic/")
        routes.insert(0, {"via": "anthropic", "upstreamId": upstream_id})
    picked = next(((r, c) for r in routes if (c := client_for(r["via"], env)) is not None), None)
    if picked is None:
        row["checks"] = {"skipped": "no key for any route"}
        return row
    route, client = picked
    upstream = route.get("upstreamId") or model["id"]
    row["route"] = f"{route['via']} -> {upstream}"

    async def stream() -> str:
        text = ""
        async with client.messages.stream(
            model=upstream,
            max_tokens=64,
            messages=[{"role": "user", "content": "Reply with exactly: OK"}],
        ) as s:
            async for chunk in s.text_stream:
                text += chunk
        return f"ok {text.strip()[:30]!r}"

    async def tools() -> str:
        msg = await client.messages.create(
            model=upstream,
            max_tokens=256,
            tools=[WEATHER],  # type: ignore[list-item]
            messages=[{"role": "user", "content": "What's the weather in Paris? Use the tool."}],
        )
        used = [b for b in msg.content if b.type == "tool_use"]
        if not used:
            return f"FAIL no tool_use (stop_reason={msg.stop_reason})"
        return f"ok {used[0].name}({json.dumps(used[0].input)[:40]})"

    async def thinking() -> str:
        msg = await client.messages.create(
            model=upstream,
            max_tokens=2048,
            thinking={"type": "enabled", "budget_tokens": 1024},
            messages=[{"role": "user", "content": "What is 17 * 23? Answer with the number."}],
        )
        kinds = sorted({b.type for b in msg.content})
        return f"ok blocks={kinds}"

    async def vision() -> str:
        msg = await client.messages.create(
            model=upstream,
            max_tokens=64,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": "image/png", "data": PNG},
                        },
                        {"type": "text", "text": "What colour is this image? One word."},
                    ],
                }
            ],
        )
        text = "".join(b.text for b in msg.content if b.type == "text")
        return f"ok {text.strip()[:30]!r}"

    async def fallback() -> str:
        msg = await client.messages.create(
            model="probe/does-not-exist",
            max_tokens=32,
            messages=[{"role": "user", "content": "Reply with exactly: OK"}],
            extra_body={"models": route["fallbacks"]},
        )
        return f"ok answered by {getattr(msg, 'model', '?')}"

    jobs = [check("stream", stream()), check("tools", tools())]
    if model.get("supportsReasoningEffort"):
        jobs.append(check("thinking", thinking()))
    if model.get("supportsVision"):
        jobs.append(check("vision", vision()))
    if route["via"] == "openrouter" and route.get("fallbacks"):
        jobs.append(check("fallback", fallback()))
    row["checks"] = dict(await asyncio.gather(*jobs))
    return row


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--only")
    args = parser.parse_args()
    # The SDK falls back to these when a client leaves `api_key` / the URL
    # unset: an Anthropic key must never reach another provider.
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
        os.environ.pop(name, None)
    env = read_env()
    print("providers with keys:", sorted(k for k in env if not k.endswith("_BASE_URL")) or "none")
    catalog = json.loads((ROOT / "config" / "models.json").read_text())["models"]
    models = [m for m in catalog if not args.only or m["id"] == args.only]
    rows = await asyncio.gather(*(probe_model(m, env) for m in models))
    for row in rows:
        print(f"{row['id']:<42} {row['route'] or '-'}")
        for name, result in row["checks"].items():
            print(f"    {name:<9} {result}")
    Path(args.out).write_text(json.dumps(rows, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
