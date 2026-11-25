"""Scripted Anthropic Messages server (:8172) and an MCP server that counts effects (:8173). Local only."""

import asyncio
import collections
import json
import threading

import uvicorn
from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

effects = collections.Counter()
requests = []
invalid = []
odd = collections.Counter()
images_made = []
# A 1x1 PNG: what the fake image endpoint's URLs serve.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c63f8cfc0f01f0005000201ff5a5f"
    "9f0b0000000049454e44ae426082"
)
mcp = FastMCP("fake", stateless_http=True, json_response=True, log_level="WARNING", port=8173)


@mcp.tool(description="Record an effect.")
def record(label: str) -> str:
    effects[label] += 1
    return f"recorded {label}"


def blocks(m):
    c = m.get("content")
    return [{"type": "text", "text": c}] if isinstance(c, str) else (c or [])


def validate(body):
    ms = body.get("messages") or []
    if not ms:
        return "no messages"
    if "system" in body and body["system"] is None:
        return "system: null"
    for i, m in enumerate(ms):
        bs = blocks(m)
        if not bs:
            return f"messages.{i}: empty content"
        for b in bs:
            extra = (
                set(b) - {"type", "text", "cache_control", "citations"}
                if b.get("type") == "text"
                else set()
            )
            if extra:
                return f"messages.{i}: extra inputs in text block: {sorted(extra)}"
        uses = [b["id"] for b in bs if b.get("type") == "tool_use"]
        if uses:
            nxt = blocks(ms[i + 1]) if i + 1 < len(ms) and ms[i + 1].get("role") == "user" else []
            got = [b.get("tool_use_id") for b in nxt if b.get("type") == "tool_result"]
            if sorted(got) != sorted(uses):
                return f"messages.{i}: tool_use {uses} answered by {got}"
        res = [b.get("tool_use_id") for b in bs if b.get("type") == "tool_result"]
        if res:
            prev = (
                [b.get("id") for b in blocks(ms[i - 1]) if b.get("type") == "tool_use"] if i else []
            )
            if sorted(res) != sorted(prev):
                return f"messages.{i}: stray tool_result {res}"
    return None


def script(body):
    ms = body["messages"]
    first = " ".join(b.get("text", "") for b in blocks(ms[0]))
    if "SCENARIO:" not in first:
        return 0, [("text", "ok")]
    name, _, tag = first.split("SCENARIO:")[1].split()[0].partition("/")
    n = sum(
        1
        for m in ms
        if m["role"] == "user" and any(b.get("type") == "tool_result" for b in blocks(m))
    )
    tools = [t["name"] for t in body.get("tools", [])]
    free = next((t for t in tools if t.startswith("mcp__aaaaaaaa")), "mcp__missing_free__record")
    gated = next((t for t in tools if t.startswith("mcp__bbbbbbbb")), "mcp__missing_gated__record")

    def use(i, t, a):
        return ("tool", f"{tag}-{name}-{n}-{i}", t, a)

    ask = use(9, "askUser", {"prompt": "Which one?"})
    done = [("text", f"FINAL {name}")]
    if name == "multi":
        return 0, done if n else [
            ("text", "Working."),
            use(0, free, {"label": f"{tag}:lookup"}),
            use(1, gated, {"label": f"{tag}:one"}),
            use(2, gated, {"label": f"{tag}:two"}),
        ]
    if name == "seq":
        return 0, done if n >= 2 else [
            ("text", "Working."),
            use(1, gated, {"label": f"{tag}:q{n + 1}"}),
        ]
    if name == "applyfail":
        return (400, None) if n else (0, [use(1, gated, {"label": f"{tag}:sent"})])
    if name == "slowgate":
        return 5, [use(1, gated, {"label": f"{tag}:late"})]
    if name == "slowafter":
        return (6, done) if n else (0, [use(1, gated, {"label": f"{tag}:first"})])
    if name == "child":
        return 0, done if n else [ask]
    if name == "spawn":
        kids = [
            {"personaSlug": "helper", "subgoal": f"SCENARIO:child/{tag}c"},
            {"personaSlug": "helper", "subgoal": f"SCENARIO:quick/{tag}q"},
        ]
        return 0, done if n else [
            use(0, free, {"label": f"{tag}:beside"}),
            use(1, "spawnSubagent", {"tasks": kids}),
        ]
    if name == "draw":
        return 0, done if n else [use(0, "generateImage", {"prompt": f"{tag} cat"})]
    if name == "drawkid":
        kid = [{"personaSlug": "helper", "subgoal": f"SCENARIO:draw/{tag}k"}]
        return 0, done if n else [use(0, "spawnSubagent", {"tasks": kid})]
    if name == "respawn":
        if n == 0:
            return 0, [ask]
        if n == 1:
            return 0, [
                use(
                    1,
                    "spawnSubagent",
                    {"tasks": [{"personaSlug": "helper", "subgoal": f"SCENARIO:quick/{tag}q"}]},
                )
            ]
    return 0, done


async def messages(request):
    body = await request.json()
    problem = validate(body)
    requests.append(body)
    if problem:
        invalid.append(problem)
        return JSONResponse(
            {"type": "error", "error": {"type": "invalid_request_error", "message": problem}},
            status_code=400,
        )
    delay, out = script(body)
    if out is None:
        return JSONResponse(
            {
                "type": "error",
                "error": {"type": "invalid_request_error", "message": "scripted failure"},
            },
            status_code=400,
        )

    def ev(t, **d):
        return f"event: {t}\ndata: {json.dumps({'type': t, **d})}\n\n"

    async def stream():
        yield ev(
            "message_start",
            message={
                "id": "m",
                "type": "message",
                "role": "assistant",
                "model": body["model"],
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 0},
            },
        )
        if delay:
            await asyncio.sleep(delay)
        for i, b in enumerate(out):
            if b[0] == "text":
                yield ev("content_block_start", index=i, content_block={"type": "text", "text": ""})
                yield ev("content_block_delta", index=i, delta={"type": "text_delta", "text": b[1]})
            else:
                yield ev(
                    "content_block_start",
                    index=i,
                    content_block={"type": "tool_use", "id": b[1], "name": b[2], "input": {}},
                )
                yield ev(
                    "content_block_delta",
                    index=i,
                    delta={"type": "input_json_delta", "partial_json": json.dumps(b[3])},
                )
            yield ev("content_block_stop", index=i)
        stop = "tool_use" if any(b[0] == "tool" for b in out) else "end_turn"
        yield ev(
            "message_delta",
            delta={"stop_reason": stop, "stop_sequence": None},
            usage={"output_tokens": 1},
        )
        yield ev("message_stop")

    return StreamingResponse(stream(), media_type="text/event-stream")


async def image_generation(request):
    """Minimax's `/v1/image_generation`, scripted: one image per call, at a
    URL this server serves (as Minimax's temporary CDN would)."""
    body = await request.json()
    url = f"http://127.0.0.1:8172/img/{len(images_made)}.png"
    images_made.append({"prompt": body.get("prompt"), "url": url})
    return JSONResponse(
        {"data": {"image_urls": [url]}, "base_resp": {"status_code": 0, "status_msg": "success"}}
    )


async def image(_request):
    return Response(PNG, media_type="image/png")


async def state(_request):
    return JSONResponse(
        {
            "effects": effects,
            "invalid": invalid,
            "requests": len(requests),
            "last": requests[-1] if requests else None,
            "all_text": json.dumps(requests),
            "images": images_made,
        }
    )


app = Starlette(
    routes=[
        Route("/v1/messages", messages, methods=["POST"]),
        Route("/v1/image_generation", image_generation, methods=["POST"]),
        Route("/img/{name}", image),
        Route("/state", state),
    ]
)
threading.Thread(
    target=lambda: uvicorn.run(
        mcp.streamable_http_app(), host="127.0.0.1", port=8173, log_level="error"
    ),
    daemon=True,
).start()
uvicorn.run(app, host="127.0.0.1", port=8172, log_level="error")
