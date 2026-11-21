"""End-to-end runs: the real app (`create_app`, its lifespan and the real
`runs.wiring` services) served by uvicorn on a local port, spoken to over
HTTP. The one fake is the Anthropic client — a scripted `FakeAnthropic`
handed to the native harness (interactive runs) and to the executor
(background runs). No network beyond loopback.

Every test runs twice:

* `memory` — no database: signed-in and anonymous runs live in the
  in-memory store + `MemoryRunEventLog`;
* `postgres` — `AGENT_PY_TEST_DB_URL` (a disposable database with
  migrations 0001 to 0041) as `SUPABASE_DB_URL`: signed-in runs are
  `tasks` rows with a `PgRunEventLog`, and the poller executes
  background runs (`WORKER_DRY_RUN=false`). Skipped without it.

Every AG-UI event of every stream is validated against the pinned
schema (`packages/contract/agui/1.0/schema.json`). With
`RUNS_E2E_FIXTURES_DIR` set, each stream's raw SSE body is written
there (`<backend>-<name>.sse`) — the input of the AG-UI client check.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import asyncpg
import httpx
import jwt
import pytest
import uvicorn

from agent_py import executor
from agent_py.main import create_app
from agent_py.runs import native_harness, wiring
from agent_py.runs.harness import RunInput
from agent_py.runs.native_harness import Toolset
from agent_py.tools.ask_user import build_ask_user_tool
from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult
from agent_py.tools.render_ui import build_render_ui_tool

from .runs_support import assert_valid

DB_URL = os.environ.get("AGENT_PY_TEST_DB_URL", "")
FIXTURES_DIR = os.environ.get("RUNS_E2E_FIXTURES_DIR", "")
SECRET = "e2e-secret-do-not-use-in-prod-32-bytes!!"
MODEL = "anthropic/claude-sonnet-4.6"

LOOKUP_FULL = "LOOKUP FULL RESULT: " + "the whole page, not a summary. " * 40
LOOKUP_SUMMARY = "Looked it up"


# --- the scripted model ------------------------------------------------------------


class Gate:
    """In a `Turn`'s events: the model stream blocks here until `open()`
    (a thread event — the server runs on another thread's loop)."""

    def __init__(self) -> None:
        self._event = threading.Event()
        self.reached = threading.Event()

    def open(self) -> None:
        self._event.set()

    async def wait(self) -> None:
        self.reached.set()
        while not self._event.is_set():
            await asyncio.sleep(0.02)


class Boom:
    """In a `Turn`'s events: the model stream raises here (a provider
    failure mid-answer)."""


def text(t: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content_block_delta", delta=SimpleNamespace(type="text_delta", text=t)
    )


def tool_use(cid: str, name: str, **args: Any) -> dict[str, Any]:
    return {"type": "tool_use", "id": cid, "name": name, "input": args}


@dataclass
class Turn:
    events: list[Any] = field(default_factory=list)
    tools: list[dict[str, Any]] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "".join(e.delta.text for e in self.events if isinstance(e, SimpleNamespace))


class _Stream:
    def __init__(self, turn: Turn) -> None:
        self._turn = turn

    async def __aenter__(self) -> _Stream:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    def __aiter__(self) -> Any:
        return self._events()

    async def _events(self) -> Any:
        yield SimpleNamespace(
            type="message_start", message=SimpleNamespace(usage=SimpleNamespace(input_tokens=11))
        )
        for e in self._turn.events:
            if isinstance(e, Gate):
                await e.wait()
            elif isinstance(e, Boom):
                raise RuntimeError("model stream broke")
            else:
                yield e
        yield SimpleNamespace(type="message_delta", usage=SimpleNamespace(output_tokens=7))

    @property
    def text_stream(self) -> Any:  # the executor's provider reads text only
        async def gen() -> Any:
            for e in self._turn.events:
                if isinstance(e, Gate):
                    await e.wait()
                else:
                    yield e.delta.text

        return gen()

    async def get_final_message(self) -> dict[str, Any]:
        content: list[dict[str, Any]] = []
        if self._turn.text:
            content.append({"type": "text", "text": self._turn.text})
        content += self._turn.tools
        return {"content": content, "stop_reason": "tool_use" if self._turn.tools else "end_turn"}


class FakeAnthropic:
    """`AsyncAnthropicClient` stand-in: each `messages.stream` plays the
    next `Turn` (then plain "ok" turns) and records its kwargs."""

    def __init__(self, *turns: Turn) -> None:
        self._turns = list(turns)
        self.requests: list[dict[str, Any]] = []
        fake = self

        class _Messages:
            def stream(self, **kwargs: Any) -> _Stream:
                fake.requests.append(json.loads(json.dumps(kwargs, default=str)))
                turn = fake._turns.pop(0) if fake._turns else Turn([text("ok")])
                return _Stream(turn)

        self.messages = _Messages()


# --- tools ------------------------------------------------------------------------------


EXECUTED: list[str] = []
"""Every tool execution, by name (cleared per test by `serve`)."""


def _tool(name: str, full: str, summary: str) -> ToolDescriptor:
    async def execute(_args: dict[str, Any]) -> ToolInvocationResult:
        EXECUTED.append(name)
        return ToolInvocationResult(text=full, summary=summary)

    return ToolDescriptor(
        name=name, description=name, input_schema={"type": "object"}, execute=execute
    )


async def _toolset(_run_input: RunInput) -> Toolset:
    tools = [
        _tool("lookup", LOOKUP_FULL, LOOKUP_SUMMARY),
        _tool("send", "SEND FULL RESULT: delivered", "Sent"),
        build_ask_user_tool(),
        build_render_ui_tool(),
    ]
    return Toolset(tools={t.name: t for t in tools})


# --- the server ---------------------------------------------------------------------------


@dataclass
class Env:
    backend: str
    base: str
    model: FakeAnthropic
    user: str
    conversation: str | None
    gates: list[Gate] = field(default_factory=list)

    def auth(self, sub: str | None = None) -> dict[str, str]:
        token = jwt.encode(
            {
                "sub": sub or self.user,
                "role": "authenticated",
                "aud": "authenticated",
                "exp": int(time.time()) + 600,
            },
            SECRET,
            algorithm="HS256",
        )
        return {"Authorization": f"Bearer {token}"}

    def http(self) -> httpx.Client:
        return httpx.Client(base_url=self.base, timeout=30)

    def save(self, name: str, body: str) -> None:
        if FIXTURES_DIR:
            Path(FIXTURES_DIR).mkdir(parents=True, exist_ok=True)
            (Path(FIXTURES_DIR) / f"{self.backend}-{name}.sse").write_text(body)


def _db(coro: Callable[[asyncpg.Connection], Any]) -> Any:
    async def go() -> Any:
        conn = await asyncpg.connect(DB_URL)
        try:
            return await coro(conn)
        finally:
            await conn.close()

    return asyncio.run(go())


async def _seed(conn: asyncpg.Connection) -> tuple[str, str]:
    user, ws, conv = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await conn.execute(
        "INSERT INTO auth.users (id, aud, role, email) VALUES ($1, 'authenticated', "
        "'authenticated', $2)",
        user,
        f"{user}@e2e.test",
    )
    await conn.execute(
        "INSERT INTO public.workspaces (id, user_id, name) VALUES ($1, $2, 'ws')", ws, user
    )
    await conn.execute(
        "INSERT INTO public.conversations (id, user_id, workspace_id, title) "
        "VALUES ($1, $2, $3, 'c')",
        conv,
        user,
        ws,
    )
    return str(user), str(conv)


@pytest.fixture(
    params=[
        "memory",
        pytest.param(
            "postgres", marks=pytest.mark.skipif(not DB_URL, reason="AGENT_PY_TEST_DB_URL not set")
        ),
    ]
)
def backend(request: pytest.FixtureRequest) -> str:
    return str(request.param)


@pytest.fixture
def serve(backend: str, monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., Env]]:
    """`serve(*turns, **env)` starts the app with a `FakeAnthropic`
    playing `turns`; torn down (gates opened, server stopped, the seeded
    user deleted) after the test."""
    started: list[tuple[uvicorn.Server, threading.Thread, Env]] = []
    seeded: list[str] = []

    EXECUTED.clear()

    def start(*turns: Turn, **env: str) -> Env:
        model = FakeAnthropic(*turns)
        values = {
            "SUPABASE_JWT_SECRET": SECRET,
            "SUPABASE_DB_URL": DB_URL if backend == "postgres" else "",
            "WORKER_DRY_RUN": "true",
            "POLL_INTERVAL_SECONDS": "0.2",
            "SCHEDULER_ENABLED": "false",
            "RUNS_STUB_HARNESS": "false",
            "RUNS_HEARTBEAT_SECONDS": "0.5",
            "RUNS_RATE_PER_MINUTE": "1000",
            "RUNS_ANONYMOUS_RATE_PER_MINUTE": "1000",
            "RUNS_ANONYMOUS_MAX_CONCURRENT": "100",
            **env,
        }
        for key, value in values.items():
            monkeypatch.setenv(key, value)
        monkeypatch.setattr(
            wiring,
            "build_native_harness",
            lambda settings: native_harness.build_native_harness(
                settings, client=model, build_tools=_toolset, suggestions=False
            ),
        )
        # The executor (background runs) caches its client module-wide.
        monkeypatch.setattr(executor, "_anthropic_client", model)

        if backend == "postgres":
            user, conv = _db(_seed)
            seeded.append(user)
        else:
            user, conv = str(uuid.uuid4()), None

        app = create_app(enable_poller=True)
        config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", ws="none")
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        deadline = time.monotonic() + 15
        while not server.started:
            if time.monotonic() > deadline or not thread.is_alive():
                raise RuntimeError("server did not start")
            time.sleep(0.02)
        port = server.servers[0].sockets[0].getsockname()[1]
        e = Env(backend, f"http://127.0.0.1:{port}", model, user, conv)
        started.append((server, thread, e))
        return e

    yield start

    for server, thread, e in started:
        for gate in e.gates:
            gate.open()
        server.should_exit = True
        thread.join(15)

    async def drop(conn: asyncpg.Connection) -> None:
        for user in seeded:
            await conn.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(user))

    if seeded:
        _db(drop)


# --- SSE ------------------------------------------------------------------------------------

Frame = tuple[str | None, dict[str, Any]]


def parse_sse(body: str) -> list[Frame]:
    """`(id, event)` per SSE message; keep-alive comments skipped. Every
    event is checked against the pinned AG-UI schema."""
    frames: list[Frame] = []
    for block in body.split("\n\n"):
        event_id: str | None = None
        data: str | None = None
        for line in block.split("\n"):
            if line.startswith("id: "):
                event_id = line[4:]
            elif line.startswith("data: "):
                data = line[6:]
        if data is None:
            continue
        event = json.loads(data)
        assert_valid(event)
        frames.append((event_id, event))
    return frames


def cursor_key(event_id: str) -> tuple[int, float]:
    seq, _, k = event_id.partition(".")
    return (int(seq), float(k) if k else float("inf"))


def tail_after(full: list[Frame], cursor: str) -> list[Frame]:
    """What a rejoin `after=cursor` must send given the full replay: the
    opening events, every event past the cursor, the closing events."""
    first = next(i for i, f in enumerate(full) if f[0] is not None)
    last = max(i for i, f in enumerate(full) if f[0] is not None)
    body = [f for f in full[first : last + 1] if cursor_key(str(f[0])) > cursor_key(cursor)]
    return [*full[:first], *body, *full[last + 1 :]]


class Reader:
    """Reads one SSE response on a thread, frame by frame, so a test can
    act while the run is live."""

    def __init__(self, env: Env, method: str, path: str, **kw: Any) -> None:
        self.raw = ""
        self.frames: list[Frame] = []
        self.status: int | None = None
        self.headers: httpx.Headers | None = None
        self.error: BaseException | None = None
        self._changed = threading.Condition()
        self._thread = threading.Thread(target=self._run, args=(env, method, path, kw), daemon=True)
        self._thread.start()

    def _run(self, env: Env, method: str, path: str, kw: dict[str, Any]) -> None:
        try:
            with env.http() as client, client.stream(method, path, **kw) as r:
                self.status, self.headers = r.status_code, r.headers
                buf = ""
                for chunk in r.iter_text():
                    buf += chunk
                    while "\n\n" in buf:
                        block, buf = buf.split("\n\n", 1)
                        self.raw += block + "\n\n"
                        parsed = parse_sse(block + "\n\n")
                        with self._changed:
                            self.frames.extend(parsed)
                            self._changed.notify_all()
        except BaseException as exc:  # surfaced by `join`
            self.error = exc
        finally:
            with self._changed:
                self._changed.notify_all()

    def wait_for(self, pred: Callable[[Frame], bool], timeout: float = 10) -> Frame:
        deadline = time.monotonic() + timeout
        with self._changed:
            while True:
                for f in self.frames:
                    if pred(f):
                        return f
                if self.error is not None or not self._thread.is_alive():
                    raise AssertionError(f"stream ended without the frame: {self.frames}")
                left = deadline - time.monotonic()
                if left <= 0:
                    raise AssertionError(f"timed out waiting for a frame: {self.frames}")
                self._changed.wait(left)

    def join(self, timeout: float = 15) -> list[Frame]:
        self._thread.join(timeout)
        assert not self._thread.is_alive(), "stream did not end"
        if self.error is not None:
            raise self.error
        return self.frames


def start_body(messages: list[dict[str, Any]], **fp: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "threadId": str(uuid.uuid4()),
        "runId": str(uuid.uuid4()),
        "messages": messages,
    }
    if fp:
        body["forwardedProps"] = fp
    return body


def user_msg(content: str, mid: str = "u1") -> dict[str, Any]:
    return {"id": mid, "role": "user", "content": content}


def types(frames: list[Frame]) -> list[str]:
    return [f[1]["type"] for f in frames]


def check_ids(frames: list[Frame]) -> None:
    """Ids strictly increase; only the opening / closing events lack one."""
    ids = [f[0] for f in frames]
    inner = ids[1:-1]
    assert ids[0] is None and ids[-1] is None
    assert all(i is not None for i in inner)
    keys = [cursor_key(str(i)) for i in inner]
    assert keys == sorted(keys) and len(set(keys)) == len(keys)


# --- interactive ------------------------------------------------------------------------------


def test_interactive_start_streams_valid_agui(serve: Callable[..., Env]) -> None:
    env = serve(
        Turn([text("Let me "), text("check.")], tools=[tool_use("c1", "lookup", q="x")]),
        Turn([text("It is "), text("done.")]),
    )
    body = start_body([user_msg("look it up")], model=MODEL)
    with env.http() as http:
        r = http.post("/v1/runs", json=body, headers=env.auth())
        assert r.status_code == 200, r.text
        assert "x-run-token" not in r.headers
        env.save("interactive", r.text)
        frames = parse_sse(r.text)
        check_ids(frames)
        assert frames[0][1] == {
            "type": "RUN_STARTED",
            "threadId": body["threadId"],
            "runId": body["runId"],
        }
        closing = frames[-1][1]
        assert closing["type"] == "RUN_FINISHED" and closing["outcome"] == {"type": "success"}
        # The run's text is every step's text, concatenated — exactly the
        # final assistant message a /v1/chat user sees: the client appends
        # every text delta of the turn to one message's content, with no
        # separator between steps (`appendToMessage` in
        # lib/client/hooks/use-chat-send.ts, `text-start` ignored).
        assert closing["result"]["text"] == "Let me check.It is done."
        assert closing["result"].get("memoryTainted") is True  # `lookup` is untrusted
        assert closing["usage"]
        kinds = types(frames)
        for t in ("STEP_STARTED", "TEXT_MESSAGE_START", "TOOL_CALL_START", "TOOL_CALL_RESULT"):
            assert t in kinds
        result = next(f[1] for f in frames if f[1]["type"] == "TOOL_CALL_RESULT")
        assert result["toolCallId"] == "c1"
        assert json.loads(result["content"]) == {"summary": LOOKUP_SUMMARY}
        # Coalesced: one text entry per model turn here, not one per delta.
        contents = [f[1]["delta"] for f in frames if f[1]["type"] == "TEXT_MESSAGE_CONTENT"]
        assert contents == ["Let me check.", "It is done."]

        run = http.get(f"/v1/runs/{body['runId']}", headers=env.auth()).json()
        assert run["status"] == "succeeded" and run["result"] == closing["result"]
        assert run["lastSeq"] >= max(cursor_key(str(f[0]))[0] for f in frames[1:-1])
        replay = http.get(f"/v1/runs/{body['runId']}/events", headers=env.auth())
        assert parse_sse(replay.text) == frames
        # The model saw the tool's full result, not its summary.
        second = env.model.requests[1]["messages"]
        assert LOOKUP_FULL in json.dumps(second)


def test_rejoin_mid_run_matches_the_tail_of_a_full_replay(serve: Callable[..., Env]) -> None:
    gate = Gate()
    env = serve(
        Turn([text("first part"), gate, text(" second part")], tools=[tool_use("c1", "lookup")]),
        Turn([text("Finished.")]),
    )
    env.gates.append(gate)
    body = start_body([user_msg("go")], model=MODEL)
    headers = env.auth()
    events = f"/v1/runs/{body['runId']}/events"

    live = Reader(env, "POST", "/v1/runs", json=body, headers=headers)
    # The first delta reaches the log (coalescer timer) while the model
    # is still blocked: the run is live.
    start = live.wait_for(lambda f: f[1]["type"] == "TEXT_MESSAGE_START")
    assert gate.reached.wait(10)
    seq = cursor_key(str(start[0]))[0]
    with env.http() as http:
        assert http.get(f"/v1/runs/{body['runId']}", headers=headers).json()["status"] == "running"
    rejoins = {
        cursor: Reader(env, "GET", events, params={"after": cursor}, headers=headers)
        for cursor in (f"{seq}.0", str(seq), "0")
    }
    for reader in rejoins.values():
        reader.wait_for(lambda f: f[1]["type"] == "RUN_STARTED")
    gate.open()
    full = live.join()
    check_ids(full)
    assert full[-1][1]["type"] == "RUN_FINISHED"
    with env.http() as http:
        replay = parse_sse(http.get(events, headers=headers).text)
    assert replay == full
    for cursor, reader in rejoins.items():
        got = reader.join()
        assert got == tail_after(full, cursor), cursor
        env.save(f"rejoin-after-{cursor}", reader.raw)
    env.save("rejoin-full", live.raw)
    # `<seq>.<k>` mid-entry: the rest of that entry's events come first
    # (an entry's last event carries the plain `<seq>`).
    after_k = rejoins[f"{seq}.0"].frames
    assert after_k[1][0] == str(seq) and after_k[1][1]["type"] == "TEXT_MESSAGE_CONTENT"
    assert rejoins[str(seq)].frames[1][0] != str(seq)
    # A cursor beyond the log is 400, an unknown run 404.
    with env.http() as http:
        bad = http.get(events, params={"after": "9999"}, headers=headers)
        assert bad.status_code == 400 and bad.json()["code"] == "invalid_request"
        missing = http.get(f"/v1/runs/{uuid.uuid4()}/events", headers=headers)
        assert missing.status_code == 404


@pytest.mark.parametrize("who", ["signed_in", "anonymous"])
def test_approval_interrupt_then_resume_continues_from_the_checkpoint(
    serve: Callable[..., Env], who: str
) -> None:
    env = serve(
        Turn(
            [text("Looking up, then sending.")],
            tools=[tool_use("c1", "lookup", q="x"), tool_use("c2", "send", to="bob")],
        ),
        Turn([text("Sent it.")]),
    )
    headers = env.auth() if who == "signed_in" else {}
    first = start_body(
        [user_msg("look it up and send it")], model=MODEL, requireApprovalFor=["send"]
    )
    with env.http() as http:
        r = http.post("/v1/runs", json=first, headers=headers)
        assert r.status_code == 200, r.text
        if who == "anonymous":
            # The resume presents the interrupted run's token: it stays
            # under that token, which is also how its checkpoint is read.
            headers = {"X-Run-Token": r.headers["x-run-token"]}
        env.save(f"interrupt-{who}", r.text)
        frames = parse_sse(r.text)
        check_ids(frames)
        closing = frames[-1][1]
        assert closing["type"] == "RUN_FINISHED"
        assert closing["outcome"]["type"] == "interrupt"
        [interrupt] = closing["outcome"]["interrupts"]
        assert interrupt["id"] == "c2" and interrupt["toolCallId"] == "c2"
        assert interrupt["reason"] == "approval"
        run = http.get(f"/v1/runs/{first['runId']}", headers=headers).json()
        assert run["status"] == "interrupted" and run["openInterrupts"] == [interrupt]

        # The browser's history after the interrupted run: the assistant
        # turn with both calls, and `lookup`'s result as the stream gave
        # it — the summary, not the full text.
        lookup_result = next(
            f[1]
            for f in frames
            if f[1]["type"] == "TOOL_CALL_RESULT" and f[1]["toolCallId"] == "c1"
        )
        history = [
            user_msg("look it up and send it"),
            {
                "id": "a1",
                "role": "assistant",
                "content": "Looking up, then sending.",
                "toolCalls": [
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "lookup", "arguments": '{"q":"x"}'},
                    },
                    {
                        "id": "c2",
                        "type": "function",
                        "function": {"name": "send", "arguments": '{"to":"bob"}'},
                    },
                ],
            },
            {"id": "t1", "role": "tool", "toolCallId": "c1", "content": lookup_result["content"]},
        ]
        assert LOOKUP_FULL not in json.dumps(history)
        resume = {
            "threadId": first["threadId"],
            "runId": str(uuid.uuid4()),
            "messages": history,
            "forwardedProps": {
                "model": MODEL,
                "requireApprovalFor": ["send"],
                "previousRunId": first["runId"],
            },
            "resume": [{"interruptId": "c2", "status": "resolved", "payload": {"approved": True}}],
        }
        r2 = http.post("/v1/runs", json=resume, headers=headers)
        assert r2.status_code == 200, r2.text
        env.save(f"resume-{who}", r2.text)
        if who == "anonymous":
            assert r2.headers["x-run-token"] == headers["X-Run-Token"]
        resumed = parse_sse(r2.text)
        check_ids(resumed)
        assert resumed[-1][1]["type"] == "RUN_FINISHED"
        assert resumed[-1][1]["outcome"] == {"type": "success"}
        assert resumed[-1][1]["result"]["text"] == "Sent it."
        # Cross-run: the approved call's result, whose TOOL_CALL_START
        # was in the previous run's stream.
        cross = [f[1] for f in resumed if f[1]["type"] == "TOOL_CALL_RESULT"]
        assert [c["toolCallId"] for c in cross] == ["c2"]
        assert not any(
            f[1]["type"] == "TOOL_CALL_START" and f[1]["toolCallId"] == "c2" for f in resumed
        )
        assert http.get(f"/v1/runs/{resume['runId']}", headers=headers).json()["status"] == (
            "succeeded"
        )

    # The model's input for the resume: the interrupted turn from the
    # checkpoint, with `lookup`'s FULL result and `send`'s result.
    request = env.model.requests[-1]
    blocks = [
        b
        for m in request["messages"]
        for b in (m["content"] if isinstance(m["content"], list) else [])
    ]
    results = {b["tool_use_id"]: b for b in blocks if b.get("type") == "tool_result"}
    assert set(results) == {"c1", "c2"}
    assert LOOKUP_FULL in json.dumps(results["c1"])
    assert "SEND FULL RESULT" in json.dumps(results["c2"])


def test_two_racing_resumes_run_the_approved_tool_once(serve: Callable[..., Env]) -> None:
    env = serve(
        Turn([text("Sending.")], tools=[tool_use("c2", "send", to="bob")]),
        Turn([text("Sent it.")]),
        Turn([text("Sent it again?")]),
    )
    headers = env.auth()
    first = start_body([user_msg("send it")], model=MODEL, requireApprovalFor=["send"])
    with env.http() as http:
        r = http.post("/v1/runs", json=first, headers=headers)
        assert r.status_code == 200 and '"interrupt"' in r.text
    assert EXECUTED == []

    def resume_body() -> dict[str, Any]:
        return {
            "threadId": first["threadId"],
            "runId": str(uuid.uuid4()),
            "messages": [user_msg("send it")],
            "forwardedProps": {
                "model": MODEL,
                "requireApprovalFor": ["send"],
                "previousRunId": first["runId"],
            },
            "resume": [{"interruptId": "c2", "status": "resolved", "payload": {"approved": True}}],
        }

    bodies = [resume_body(), resume_body()]
    barrier = threading.Barrier(len(bodies))
    answers: list[httpx.Response | None] = [None] * len(bodies)

    def post(i: int) -> None:
        with env.http() as http:
            barrier.wait()
            answers[i] = http.post("/v1/runs", json=bodies[i], headers=headers)

    threads = [threading.Thread(target=post, args=(i,)) for i in range(len(bodies))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)
    got = [a for a in answers if a is not None]
    assert sorted(a.status_code for a in got) == [200, 409], [a.text for a in got]
    loser = next(a for a in got if a.status_code == 409)
    assert loser.json()["code"] == "run_already_resumed"
    winner = next(i for i, a in enumerate(got) if a.status_code == 200)
    assert parse_sse(got[winner].text)[-1][1]["outcome"] == {"type": "success"}
    assert EXECUTED == ["send"]
    with env.http() as http:
        # The loser left no run; the winner's retry replays, a third is refused.
        lost = bodies[1 - winner]["runId"]
        assert http.get(f"/v1/runs/{lost}", headers=headers).status_code == 404
        retry = http.post("/v1/runs", json=bodies[winner], headers=headers)
        assert retry.status_code == 200 and parse_sse(retry.text) == parse_sse(got[winner].text)
        third = http.post("/v1/runs", json=resume_body(), headers=headers)
        assert third.status_code == 409 and third.json()["code"] == "run_already_resumed"
    assert EXECUTED == ["send"]


def test_cancel_mid_stream(serve: Callable[..., Env]) -> None:
    gate = Gate()  # never opened: the model hangs until cancelled
    env = serve(Turn([text("partial answer"), gate, text(" never sent")]))
    env.gates.append(gate)
    body = start_body([user_msg("go")], model=MODEL)
    headers = env.auth()
    live = Reader(env, "POST", "/v1/runs", json=body, headers=headers)
    live.wait_for(lambda f: f[1]["type"] == "TEXT_MESSAGE_CONTENT")
    with env.http() as http:
        r = http.post(f"/v1/runs/{body['runId']}/cancel", headers=headers)
        assert r.status_code == 200 and r.json()["status"] == "cancelled"
        frames = live.join()
        env.save("cancel", live.raw)
        check_ids(frames)
        assert frames[-1][1]["type"] == "RUN_FINISHED"
        assert frames[-1][1]["outcome"] == {"type": "cancelled"}
        assert "never sent" not in live.raw
        run = http.get(f"/v1/runs/{body['runId']}", headers=headers).json()
        assert run["status"] == "cancelled"
        # Idempotent, and the replay ends the same way.
        assert http.post(f"/v1/runs/{body['runId']}/cancel", headers=headers).status_code == 200
        replay = parse_sse(http.get(f"/v1/runs/{body['runId']}/events", headers=headers).text)
        assert replay == frames


def test_anonymous_run_with_a_run_token(serve: Callable[..., Env]) -> None:
    env = serve(Turn([text("Hello, stranger.")]))
    body = start_body([user_msg("hi")], model=MODEL)
    with env.http() as http:
        r = http.post("/v1/runs", json=body)
        assert r.status_code == 200, r.text
        token = r.headers["x-run-token"]
        env.save("anonymous", r.text)
        frames = parse_sse(r.text)
        check_ids(frames)
        assert frames[-1][1]["result"]["text"] == "Hello, stranger."
        url = f"/v1/runs/{body['runId']}"
        assert http.get(url, headers={"X-Run-Token": token}).json()["status"] == "succeeded"
        assert http.get(url).status_code == 401
        assert http.get(url, headers={"X-Run-Token": "z" * 32}).status_code == 404
        assert http.get(url, headers=env.auth()).status_code == 404
        replay = http.get(f"{url}/events", headers={"X-Run-Token": token})
        assert parse_sse(replay.text) == frames
        # An idempotent retry with the token replays the same run.
        retry = http.post("/v1/runs", json=body, headers={"X-Run-Token": token})
        assert retry.status_code == 200 and retry.headers["x-run-token"] == token
        assert parse_sse(retry.text) == frames
    assert len(env.model.requests) == 1


def test_ask_user_choice_interrupt_then_answer(serve: Callable[..., Env]) -> None:
    env = serve(
        Turn(
            [text("Let me ask.")],
            tools=[
                tool_use(
                    "c-ask",
                    "askUser",
                    prompt="Which one?",
                    options=[{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
                )
            ],
        ),
        Turn([text("You picked A.")]),
    )
    headers = env.auth()
    first = start_body([user_msg("pick one for me")], model=MODEL)
    with env.http() as http:
        r = http.post("/v1/runs", json=first, headers=headers)
        assert r.status_code == 200, r.text
        env.save("interrupt-choice", r.text)
        frames = parse_sse(r.text)
        check_ids(frames)
        [interrupt] = frames[-1][1]["outcome"]["interrupts"]
        assert interrupt["reason"] == "choice" and interrupt["id"] == "c-ask"
        assert interrupt["message"] == "Which one?"
        resume = {
            "threadId": first["threadId"],
            "runId": str(uuid.uuid4()),
            "messages": [user_msg("pick one for me")],
            "forwardedProps": {"model": MODEL, "previousRunId": first["runId"]},
            "resume": [
                {"interruptId": "c-ask", "status": "resolved", "payload": {"selection": ["a"]}}
            ],
        }
        r2 = http.post("/v1/runs", json=resume, headers=headers)
        assert r2.status_code == 200, r2.text
        env.save("resume-choice", r2.text)
        resumed = parse_sse(r2.text)
        check_ids(resumed)
        assert resumed[-1][1]["outcome"] == {"type": "success"}
        assert [f[1]["toolCallId"] for f in resumed if f[1]["type"] == "TOOL_CALL_RESULT"] == [
            "c-ask"
        ]


def test_render_ui_interrupt(serve: Callable[..., Env]) -> None:
    env = serve(
        Turn([], tools=[tool_use("c-ui", "renderUI", kind="confirm", props={"title": "Sure?"})])
    )
    with env.http() as http:
        r = http.post("/v1/runs", json=start_body([user_msg("ask me")], model=MODEL))
        assert r.status_code == 200, r.text
        env.save("interrupt-ui", r.text)
        frames = parse_sse(r.text)
        check_ids(frames)
        [interrupt] = frames[-1][1]["outcome"]["interrupts"]
        assert interrupt["reason"] == "ui-part"
        assert interrupt["metadata"]["hummingbird"]["uiKind"] == "confirm"


def test_model_failure_ends_the_stream_with_run_error(serve: Callable[..., Env]) -> None:
    env = serve(Turn([text("partial "), Boom()]))
    with env.http() as http:
        r = http.post("/v1/runs", json=start_body([user_msg("go")], model=MODEL))
        assert r.status_code == 200, r.text
        env.save("error", r.text)
        frames = parse_sse(r.text)
        check_ids(frames)
        closing = frames[-1][1]
        assert closing["type"] == "RUN_ERROR"
        assert closing["code"] and closing["message"]


def test_unknown_model_is_400_without_a_run(serve: Callable[..., Env]) -> None:
    env = serve()
    for headers in (env.auth(), {}):
        body = start_body([user_msg("hi")], model="anthropic/not-a-model")
        with env.http() as http:
            r = http.post("/v1/runs", json=body, headers=headers)
            assert r.status_code == 400 and r.json()["code"] == "unknown_model"
            assert http.get(f"/v1/runs/{body['runId']}", headers=env.auth()).status_code == 404
    if env.backend == "postgres":

        async def count(conn: asyncpg.Connection) -> int:
            return int(
                await conn.fetchval(
                    "SELECT count(*) FROM public.tasks WHERE user_id = $1", uuid.UUID(env.user)
                )
            )

        assert _db(count) == 0
    assert env.model.requests == []


# --- background (Postgres only) --------------------------------------------------------------


def test_background_run_is_executed_by_the_poller_and_streams(
    serve: Callable[..., Env], backend: str
) -> None:
    env = serve(Turn([text("Background "), text("answer.")]), WORKER_DRY_RUN="false")
    headers = env.auth()
    if backend != "postgres":
        body = start_body([user_msg("hi")], mode="background")
        with env.http() as http:
            r = http.post("/v1/runs", json=body, headers=headers)
        assert r.status_code == 503 and r.json()["code"] == "unavailable"
        return

    assert env.conversation is not None
    body = start_body([user_msg("research this")], mode="background", model=MODEL, maxSteps=3)
    body["threadId"] = env.conversation
    with env.http() as http:
        r = http.post("/v1/runs", json=body, headers=headers)
        assert r.status_code == 202, r.text
        assert r.json() == {"runId": body["runId"], "status": "queued"}
        # Rejoin right away: the stream follows the worker's events and
        # closes once the row settles.
        stream = http.get(f"/v1/runs/{body['runId']}/events", headers=headers)
        assert stream.status_code == 200
        env.save("background", stream.text)
        frames = parse_sse(stream.text)
        check_ids(frames)
        assert frames[0][1]["type"] == "RUN_STARTED"
        assert frames[-1][1]["type"] == "RUN_FINISHED"
        assert frames[-1][1]["outcome"] == {"type": "success"}
        text_out = "".join(f[1]["delta"] for f in frames if f[1]["type"] == "TEXT_MESSAGE_CONTENT")
        assert text_out == "Background answer."
        run = http.get(f"/v1/runs/{body['runId']}", headers=headers).json()
        assert run["status"] == "succeeded" and run["mode"] == "background"

    async def log(conn: asyncpg.Connection) -> list[tuple[int, str, str | None]]:
        rows = await conn.fetch(
            "SELECT seq, kind, payload->>'status' AS status FROM public.task_events "
            "WHERE task_id = $1 ORDER BY seq",
            uuid.UUID(body["runId"]),
        )
        return [(r["seq"], r["kind"], r["status"]) for r in rows]

    entries = _db(log)
    # The API wrote `status: queued` as seq 1; the executor continued at 2.
    assert entries[0] == (1, "status", "queued")
    assert entries[1][1:] == ("status", "running")
    assert [e[0] for e in entries] == list(range(1, len(entries) + 1))
    assert entries[-1][1] == "result" and entries[-1][2] == "done"
