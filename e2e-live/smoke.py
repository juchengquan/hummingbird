"""Q65: a few real Anthropic calls through the real worker and agent-py's runs (tasks start,
answer and resume on `/v1/runs` since wave 13, Q147); with
LIVE_MINIMAX_KEY / LIVE_MINIMAX_URL, MiniMax M3.1 Flash too (wave 10, Q112); and
the Explain popover's ephemeral runs, signed in and out (wave 12, Q135/Q136/Q139).
No output of a key."""

import asyncio
import json
import os
import sys
import uuid

import asyncpg
import httpx

PYAPI, SUPA = "http://127.0.0.1:8171", "http://127.0.0.1:54871"
FAKE = "http://127.0.0.1:8172"
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
    api = {"authorization": f"Bearer {token}"}
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
        """A background task on Haiku: `POST /v1/runs`, `mode: background`."""
        rid = str(uuid.uuid4())
        r = await http.post(
            f"{PYAPI}/v1/runs",
            headers=api,
            json={
                "threadId": str(conv),
                "runId": rid,
                "messages": [{"id": "m1", "role": "user", "content": prompt}],
                "forwardedProps": {
                    "mode": "background",
                    "model": HAIKU,
                    "workspaceId": str(ws),
                    "maxSteps": 4,
                },
            },
        )
        assert r.status_code == 202, r.text
        return rid

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
        # The answer is a background resume of the paused run (RUN_EVENTS.md § 4.2).
        t2 = str(uuid.uuid4())
        r = await http.post(
            f"{PYAPI}/v1/runs",
            headers=api,
            json={
                "threadId": str(conv),
                "runId": t2,
                "messages": [{"id": "m1", "role": "user", "content": "go"}],
                "resume": [{"interruptId": q, "status": "resolved", "payload": {"approved": True}}],
                "forwardedProps": {"mode": "background", "previousRunId": t},
            },
        )
        row = await settle(t2, ("done", "failed")) if r.status_code == 202 else {"status": r.text}
        res = await result(t2) if r.status_code == 202 else None
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

    async def explain(model, step, headers):
        """The Explain popover's run (Q135/Q136): ephemeral — streamed text, no
        tools even when asked for one (with a workspace whose MCP tool a normal
        run would have), never a `tasks` row."""
        label = f"smoke-explain-{uuid.uuid4().hex[:6]}"
        rid = str(uuid.uuid4())
        text = []
        async with http.stream(
            "POST",
            f"{PYAPI}/v1/runs",
            headers=headers,
            json={
                "threadId": str(uuid.uuid4()),
                "runId": rid,
                "messages": [
                    {
                        "id": "m1",
                        "role": "user",
                        "content": f"Call the mcp tool once with label '{label}'. Then explain in "
                        'one sentence what the word "ok" means in a chat reply.',
                    }
                ],
                "forwardedProps": {"model": model, "ephemeral": True, "workspaceId": str(ws)},
            },
        ) as r:
            run_token = r.headers.get("x-run-token")
            async for line in r.aiter_lines():
                if line.startswith("data:"):
                    ev = json.loads(line[5:])
                    if ev.get("type") == "TEXT_MESSAGE_CONTENT":
                        text.append(ev["delta"])
        reread = {**headers, **({"x-run-token": run_token} if run_token else {})}
        status = (await http.get(f"{PYAPI}/v1/runs/{rid}", headers=reread)).json()
        rows = await db.fetchval("select count(*) from public.tasks where id = $1", uuid.UUID(rid))
        effects = (await http.get(f"{FAKE}/state")).json().get("effects", {})
        ran = sum(v for k, v in effects.items() if k.startswith(label + ":"))
        who = "signed in" if "authorization" in headers else "signed out"
        answer = "".join(text)
        print(
            f"{step} explain, ephemeral ({model}, {who}):",
            r.status_code,
            status.get("status"),
            f"tasks rows={rows} tool calls={ran}",
            answer[:160].replace("\n", " "),
        )
        return (
            status.get("status") == "succeeded" and bool(answer.strip()) and rows == 0 and ran == 0
        )

    ok &= await explain(HAIKU, 10, api)
    ok &= await explain(HAIKU, 11, {})

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
        ok &= await explain(MINIMAX, 12, api)
    print("SMOKE", "PASS" if ok else "FAIL")
    return ok


sys.exit(0 if asyncio.run(main()) else 1)
