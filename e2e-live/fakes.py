"""Scripted Anthropic Messages server (:8172) and an MCP server that counts effects (:8173). Local only."""

import asyncio
import collections
import json
import re
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
editor_calls = []
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
    if name == "code":
        return 0, done if n else [use(0, "runCode", {"code": "print(6 * 7)"})]
    if name == "codekid":
        kid = [{"personaSlug": "helper", "subgoal": f"SCENARIO:code/{tag}k"}]
        return 0, done if n else [use(0, "spawnSubagent", {"tasks": kid})]
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


_CONTEXT = re.compile(
    r"Here is the context you should reference when answering the user:\s*<context>\n(.*?)\n</context>",
    re.S,
)


def editor_reply(body):
    """The editor's AI (wave 9): the tool choice, comment / cell elements,
    generate / edit text and the completion, recognisable in the page.
    None for any other request."""
    first = " ".join(b.get("text", "") for b in blocks(body["messages"][0]))
    if (body.get("tool_choice") or {}).get("name") == "json":
        props = body["tools"][0]["input_schema"]["properties"]
        if "result" in props:
            options = props["result"]["enum"]
            pick = "comment" if "EDITOR:comment" in first else "edit" if "EDITOR:edit" in first else "generate"
            return "choose", pick if pick in options else "generate"
        found = _CONTEXT.search(first)
        context = found.group(1) if found else ""
        cells = re.findall(r'<Cell id="([^"]+)">', context)
        if cells:
            return "elements", {"elements": [{"content": f"CELL-{i}", "id": c} for i, c in enumerate(cells)]}
        block = re.search(r'<block id="([^"]+)">\s*(.*?)\s*</block>', context, re.S)
        if not block:
            return "elements", {"elements": []}
        words = " ".join(block.group(2).split()[:2])
        return "elements", {"elements": [{"blockId": block.group(1), "comment": "EDITOR-COMMENT", "content": words}]}
    if first.startswith("You are an inline writing assistant"):
        return "complete", " jumped."
    if first.startswith("<task>") and "content generation assistant" in first:
        return "text", "GENERATED-TEXT"
    if first.startswith("<task>") and "<Selection>" in first:
        return "text", "IMPROVED-TEXT"
    if first.startswith("<task>") and "seamless replacement" in first:
        return "text", "IMPROVED-TEXT"
    return None


def ev(t, **d):
    return f"event: {t}\ndata: {json.dumps({'type': t, **d})}\n\n"


def _start(model):
    return ev(
        "message_start",
        message={
            "id": "m",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 0},
        },
    )


def editor_response(body, kind, payload):
    editor_calls.append(kind)
    if kind == "choose":
        return JSONResponse(
            {
                "id": "m",
                "type": "message",
                "role": "assistant",
                "model": body["model"],
                "content": [{"type": "tool_use", "id": "toolu_e", "name": "json", "input": {"result": payload}}],
                "stop_reason": "tool_use",
                "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            }
        )

    async def stream():
        yield _start(body["model"])
        if kind == "elements":
            raw = json.dumps(payload)
            yield ev("content_block_start", index=0, content_block={"type": "tool_use", "id": "toolu_e", "name": "json", "input": {}})
            for part in (raw[: len(raw) // 2], raw[len(raw) // 2 :]):
                yield ev("content_block_delta", index=0, delta={"type": "input_json_delta", "partial_json": part})
        else:
            yield ev("content_block_start", index=0, content_block={"type": "text", "text": ""})
            for part in (payload[:4], payload[4:]):
                yield ev("content_block_delta", index=0, delta={"type": "text_delta", "text": part})
        yield ev("content_block_stop", index=0)
        stop = "tool_use" if kind == "elements" else "end_turn"
        yield ev("message_delta", delta={"stop_reason": stop, "stop_sequence": None}, usage={"output_tokens": 1})
        yield ev("message_stop")

    return StreamingResponse(stream(), media_type="text/event-stream")


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
    editor = editor_reply(body)
    if editor is not None:
        return editor_response(body, *editor)
    delay, out = script(body)
    if out is None:
        return JSONResponse(
            {
                "type": "error",
                "error": {"type": "invalid_request_error", "message": "scripted failure"},
            },
            status_code=400,
        )

    async def stream():
        yield _start(body["model"])
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


async def page(request):
    """A web page to bookmark (next-free.spec.ts): its title and body show once fetched."""
    name = request.path_params["name"]
    html = (
        f"<!doctype html><html><head><title>Live page {name}</title>"
        f'<meta name="description" content="A page the fake serves."></head>'
        f"<body><main><h1>Live page {name}</h1><p>Body text of {name}.</p></main></body></html>"
    )
    return Response(html, media_type="text/html; charset=utf-8")


async def state(_request):
    return JSONResponse(
        {
            "effects": effects,
            "invalid": invalid,
            "requests": len(requests),
            "last": requests[-1] if requests else None,
            "all_text": json.dumps(requests),
            "images": images_made,
            "editor": editor_calls,
        }
    )


app = Starlette(
    routes=[
        Route("/v1/messages", messages, methods=["POST"]),
        Route("/v1/image_generation", image_generation, methods=["POST"]),
        Route("/img/{name}", image),
        Route("/page/{name}", page),
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
