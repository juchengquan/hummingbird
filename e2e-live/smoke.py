"""Q65: a few real Anthropic calls through the real worker and agent-py chat; with
LIVE_MINIMAX_KEY / LIVE_MINIMAX_URL, MiniMax M3.1 Flash too (wave 10, Q112). No
output of a key."""

import asyncio
import base64
import json
import os
import sys
import uuid

import asyncpg
import httpx

NEXT, PYAPI, SUPA = "http://127.0.0.1:3171", "http://127.0.0.1:8171", "http://127.0.0.1:54871"
HAIKU = "anthropic/claude-haiku-4.5"
MINIMAX = "minimax/minimax-m3.1-flash"


async def main():
    db = await asyncpg.create_pool(os.environ["LIVE_DSN"], min_size=1, max_size=2)
    http = httpx.AsyncClient(timeout=120, trust_env=False)
    s = (
        await http.post(
            f"{SUPA}/auth/v1/signup",
            headers={"apikey": os.environ["LIVE_ANON"]},
            json={"email": f"{uuid.uuid4().hex}@example.test", "password": uuid.uuid4().hex},
        )
    ).json()
    uid, token = s["user"]["id"], s["access_token"]
    raw = "base64-" + base64.urlsafe_b64encode(json.dumps(s).encode()).decode().rstrip("=")
    web, api = (
        {"cookie": f"sb-127-auth-token={raw}", "origin": NEXT},
        {"authorization": f"Bearer {token}"},
    )
    ws, conv = uuid.uuid4(), uuid.uuid4()
    await db.execute(
        "insert into public.workspaces(id,user_id,name) values($1,$2,'smoke')", ws, uuid.UUID(uid)
    )
    await db.execute(
        "insert into public.conversations(id,user_id,workspace_id,title) values($1,$2,$3,'smoke')",
        conv,
        uuid.UUID(uid),
        ws,
    )
    sid = uuid.uuid4()
    caps = {
        "tools": [
            {
                "name": "record",
                "description": "Record a label.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"label": {"type": "string"}},
                    "required": ["label"],
                },
            }
        ]
    }
    async with db.acquire() as c, c.transaction():
        await c.execute(
            "select set_config('request.jwt.claims',$1,true)",
            json.dumps({"sub": uid, "role": "authenticated"}),
        )
        await c.execute("set local role authenticated")
        await c.execute(
            "select public.mcp_upsert_server_with_credentials($1,$2,'recorder','http://127.0.0.1:8173/mcp',$3::jsonb,$4,$5::jsonb,true,true)",
            sid,
            ws,
            json.dumps({"type": "bearer", "headers": {"Authorization": "Bearer local"}}),
            os.environ["LIVE_MCPKEY"],
            json.dumps(caps),
        )

    async def task(prompt):
        r = await http.post(
            f"{NEXT}/api/tasks",
            headers=web,
            json={
                "conversationId": str(conv),
                "workspaceId": str(ws),
                "skills": [],
                "model": HAIKU,
                "messages": [{"role": "user", "content": prompt}],
                "maxSteps": 4,
            },
        )
        assert r.status_code == 202, r.text
        return r.json()["runId"]

    async def settle(rid, want=("done", "failed", "cancelled", "paused")):
        for _ in range(300):
            row = await db.fetchrow(
                "select status, outcome::text o from public.tasks where id=$1", uuid.UUID(rid)
            )
            if row["status"] in want:
                return row
            await asyncio.sleep(0.3)
        return row

    async def result(rid):
        return await db.fetchval(
            "select payload::text from public.task_events where task_id=$1 and kind='result' order by seq desc limit 1",
            uuid.UUID(rid),
        )

    ok = True
    t = await task("Reply with the single word: ok")
    row = await settle(t, ("done", "failed"))
    res = await result(t)
    print("1 task, no system prompt:", row["status"], (res or "")[:200])
    ok &= row["status"] == "done"
    t = await task(
        "Call the mcp tool exactly once with label 'smoke-one', then reply with the word: done"
    )
    row = await settle(t, ("paused", "done", "failed"))
    q = (
        json.loads(row["o"] or "{}").get("interrupts", [{}])[0].get("id")
        if row["status"] == "paused"
        else None
    )
    print("2 tool task paused for approval:", row["status"], bool(q))
    ok &= bool(q)
    if q:
        r = await http.post(
            f"{NEXT}/api/tasks/{t}/respond", headers=web, json={"requestId": q, "approved": True}
        )
        row = await settle(t, ("done", "failed"))
        res = await result(t)
        print("3 approved, second model call:", r.status_code, row["status"], (res or "")[:200])
        ok &= row["status"] == "done"

    async def chat_with_tool(model, label, step):
        """A chat run that calls the MCP tool (approval), then its resume."""
        thread = str(conv) if model == HAIKU else str(uuid.uuid4())
        content = f"Call the mcp tool once with label '{label}', then reply: done"
        rid = str(uuid.uuid4())
        async with http.stream(
            "POST",
            f"{PYAPI}/v1/runs",
            headers=api,
            json={
                "threadId": thread,
                "runId": rid,
                "messages": [{"id": "m1", "role": "user", "content": content}],
                "forwardedProps": {
                    "model": model,
                    "workspaceId": str(ws),
                    "requireApprovalFor": [],
                },
            },
        ) as r:
            "".join([chunk async for chunk in r.aiter_text()])
        status = (await http.get(f"{PYAPI}/v1/runs/{rid}", headers=api)).json()
        print(
            f"{step} chat run with a tool ({model}):",
            r.status_code,
            status.get("status"),
            json.dumps(status.get("error") or status.get("openInterrupts") or "")[:200],
        )
        if status.get("status") == "interrupted":
            it = status["openInterrupts"][0]["id"]
            rid2 = str(uuid.uuid4())
            async with http.stream(
                "POST",
                f"{PYAPI}/v1/runs",
                headers=api,
                json={
                    "threadId": thread,
                    "runId": rid2,
                    "messages": [{"id": "m1", "role": "user", "content": content}],
                    "resume": [
                        {"interruptId": it, "status": "resolved", "payload": {"approved": True}}
                    ],
                    "forwardedProps": {
                        "model": model,
                        "workspaceId": str(ws),
                        "previousRunId": rid,
                    },
                },
            ) as r2:
                "".join([chunk async for chunk in r2.aiter_text()])
            status = (await http.get(f"{PYAPI}/v1/runs/{rid2}", headers=api)).json()
            print(
                f"{step + 1} chat resume, second model call ({model}):",
                status.get("status"),
                json.dumps(status.get("error") or "")[:200],
            )
        return status.get("status") == "succeeded"

    ok &= await chat_with_tool(HAIKU, "smoke-chat", 4)

    if os.environ.get("LIVE_MINIMAX_KEY"):
        # Wave 10 (Q112): one provider besides Anthropic, through its own route.
        served = (await http.get(f"{PYAPI}/v1/models")).json()
        listed = MINIMAX in [m["id"] for m in served["models"]]
        print("6 /v1/models lists", MINIMAX, listed)
        ok &= listed
        ok &= await chat_with_tool(MINIMAX, "smoke-minimax", 7)
        rid = str(uuid.uuid4())
        r = await http.post(
            f"{PYAPI}/v1/runs",
            headers=api,
            json={
                "threadId": str(conv),
                "runId": rid,
                "messages": [
                    {
                        "id": "m1",
                        "role": "user",
                        "content": "Without calling any tool, reply with the single word: ok",
                    }
                ],
                "forwardedProps": {
                    "model": MINIMAX,
                    "mode": "background",
                    "goal": "smoke on minimax",
                    "workspaceId": str(ws),
                    "maxSteps": 2,
                },
            },
        )
        row = (
            await settle(rid, ("done", "failed", "paused"))
            if r.status_code == 202
            else {"status": r.text, "o": None}
        )
        if row["status"] == "paused":
            print("  paused on:", (row["o"] or "")[:400])
        res = await result(rid) if r.status_code == 202 else None
        print("9 background task on", MINIMAX, r.status_code, row["status"], (res or "")[:200])
        ok &= row["status"] == "done"
    print("SMOKE", "PASS" if ok else "FAIL")
    return ok


sys.exit(0 if asyncio.run(main()) else 1)
