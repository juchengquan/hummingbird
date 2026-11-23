"""The task routes on the real stack (`e2e-live/stack.sh`): a GoTrue session, the Next routes and
`/v1/runs`, agent-py's worker, a scripted model and an MCP server that counts effects. Exits non-zero on
any failure."""

import asyncio
import base64
import json
import os
import time
import traceback
import uuid

import asyncpg
import httpx

NEXT, PYAPI, SUPA, FAKE = (
    "http://127.0.0.1:3171",
    "http://127.0.0.1:8171",
    "http://127.0.0.1:54871",
    "http://127.0.0.1:8172",
)
FREE, GATED = "aaaaaaaa-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002"
MODEL = "anthropic/claude-sonnet-4.6"
ENDED = ("done", "failed", "cancelled")
results = []


def check(case, ok, detail=""):
    results.append((case, ok, detail))
    print(
        ("PASS " if ok else "FAIL ") + case + ("" if ok else f"  -- {str(detail)[:400]}"),
        flush=True,
    )


async def main():
    db = await asyncpg.create_pool(os.environ["LIVE_DSN"], min_size=1, max_size=4)
    http = httpx.AsyncClient(timeout=60, trust_env=False)
    email = f"{uuid.uuid4().hex}@example.test"
    s = (
        await http.post(
            f"{SUPA}/auth/v1/signup",
            headers={"apikey": os.environ["LIVE_ANON"]},
            json={"email": email, "password": uuid.uuid4().hex},
        )
    ).json()
    assert "access_token" in s, s
    uid, token = s["user"]["id"], s["access_token"]
    raw = "base64-" + base64.urlsafe_b64encode(json.dumps(s).encode()).decode().rstrip("=")
    name = "sb-127-auth-token"
    parts = [raw[i : i + 3180] for i in range(0, len(raw), 3180)]
    cookie = (
        f"{name}={raw}"
        if len(parts) == 1
        else "; ".join(f"{name}.{i}={p}" for i, p in enumerate(parts))
    )
    web, api = {"cookie": cookie, "origin": NEXT}, {"authorization": f"Bearer {token}"}

    ws, conv = uuid.uuid4(), uuid.uuid4()
    await db.execute(
        "insert into public.workspaces(id,user_id,name) values($1,$2,'live')", ws, uuid.UUID(uid)
    )
    await db.execute(
        "insert into public.conversations(id,user_id,workspace_id,title) values($1,$2,$3,'live')",
        conv,
        uuid.UUID(uid),
        ws,
    )
    caps = json.dumps(
        {
            "tools": [
                {
                    "name": "record",
                    "description": "Record an effect.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"label": {"type": "string"}},
                        "required": ["label"],
                    },
                }
            ]
        }
    )
    async with db.acquire() as c:
        for sid, gate in ((FREE, False), (GATED, True)):
            async with c.transaction():
                await c.execute(
                    "select set_config('request.jwt.claims',$1,true)",
                    json.dumps({"sub": uid, "role": "authenticated"}),
                )
                await c.execute("set local role authenticated")
                await c.execute(
                    "select public.mcp_upsert_server_with_credentials($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,true,$8)",
                    uuid.UUID(sid),
                    ws,
                    "gated" if gate else "free",
                    "http://127.0.0.1:8173/mcp",
                    json.dumps({"type": "bearer", "headers": {"Authorization": "Bearer local"}}),
                    os.environ["LIVE_MCPKEY"],
                    caps,
                    gate,
                )

    async def start(scn, tag=None, **extra):
        body = {
            "conversationId": str(conv),
            "workspaceId": str(ws),
            "skills": [],
            "model": MODEL,
            "messages": [{"role": "user", "content": f"SCENARIO:{scn}/{tag}"}],
            **extra,
        }
        return await http.post(
            f"{NEXT}/api/tasks", headers=web, json={k: v for k, v in body.items() if v is not None}
        )

    async def begin(scn, tag, **extra):
        r = await start(scn, tag, **extra)
        assert r.status_code == 202, r.text
        return r.json()["runId"]

    async def row(rid):
        return await db.fetchrow(
            "select id::text,status,outcome::text,finished_at,pending_children from public.tasks where id=$1",
            uuid.UUID(rid),
        )

    async def wait(rid, statuses, secs=25):
        end = time.time() + secs
        seen = None
        while time.time() < end:
            r = await row(rid)
            seen = r and r["status"]
            if seen in statuses:
                return seen
            await asyncio.sleep(0.2)
        return f"timeout:{seen}"

    async def question(rid, not_=None, secs=25):
        end = time.time() + secs
        while time.time() < end:
            r = await row(rid)
            if r and r["status"] == "paused" and r["outcome"]:
                o = json.loads(r["outcome"])
                qs = (
                    [i["id"] for i in o.get("interrupts", [])]
                    if o.get("type") == "interrupt"
                    else []
                )
                if len(qs) == 1 and qs[0] != not_:
                    return qs[0]
            await asyncio.sleep(0.2)
        return None

    async def respond(rid, q, **answer):
        return await http.post(
            f"{NEXT}/api/tasks/{rid}/respond", headers=web, json={"requestId": q, **answer}
        )

    async def resume(rid, q, payload=None, status="resolved", **props):
        new = str(uuid.uuid4())
        entry = {"interruptId": q, "status": status}
        if payload is not None:
            entry["payload"] = payload
        body = {
            "threadId": str(conv),
            "runId": new,
            "messages": [{"id": "m", "role": "user", "content": "go"}],
            "resume": [entry],
            "forwardedProps": {"mode": "background", "previousRunId": rid, **props},
        }
        body["forwardedProps"] = {k: v for k, v in body["forwardedProps"].items() if v is not None}
        return new, await http.post(f"{PYAPI}/v1/runs", headers=api, json=body)

    async def cancel(rid, via="next"):
        return await http.post(
            *(
                [f"{NEXT}/api/tasks/{rid}/cancel"]
                if via == "next"
                else [f"{PYAPI}/v1/runs/{rid}/cancel"]
            ),
            headers=web if via == "next" else api,
            json={},
        )

    async def effects(tag):
        e = (await http.get(f"{FAKE}/state")).json()["effects"]
        return {k.split(":", 1)[1]: v for k, v in e.items() if k.startswith(tag + ":")}

    async def children(rid):
        return await db.fetch(
            "select id::text,goal,status from public.tasks where parent_task_id=$1", uuid.UUID(rid)
        )

    async def asking_child(rid):
        for _ in range(125):
            for c in await children(rid):
                if c["status"] == "paused":
                    q = await question(c["id"], secs=3)
                    if q:
                        return c["id"], q
            await asyncio.sleep(0.2)
        return None, None

    async def texts(needle):
        return needle in (await http.get(f"{FAKE}/state")).json()["all_text"]

    async def models():
        n = await db.fetchval("select count(*) from public.tasks")
        for label, m in (
            ("default", None),
            ("deepseek", "deepseek/deepseek-v4-flash"),
            ("auto", "auto"),
        ):
            r = await start("multi", "m", model=m)
            check(
                f"models: {label} -> 400",
                r.status_code == 400 and r.json().get("code") == "unknown_model",
                (r.status_code, r.text[:160]),
            )
        check(
            "models: nothing created", n == await db.fetchval("select count(*) from public.tasks")
        )

    async def schedule():
        sid = uuid.uuid4()
        await db.execute(
            """insert into public.task_schedules(id,user_id,workspace_id,name,prompt,cron,timezone,enabled,next_run_at)
            values($1,$2,$3,'s','SCENARIO:quick/sched','0 8 * * *','UTC',true,now()-interval '1 minute')""",
            sid,
            uuid.UUID(uid),
            ws,
        )
        for _ in range(100):
            t = await db.fetchval(
                "select last_run_task_id::text from public.task_schedules where id=$1", sid
            )
            if t:
                break
            await asyncio.sleep(0.2)
        st = await wait(t, ENDED) if t else "never fired"
        ev = (
            await db.fetchval(
                "select payload::text from public.task_events where task_id=$1 and kind='result' order by seq desc limit 1",
                uuid.UUID(t),
            )
            if t
            else ""
        )
        check(
            "schedule: fails saying no model",
            st == "failed" and "no model" in (ev or "").lower(),
            (st, ev),
        )

    async def multi():
        t = await begin("multi", "ma")
        q1 = await question(t)
        check(
            "multi: ungated ran once, gated waited",
            await effects("ma") == {"lookup": 1},
            await effects("ma"),
        )
        bad = await respond(t, q1)
        check(
            "multi: no approved -> 400",
            bad.status_code == 400 and await effects("ma") == {"lookup": 1},
            (bad.status_code, bad.text),
        )
        rs = await asyncio.gather(respond(t, q1, approved=True), respond(t, q1, approved=True))
        check(
            "multi: double answer -> one winner",
            sorted(r.status_code for r in rs) == [202, 409],
            [(r.status_code, r.text[:100]) for r in rs],
        )
        q2 = await question(t, not_=q1)
        check("multi: second question follows", bool(q2))
        await respond(t, q2, approved=True)
        st = await wait(t, ENDED)
        check(
            "multi: done, one effect each",
            st == "done" and await effects("ma") == {"lookup": 1, "one": 1, "two": 1},
            (st, await effects("ma")),
        )

    async def decline():
        t = await begin("multi", "de")
        q1 = await question(t)
        await respond(t, q1, approved=False)
        q2 = await question(t, not_=q1)
        await respond(t, q2, approved=False)
        st = await wait(t, ENDED)
        check(
            "decline: done, nothing gated ran",
            st == "done" and await effects("de") == {"lookup": 1},
            (st, await effects("de")),
        )

    async def mixed():
        t = await begin("seq", "mx")
        q1 = await question(t)
        await respond(t, q1, approved=True)
        q2 = await question(t, not_=q1)
        new, r = await resume(t, q2, {"approved": True})
        st = await wait(new, ENDED) if r.status_code == 202 else r.text
        check(
            "mixed: old answer, then runs answer",
            st == "done" and await effects("mx") == {"q1": 1, "q2": 1},
            (st, await effects("mx")),
        )
        t = await begin("seq", "my")
        q1 = await question(t)
        new, r = await resume(t, q1, {"approved": True})
        q2 = await question(new)
        await respond(new, q2, approved=True)
        st = await wait(new, ENDED)
        check(
            "mixed: runs answer, then old answer",
            st == "done" and await effects("my") == {"q1": 1, "q2": 1},
            (st, await effects("my")),
        )

    async def applyfail():
        t = await begin("applyfail", "af")
        q = await question(t)
        new, _ = await resume(t, q, {"approved": True})
        st = await wait(new, ENDED)
        _, again = await resume(t, q, {"approved": True})
        old = await respond(t, q, approved=True)
        await asyncio.sleep(2)
        check(
            "applied then failed: no replay",
            st == "failed"
            and again.status_code == 409
            and old.status_code == 409
            and await effects("af") == {"sent": 1},
            (st, again.status_code, old.status_code, await effects("af")),
        )

    async def narrow():
        t = await begin("seq", "na")
        q = await question(t)
        new, r = await resume(t, q, {"approved": True}, allowedMcpServerIds=[])
        st = await wait(new, ("paused", *ENDED))
        check(
            "narrowed resume: blocked tool didn't run",
            r.status_code == 202 and await effects("na") == {},
            (r.status_code, r.text[:120], st, await effects("na")),
        )

    async def running_cancel():
        for via in ("next", "runs"):
            tag = "rc" + via
            t = await begin("slowgate", tag)
            st = await wait(t, ("running",), 8)
            got = (await http.get(f"{PYAPI}/v1/runs/{t}", headers=api)).json()
            check(
                f"running ({via}): reads running",
                st == "running" and got.get("status") == "running",
                (st, got.get("status")),
            )
            r = await cancel(t, via)
            await asyncio.sleep(8)
            final = (await row(t))["status"]
            events = await db.fetch(
                "select payload::text p from public.task_events where task_id=$1 and kind='approval'",
                uuid.UUID(t),
            )
            check(
                f"cancel during model ({via}): stays cancelled, no effect",
                r.status_code == 200 and final == "cancelled" and await effects(tag) == {},
                (r.status_code, r.text[:100], final, await effects(tag)),
            )
            check(
                f"cancel during model ({via}): no question left",
                not events,
                [e["p"] for e in events],
            )

    async def cancel_chain():
        for via in ("next", "runs"):
            t = await begin("slowafter", "cc" + via)
            q = await question(t)
            new, _ = await resume(t, q, {"approved": True})
            await wait(new, ("running",), 8)
            await asyncio.sleep(1)
            await cancel(t, via)
            await asyncio.sleep(7)
            a, b = (await row(t))["status"], (await row(new))["status"]
            check(f"cancel root ({via}): whole chain", (a, b) == ("cancelled", "cancelled"), (a, b))

    async def child_answer():
        t = await begin("spawn", "ca")
        kid, q = await asking_child(t)
        check(
            "child: asks while parent waits",
            bool(kid) and (await row(t))["status"] == "paused",
            await children(t),
        )
        _, r = await resume(kid, q, {"value": "x"})
        _, r2 = await resume(kid, q, {"value": "x"}, mode=None)
        check(
            "child: runs resume refused, mode or none",
            (r.status_code, r2.status_code) == (409, 409),
            (r.status_code, r2.status_code, r2.text[:150]),
        )
        listed = await http.get(f"{NEXT}/api/tasks/{t}/children", headers=web)
        check(
            "child: listed for the parent",
            listed.status_code == 200 and kid in listed.text,
            listed.text[:200],
        )
        a = await respond(kid, q, value="this")
        st = await wait(t, ENDED)
        check(
            "child: answered, parent done",
            a.status_code == 202 and st == "done" and await effects("ca") == {"beside": 1},
            (a.status_code, a.text, st, await effects("ca")),
        )

    async def child_skip():
        for via in ("next", "runs"):
            t = await begin("spawn", "cs" + via)
            kid, _q = await asking_child(t)
            await cancel(kid, via)
            st = await wait(t, ENDED)
            check(f"child skip ({via}): parent continues", st == "done", st)
        check("child skip: model told", await texts("skipped") or await texts("Skipped"))

    async def parent_cancel():
        t = await begin("spawn", "pc")
        kid, _ = await asking_child(t)
        await cancel(t)
        a, b = (await row(t))["status"], (await row(kid))["status"]
        check("cancel parent: child too", (a, b) == ("cancelled", "cancelled"), (a, b))

    async def respawn():
        t = await begin("respawn", "rs")
        q = await question(t)
        await respond(t, q, value="go")
        st = await wait(t, ENDED)
        kids = await children(t)
        check(
            "respond then spawn: really spawns",
            st == "done" and len(kids) == 1 and kids[0]["status"] == "done",
            (st, [dict(k) for k in kids]),
        )

    async def stream():
        t = await begin("quick", "st")
        await wait(t, ENDED)
        r = await http.get(f"{NEXT}/api/tasks/{t}/stream?cursor=0", headers=web)
        check(
            "stream: replay has the final text",
            "FINAL quick" in r.text,
            (r.status_code, r.text[-300:]),
        )

    for case in (
        models,
        schedule,
        stream,
        multi,
        decline,
        mixed,
        applyfail,
        narrow,
        running_cancel,
        cancel_chain,
        child_answer,
        child_skip,
        parent_cancel,
        respawn,
    ):
        try:
            await case()
        except Exception as e:
            check(
                f"{case.__name__}: crashed",
                False,
                "".join(traceback.format_exception_only(e)) + traceback.format_exc()[-300:],
            )
    state = (await http.get(f"{FAKE}/state")).json()
    check("every model request was valid", not state["invalid"], state["invalid"][:6])
    print(
        f"\n{sum(ok for _, ok, _ in results)}/{len(results)} pass, {state['requests']} model requests",
        flush=True,
    )
    if not all(ok for _, ok, _ in results):
        raise SystemExit(1)


asyncio.run(main())
