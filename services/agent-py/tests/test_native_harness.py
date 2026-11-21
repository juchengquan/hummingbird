"""Wave 3b-C — the native harness adapter (`runs/native_harness.py`).

The Anthropic client is a scripted fake (`_Model`): each model call plays
the next `_Call` — stream events, then the final message's `tool_use`
blocks. No network. The run driver is played by `_drive`: a list sink,
an `asyncio.Event` cancel signal.
"""

from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest

from agent_py.emitter import RunEmitter
from agent_py.events import (
    StepErrorEvent,
    SuggestionsEvent,
    TaskEvent,
    TokenEvent,
    ToolInputEvent,
    ToolOutputEvent,
)
from agent_py.model_allowlist import resolve_api_model_id
from agent_py.runs.harness import HarnessResult, ResumeAnswer, RunInput
from agent_py.runs.history import UNANSWERED_TOOL_RESULT
from agent_py.runs.model import Cancelled, Failed, Interrupted, Succeeded
from agent_py.runs.native_harness import (
    DECLINED_APPROVAL,
    HARNESS_NAME,
    NativeHarness,
    Toolset,
    build_native_harness,
    default_toolset_builder,
    parse_run_options,
    validate_run_options,
)
from agent_py.settings import Settings
from agent_py.tools.ask_user import build_ask_user_tool
from agent_py.tools.registry import ToolDescriptor, ToolError, ToolInvocationResult
from agent_py.tools.render_ui import build_render_ui_tool

MODEL = "anthropic/claude-sonnet-4.6"

# --- the scripted model ------------------------------------------------------------


def text(t: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content_block_delta", delta=SimpleNamespace(type="text_delta", text=t)
    )


def thinking(t: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content_block_delta", delta=SimpleNamespace(type="thinking_delta", thinking=t)
    )


def usage(inp: int, out: int) -> list[SimpleNamespace]:
    return [
        SimpleNamespace(
            type="message_start", message=SimpleNamespace(usage=SimpleNamespace(input_tokens=inp))
        ),
        SimpleNamespace(type="message_delta", usage=SimpleNamespace(output_tokens=out)),
    ]


def call(cid: str, name: str, **args: Any) -> dict[str, Any]:
    return {"id": cid, "name": name, "input": args}


HANG = object()
"""In `_Call.events`: block until the stream is cancelled."""


@dataclass
class _Call:
    events: list[Any] = field(default_factory=list)
    tools: list[dict[str, Any]] = field(default_factory=list)
    raises: Exception | None = None
    final_text: str = ""


class _Stream:
    def __init__(self, model: _Model, step: _Call) -> None:
        self._model = model
        self._step = step

    async def __aenter__(self) -> _Stream:
        return self

    async def __aexit__(self, *args: Any) -> None:
        self._model.closed += 1

    def __aiter__(self) -> AsyncIterator[Any]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[Any]:
        for e in self._step.events:
            if e is HANG:
                self._model.hanging.set()
                await asyncio.sleep(3600)
            yield e
        if self._step.raises is not None:
            raise self._step.raises

    async def get_final_message(self) -> dict[str, Any]:
        content: list[dict[str, Any]] = []
        if self._step.final_text:
            content.append({"type": "text", "text": self._step.final_text})
        content += [{"type": "tool_use", **t} for t in self._step.tools]
        return {"content": content}

    @property
    def text_stream(self) -> AsyncIterator[str]:  # the suggestions call
        async def gen() -> AsyncIterator[str]:
            for e in self._step.events:
                yield e.delta.text

        return gen()


class _Model:
    """Fake `AsyncAnthropicClient`: one `_Call` per `messages.stream`."""

    def __init__(self, *calls: _Call) -> None:
        self._calls = list(calls)
        self.requests: list[dict[str, Any]] = []
        self.closed = 0
        self.hanging = asyncio.Event()
        model = self

        class _Messages:
            def stream(self, **kwargs: Any) -> _Stream:
                model.requests.append(copy.deepcopy(kwargs))
                if not model._calls:
                    raise AssertionError("unexpected model call")
                return _Stream(model, model._calls.pop(0))

        self.messages = _Messages()


# --- tools ----------------------------------------------------------------------------


def tool(
    name: str, *, result: str | None = None, hang: bool = False, fail: bool = False
) -> ToolDescriptor:
    calls: list[dict[str, Any]] = []

    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        calls.append(args)
        if hang:
            await asyncio.sleep(3600)
        if fail:
            raise ToolError("it broke")
        return ToolInvocationResult(text=result or f"{name} full result", summary=f"{name} ok")

    d = ToolDescriptor(
        name=name, description=name, input_schema={"type": "object"}, execute=execute
    )
    object.__setattr__(d, "calls", calls)  # frozen dataclass; test-only handle
    return d


def toolset(
    *tools: ToolDescriptor, gated: frozenset[str] = frozenset()
) -> Callable[[RunInput], Any]:
    async def build(_run_input: RunInput) -> Toolset:
        return Toolset(
            tools={t.name: t for t in (*tools, build_ask_user_tool(), build_render_ui_tool())},
            gated=gated,
        )

    return build


# --- the driver ----------------------------------------------------------------------


@dataclass
class _Run:
    result: HarnessResult
    events: list[TaskEvent]
    model: _Model

    def kinds(self) -> list[str]:
        return [e.kind for e in self.events]


def user(content: Any, mid: str = "u1") -> dict[str, Any]:
    return {"id": mid, "role": "user", "content": content}


def run_input(
    messages: list[dict[str, Any]] | None = None,
    *,
    run_id: str = "run-1",
    options: dict[str, Any] | None = None,
    **kw: Any,
) -> RunInput:
    return RunInput(
        run_id=run_id,
        thread_id="thread-1",
        mode="interactive",
        user_id="user-1",
        messages=tuple(messages or [user("hi")]),
        options={"model": MODEL, **(options or {})},
        **kw,
    )


async def _drive(
    model: _Model,
    inp: RunInput,
    *,
    tools: Callable[[RunInput], Any] | None = None,
    suggestions: bool = False,
    on_event: Callable[[TaskEvent, asyncio.Event], None] | None = None,
    cancel: asyncio.Event | None = None,
) -> _Run:
    events: list[TaskEvent] = []
    cancel = cancel or asyncio.Event()

    async def sink(e: TaskEvent) -> None:
        events.append(e)
        if on_event is not None:
            on_event(e, cancel)

    harness = build_native_harness(
        Settings(),
        client=model,  # type: ignore[arg-type]
        build_tools=tools or toolset(),
        suggestions=suggestions,
    )
    result = await harness.run(inp, RunEmitter(run_id=inp.run_id, sink=sink), cancel)
    return _Run(result, events, model)


def _balanced(events: list[TaskEvent]) -> bool:
    depth = 0
    for e in events:
        depth += {"step_start": 1, "step_end": -1}.get(e.kind, 0)
        if depth not in (0, 1):
            return False
    return depth == 0


# --- table: one run, no resume ------------------------------------------------------------


@dataclass
class Case:
    id: str
    calls: list[_Call]
    expect: Callable[[_Run], None]
    tools: tuple[ToolDescriptor, ...] = ()
    options: dict[str, Any] = field(default_factory=dict)
    client_tools: tuple[dict[str, Any], ...] = ()
    messages: list[dict[str, Any]] | None = None


def _text_run(r: _Run) -> None:
    assert r.kinds() == ["step_start", "token", "token", "step_end"]
    out = r.result.outcome
    assert isinstance(out, Succeeded)
    assert out.result.text == "Hello world" and not out.result.memory_tainted
    (u,) = out.usage
    assert (u.provider, u.model, u.input_tokens, u.output_tokens) == (
        "anthropic",
        resolve_api_model_id(MODEL),
        12,
        3,
    )
    req = r.model.requests[0]
    assert req["model"] == resolve_api_model_id(MODEL)
    assert req["messages"] == [{"role": "user", "content": "hi"}]
    assert {t["name"] for t in req["tools"]} == {"askUser", "renderUI"}
    assert r.result.checkpoint is None


def _reasoning_run(r: _Run) -> None:
    tokens = [e for e in r.events if isinstance(e, TokenEvent)]
    assert [(t.channel, t.text) for t in tokens] == [("reasoning", "hmm"), ("text", "answer")]
    out = r.result.outcome
    assert isinstance(out, Succeeded) and out.result.text == "answer"


def _tool_round_trip(r: _Run) -> None:
    assert r.kinds() == [
        "step_start",
        "token",
        "tool_input",
        "tool_output",
        "step_end",
        "step_start",
        "token",
        "step_end",
    ]
    tin = r.events[2]
    assert isinstance(tin, ToolInputEvent) and tin.args == {"url": "https://x"}
    tout = r.events[3]
    assert isinstance(tout, ToolOutputEvent) and tout.summary == "webFetch ok"
    out = r.result.outcome
    assert isinstance(out, Succeeded)
    assert out.result.text == "Let me look.It says hi."
    assert out.result.memory_tainted  # webFetch is untrusted
    # The second call sees the full tool result, not the summary.
    second = r.model.requests[1]["messages"]
    assert second[-1] == {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "c1", "content": "PAGE BODY"}],
    }
    assert second[-2]["role"] == "assistant"


def _trusted_tool(r: _Run) -> None:
    out = r.result.outcome
    assert isinstance(out, Succeeded) and not out.result.memory_tainted


def _tool_error(r: _Run) -> None:
    errs = [e for e in r.events if isinstance(e, StepErrorEvent)]
    assert [e.message for e in errs] == ["it broke"]
    tout = next(e for e in r.events if isinstance(e, ToolOutputEvent))
    assert tout.is_error
    assert isinstance(r.result.outcome, Succeeded)


def _model_error(r: _Run) -> None:
    assert r.kinds() == ["step_start", "token", "step_end"]  # closed by the adapter
    out = r.result.outcome
    assert isinstance(out, Failed)
    assert (out.code, out.message) == ("rate_limit", "429 Too Many Requests")


def _unknown_model(r: _Run) -> None:
    assert r.events == [] and r.model.requests == []
    out = r.result.outcome
    assert isinstance(out, Failed) and out.code == "unknown_model"


def _max_steps(r: _Run) -> None:
    out = r.result.outcome
    assert isinstance(out, Failed) and out.code == "max_steps"
    assert len(r.model.requests) == 2
    assert _balanced(r.events)


def _approval_interrupt(r: _Run) -> None:
    out = r.result.outcome
    assert isinstance(out, Interrupted)
    (i,) = out.interrupts
    agui = i.to_agui()
    assert agui["id"] == "c-del" and agui["reason"] == "approval"
    assert agui["metadata"] == {"hummingbird": {"tool": "deleteNote", "args": {"id": "n1"}}}
    # The sibling call ran; the gated one did not.
    assert [e.tool_name for e in r.events if isinstance(e, ToolOutputEvent)] == ["echo"]
    assert [e.tool_call_id for e in r.events if isinstance(e, ToolInputEvent)] == [
        "c-del",
        "c-echo",
    ]
    assert r.kinds()[-1] == "step_end"
    cp = r.result.checkpoint
    assert cp is not None and cp["harness"] == HARNESS_NAME
    assert cp["pending"] == [
        {"toolCallId": "c-del", "toolName": "deleteNote", "args": {"id": "n1"}, "client": False}
    ]
    assert cp["results"] == [{"type": "tool_result", "tool_use_id": "c-echo", "content": "ECHO"}]
    assert [m["role"] for m in cp["turn"]] == ["assistant"]  # type: ignore[index]
    json.dumps(cp)  # storable as jsonb


def _ask_user_choice(r: _Run) -> None:
    out = r.result.outcome
    assert isinstance(out, Interrupted)
    agui = out.interrupts[0].to_agui()
    assert agui["reason"] == "choice" and agui["message"] == "Which one?"
    assert agui["metadata"]["hummingbird"]["options"] == [  # type: ignore[index]
        {"id": "a", "label": "A"},
        {"id": "b", "label": "B"},
    ]
    assert agui["toolCallId"] == "c-ask"


def _render_ui(r: _Run) -> None:
    out = r.result.outcome
    assert isinstance(out, Interrupted)
    agui = out.interrupts[0].to_agui()
    assert agui["reason"] == "ui-part"
    assert agui["metadata"]["hummingbird"]["uiKind"] == "confirm"  # type: ignore[index]


def _client_tool(r: _Run) -> None:
    out = r.result.outcome
    assert isinstance(out, Interrupted)
    agui = out.interrupts[0].to_agui()
    assert agui["reason"] == "input"
    assert agui["metadata"]["hummingbird"]["tool"] == "pickFile"  # type: ignore[index]
    sent = {t["name"]: t for t in r.model.requests[0]["tools"]}
    assert sent["pickFile"]["input_schema"] == {
        "type": "object",
        "properties": {"kind": {"type": "string"}},
    }
    assert "bad name!" not in sent


def _history_translation(r: _Run) -> None:
    req = r.model.requests[0]
    assert req["system"] == "Be terse.\n\nYou are helpful."
    assert req["messages"] == [
        {"role": "user", "content": "first"},
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "I'll fetch."},
                {"type": "tool_use", "id": "old-1", "name": "webFetch", "input": {"url": "u"}},
                {"type": "tool_use", "id": "old-2", "name": "askUser", "input": {}},
            ],
        },
        {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "old-1", "content": '{"summary":"ok"}'},
                {
                    "type": "tool_result",
                    "tool_use_id": "old-2",
                    "content": UNANSWERED_TOOL_RESULT,
                    "is_error": True,
                },
                {"type": "text", "text": "second"},
                {"type": "image", "source": {"type": "url", "url": "https://img"}},
            ],
        },
    ]
    out = r.result.outcome
    assert isinstance(out, Succeeded) and out.result.memory_tainted  # uploaded image


CASES = [
    Case("text", [_Call([text("Hello"), text(" world"), *usage(12, 3)])], _text_run),
    Case("reasoning", [_Call([thinking("hmm"), text("answer")])], _reasoning_run),
    Case(
        "tool round trip",
        [
            _Call([text("Let me look.")], tools=[call("c1", "webFetch", url="https://x")]),
            _Call([text("It says hi.")]),
        ],
        _tool_round_trip,
        tools=(tool("webFetch", result="PAGE BODY"),),
    ),
    Case(
        "trusted tool does not taint",
        [_Call(tools=[call("c1", "generateImage")]), _Call([text("done")])],
        _trusted_tool,
        tools=(tool("generateImage"),),
    ),
    Case(
        "tool error",
        [_Call(tools=[call("c1", "flaky")]), _Call([text("sorry")])],
        _tool_error,
        tools=(tool("flaky", fail=True),),
    ),
    Case(
        "model error",
        [_Call([text("par")], raises=RuntimeError("429 Too Many Requests"))],
        _model_error,
    ),
    Case("unknown model", [], _unknown_model, options={"model": "openai/gpt-4o"}),
    Case(
        "max steps",
        [_Call(tools=[call("c1", "echo")]), _Call(tools=[call("c2", "echo")])],
        _max_steps,
        tools=(tool("echo"),),
        options={"maxSteps": 2},
    ),
    Case(
        "approval interrupt",
        [
            _Call(
                [text("Deleting.")],
                tools=[call("c-del", "deleteNote", id="n1"), call("c-echo", "echo")],
            )
        ],
        _approval_interrupt,
        tools=(tool("deleteNote"), tool("echo", result="ECHO")),
        options={"requireApprovalFor": ["deleteNote"]},
    ),
    Case(
        "askUser choice interrupt",
        [
            _Call(
                tools=[
                    call(
                        "c-ask",
                        "askUser",
                        prompt="Which one?",
                        options=[{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
                    )
                ]
            )
        ],
        _ask_user_choice,
    ),
    Case(
        "renderUI interrupt",
        [_Call(tools=[call("c-ui", "renderUI", kind="confirm", props={"title": "Sure?"})])],
        _render_ui,
    ),
    Case(
        "client tool interrupt",
        [_Call(tools=[call("c-pick", "pickFile", kind="pdf")])],
        _client_tool,
        client_tools=(
            {
                "name": "pickFile",
                "description": "Pick a file",
                "parameters": {"type": "object", "properties": {"kind": {"type": "string"}}},
            },
            {"name": "bad name!", "description": "x"},
        ),
    ),
    Case(
        "history translation",
        [_Call([text("ok")])],
        _history_translation,
        options={"systemPrompt": "Be terse."},
        messages=[
            {"id": "s", "role": "system", "content": "You are helpful."},
            user("first", "u0"),
            {
                "id": "a0",
                "role": "assistant",
                "content": "I'll fetch.",
                "toolCalls": [
                    {
                        "id": "old-1",
                        "type": "function",
                        "function": {"name": "webFetch", "arguments": '{"url":"u"}'},
                    },
                    {
                        "id": "old-2",
                        "type": "function",
                        "function": {"name": "askUser", "arguments": ""},
                    },
                ],
            },
            {"id": "r0", "role": "reasoning", "content": "thinking..."},
            {"id": "t0", "role": "tool", "toolCallId": "old-1", "content": '{"summary":"ok"}'},
            {
                "id": "act",
                "role": "activity",
                "activityType": "hummingbird.suggestions",
                "content": {},
            },
            user(
                [
                    {"type": "text", "text": "second"},
                    {"type": "image", "source": {"type": "url", "value": "https://img"}},
                ]
            ),
        ],
    ),
]


@pytest.mark.parametrize("case", CASES, ids=[c.id for c in CASES])
async def test_native_harness(case: Case) -> None:
    r = await _drive(
        _Model(*case.calls),
        run_input(case.messages, options=case.options, tools=case.client_tools),
        tools=toolset(*case.tools),
    )
    assert _balanced(r.events)
    case.expect(r)


# --- resume (Q24) ---------------------------------------------------------------------------


async def _interrupt_then_resume(
    first: list[_Call],
    second: list[_Call],
    answers: tuple[ResumeAnswer, ...],
    *,
    tools: tuple[ToolDescriptor, ...] = (),
    options: dict[str, Any] | None = None,
    client_tools: tuple[dict[str, Any], ...] = (),
    with_checkpoint: bool = True,
    browser_output: list[dict[str, Any]] | None = None,
) -> tuple[_Run, _Run]:
    build = toolset(*tools)
    r1 = await _drive(
        _Model(*first),
        run_input(options=options, tools=client_tools),
        tools=build,
    )
    assert isinstance(r1.result.outcome, Interrupted)
    # The browser folds run 1's output into its history (RUN_EVENTS.md § 7).
    history = [user("hi"), *(browser_output or [])]
    r2 = await _drive(
        _Model(*second),
        run_input(
            history,
            run_id="run-2",
            options=options,
            tools=client_tools,
            resume=answers,
            previous_run_id="run-1",
            previous_checkpoint=r1.result.checkpoint if with_checkpoint else None,
        ),
        tools=build,
    )
    return r1, r2


def _browser_assistant(
    *calls: tuple[str, str, dict[str, Any]], content: str | None = None
) -> dict[str, Any]:
    msg: dict[str, Any] = {
        "id": "run-1:2",
        "role": "assistant",
        "toolCalls": [
            {
                "id": cid,
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }
            for cid, name, args in calls
        ],
    }
    if content:
        msg["content"] = content
    return msg


async def test_approval_approved_resume_runs_the_tool_and_continues_the_turn() -> None:
    delete = tool("deleteNote", result="DELETED")
    _, r2 = await _interrupt_then_resume(
        [
            _Call(
                [text("Deleting.")],
                tools=[call("c-del", "deleteNote", id="n1"), call("c-echo", "echo")],
                final_text="Deleting.",
            )
        ],
        [_Call([text("Done.")])],
        (ResumeAnswer("c-del", "resolved", {"approved": True, "args": {"id": "n2"}}),),
        tools=(delete, tool("echo", result="ECHO")),
        options={"requireApprovalFor": ["deleteNote"]},
        browser_output=[
            _browser_assistant(
                ("c-del", "deleteNote", {"id": "n1"}), ("c-echo", "echo", {}), content="Deleting."
            ),
            {
                "id": "run-1:5",
                "role": "tool",
                "toolCallId": "c-echo",
                "content": '{"summary":"echo ok"}',
            },
        ],
    )
    # The answer's tool ran with the edited args, in a step of its own.
    assert delete.calls == [{"id": "n2"}]  # type: ignore[attr-defined]
    assert r2.kinds() == [
        "step_start",
        "tool_output",
        "step_end",
        "step_start",
        "token",
        "step_end",
    ]
    # The model sees the turn from the checkpoint — the echo's FULL result,
    # not the browser's summary — answered in call order.
    msgs = r2.model.requests[0]["messages"]
    assert msgs[0] == {"role": "user", "content": "hi"}
    assert [b["type"] for b in msgs[1]["content"]] == ["text", "tool_use", "tool_use"]
    assert msgs[2] == {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "c-del", "content": "DELETED"},
            {"type": "tool_result", "tool_use_id": "c-echo", "content": "ECHO"},
        ],
    }
    out = r2.result.outcome
    assert isinstance(out, Succeeded) and out.result.text == "Done."
    # echo ran in run 1 (untrusted) → the continued turn stays tainted.
    assert out.result.memory_tainted


async def test_approval_declined_resume_tells_the_model_and_runs_nothing() -> None:
    delete = tool("deleteNote")
    _, r2 = await _interrupt_then_resume(
        [_Call(tools=[call("c-del", "deleteNote", id="n1")])],
        [_Call([text("OK, kept it.")])],
        (ResumeAnswer("c-del", "cancelled"),),
        tools=(delete,),
        options={"requireApprovalFor": ["deleteNote"]},
        browser_output=[_browser_assistant(("c-del", "deleteNote", {"id": "n1"}))],
    )
    assert delete.calls == []  # type: ignore[attr-defined]
    msgs = r2.model.requests[0]["messages"]
    assert msgs[-1]["content"] == [
        {"type": "tool_result", "tool_use_id": "c-del", "content": DECLINED_APPROVAL}
    ]
    out = r2.result.outcome
    assert isinstance(out, Succeeded) and not out.result.memory_tainted


async def test_ask_user_answer_becomes_the_tool_result() -> None:
    _, r2 = await _interrupt_then_resume(
        [
            _Call(
                tools=[
                    call("c-ask", "askUser", prompt="Which?", options=[{"id": "a", "label": "A"}])
                ]
            )
        ],
        [_Call([text("Going with A.")])],
        (ResumeAnswer("c-ask", "resolved", {"selection": ["a"]}),),
        browser_output=[_browser_assistant(("c-ask", "askUser", {}))],
    )
    tout = next(e for e in r2.events if isinstance(e, ToolOutputEvent))
    assert (tout.tool_call_id, tout.summary) == ("c-ask", "User selected: a")
    assert r2.model.requests[0]["messages"][-1]["content"][0]["content"] == "User selected: a"


async def test_client_tool_answer_is_the_tools_result() -> None:
    client_tools = ({"name": "pickFile", "description": "Pick a file"},)
    _, r2 = await _interrupt_then_resume(
        [_Call(tools=[call("c-pick", "pickFile")])],
        [_Call([text("Got it.")])],
        (ResumeAnswer("c-pick", "resolved", {"value": "report.pdf"}),),
        client_tools=client_tools,
        browser_output=[_browser_assistant(("c-pick", "pickFile", {}))],
    )
    assert r2.model.requests[0]["messages"][-1]["content"] == [
        {"type": "tool_result", "tool_use_id": "c-pick", "content": "report.pdf"}
    ]
    out = r2.result.outcome
    assert isinstance(out, Succeeded) and out.result.memory_tainted


async def test_interrupt_chain_carries_the_whole_turn() -> None:
    """Run 2 answers run 1, then interrupts again; run 3 sees run 1's and
    run 2's model turns from run 2's checkpoint."""
    build = toolset()
    ask1 = call("c1", "askUser", prompt="One?")
    ask2 = call("c2", "askUser", prompt="Two?")
    r1 = await _drive(_Model(_Call(tools=[ask1])), run_input(), tools=build)
    r2 = await _drive(
        _Model(_Call([text("next")], tools=[ask2], final_text="next")),
        run_input(
            [user("hi"), _browser_assistant(("c1", "askUser", {}))],
            run_id="run-2",
            resume=(ResumeAnswer("c1", "resolved", {"value": "first"}),),
            previous_run_id="run-1",
            previous_checkpoint=r1.result.checkpoint,
        ),
        tools=build,
    )
    assert isinstance(r2.result.outcome, Interrupted)
    cp = r2.result.checkpoint
    assert cp is not None
    assert [m["role"] for m in cp["turn"]] == ["assistant", "user", "assistant"]  # type: ignore[index]
    r3 = await _drive(
        _Model(_Call([text("done")])),
        run_input(
            [user("hi")],
            run_id="run-3",
            resume=(ResumeAnswer("c2", "resolved", {"value": "second"}),),
            previous_run_id="run-2",
            previous_checkpoint=cp,
        ),
        tools=build,
    )
    msgs = r3.model.requests[0]["messages"]
    results = [
        b["content"]
        for m in msgs
        if m["role"] == "user" and isinstance(m["content"], list)
        for b in m["content"]
    ]
    assert results == ["first", "second"]
    assert isinstance(r3.result.outcome, Succeeded)


async def test_resume_without_checkpoint_falls_back_to_the_browser_history() -> None:
    _, r2 = await _interrupt_then_resume(
        [_Call(tools=[call("c-ask", "askUser", prompt="Name?")])],
        [_Call([text("Hi Ann.")])],
        (ResumeAnswer("c-ask", "resolved", {"value": "Ann"}),),
        with_checkpoint=False,
        browser_output=[_browser_assistant(("c-ask", "askUser", {"prompt": "Name?"}))],
    )
    msgs = r2.model.requests[0]["messages"]
    assert msgs[1]["content"] == [
        {"type": "tool_use", "id": "c-ask", "name": "askUser", "input": {"prompt": "Name?"}}
    ]
    assert msgs[2]["content"] == [{"type": "tool_result", "tool_use_id": "c-ask", "content": "Ann"}]
    assert isinstance(r2.result.outcome, Succeeded)


async def test_resume_of_an_unknown_call_without_checkpoint_fails() -> None:
    r = await _drive(
        _Model(),
        run_input(resume=(ResumeAnswer("nope", "resolved", {"value": "x"}),), previous_run_id="r0"),
    )
    out = r.result.outcome
    assert isinstance(out, Failed) and out.code == "invalid_state"


# --- cancel ------------------------------------------------------------------------------------


async def test_cancel_mid_stream_returns_promptly_and_closes_the_stream() -> None:
    model = _Model(_Call([text("partial"), HANG, text("never")]))
    loop = asyncio.get_running_loop()
    cancelled_at: list[float] = []

    def on_event(e: TaskEvent, cancel: asyncio.Event) -> None:
        if isinstance(e, TokenEvent):

            async def fire() -> None:
                await model.hanging.wait()
                cancelled_at.append(loop.time())
                cancel.set()

            asyncio.get_running_loop().create_task(fire())

    r = await asyncio.wait_for(_drive(model, run_input(), on_event=on_event), timeout=2)
    latency = loop.time() - cancelled_at[0]
    assert isinstance(r.result.outcome, Cancelled)
    assert r.kinds() == ["step_start", "token", "step_end"]
    assert model.closed == 1
    assert latency < 0.1


async def test_cancel_mid_tool_abandons_the_tool() -> None:
    slow = tool("slow", hang=True)

    def on_event(e: TaskEvent, cancel: asyncio.Event) -> None:
        if isinstance(e, ToolInputEvent):
            asyncio.get_running_loop().call_later(0.01, cancel.set)

    r = await asyncio.wait_for(
        _drive(
            _Model(_Call(tools=[call("c1", "slow")])),
            run_input(),
            tools=toolset(slow),
            on_event=on_event,
        ),
        timeout=2,
    )
    assert isinstance(r.result.outcome, Cancelled)
    assert "tool_output" not in r.kinds()
    assert _balanced(r.events)


async def test_cancel_between_steps_stops_before_the_next_model_call() -> None:
    def on_event(e: TaskEvent, cancel: asyncio.Event) -> None:
        if isinstance(e, ToolOutputEvent):
            cancel.set()

    model = _Model(_Call(tools=[call("c1", "echo")]), _Call([text("never")]))
    r = await _drive(model, run_input(), tools=toolset(tool("echo")), on_event=on_event)
    assert isinstance(r.result.outcome, Cancelled)
    assert len(model.requests) == 1


async def test_already_cancelled_run_emits_nothing() -> None:
    cancel = asyncio.Event()
    cancel.set()
    r = await _drive(_Model(), run_input(), cancel=cancel)
    assert isinstance(r.result.outcome, Cancelled) and r.events == []


# --- suggestions, options, factory ---------------------------------------------------------------


async def test_suggestions_follow_the_answer_and_count_in_usage() -> None:
    model = _Model(
        _Call([text("The answer."), *usage(10, 2)]),
        _Call([text('["Why?", "How?"]')], final_text='["Why?", "How?"]'),
    )
    r = await _drive(model, run_input(), suggestions=True)
    assert r.kinds() == ["step_start", "token", "suggestions", "step_end"]
    sugg = r.events[2]
    assert isinstance(sugg, SuggestionsEvent) and sugg.values == ("Why?", "How?")
    assert isinstance(r.result.outcome, Succeeded)


async def test_unavailable_client_fails_the_run() -> None:
    harness = NativeHarness(client_factory=lambda: None, build_tools=toolset(), suggestions=False)
    res = await harness.run(run_input(), RunEmitter(run_id="r", sink=_noop), asyncio.Event())
    assert isinstance(res.outcome, Failed) and res.outcome.code == "unavailable"


async def _noop(_e: TaskEvent) -> None:
    return None


def test_validate_run_options_rejects_unknown_models() -> None:
    validate_run_options({"model": MODEL})
    validate_run_options({})  # the default
    with pytest.raises(ValueError) as exc:
        validate_run_options({"model": "openai/gpt-4o"})
    assert getattr(exc.value, "code", None) == "unknown_model"


def test_parse_run_options_is_lenient() -> None:
    opts = parse_run_options(
        {
            "maxSteps": 99,
            "skills": [{"id": "webSearch", "webSearchConfig": {"maxCalls": 3}}, "junk"],
            "requireApprovalFor": ["a", 1],
            "workspaceId": "ws",
        }
    )
    assert opts.max_steps == 50
    assert opts.skill_ids == ("webSearch",)
    assert opts.skill_configs.web_search == {"maxCalls": 3}
    assert opts.require_approval_for == frozenset({"a"})
    assert parse_run_options({"maxSteps": True}).max_steps == 6


async def test_default_toolset_offers_the_requested_skills_and_hitl_tools_only() -> None:
    build = default_toolset_builder(lambda: None)
    ts = await build(run_input(options={"skills": [{"id": "webFetch"}, {"id": "nope"}]}))
    assert set(ts.tools) == {"webFetch", "askUser", "renderUI"}
    ts = await build(run_input())
    assert set(ts.tools) == {"askUser", "renderUI"}


async def test_client_tool_resume_works_without_the_tools_being_resent() -> None:
    client_tools = ({"name": "pickFile", "description": "Pick a file"},)
    r1 = await _drive(
        _Model(_Call(tools=[call("c-pick", "pickFile")])), run_input(tools=client_tools)
    )
    cp = r1.result.checkpoint
    assert cp is not None and cp["pending"][0]["client"] is True  # type: ignore[index]
    r2 = await _drive(
        _Model(_Call([text("ok")])),
        run_input(
            [user("hi")],
            run_id="run-2",
            resume=(ResumeAnswer("c-pick", "resolved", {"value": "a.pdf"}),),
            previous_run_id="run-1",
            previous_checkpoint=cp,
        ),
    )
    assert r2.model.requests[0]["messages"][-1]["content"][0]["content"] == "a.pdf"


async def test_fallback_resume_refuses_to_approve_a_tool_that_is_not_gated() -> None:
    echo = tool("echo")
    r = await _drive(
        _Model(),
        run_input(
            [user("hi"), _browser_assistant(("c1", "echo", {}))],
            resume=(ResumeAnswer("c1", "resolved", {"approved": True}),),
            previous_run_id="r0",
        ),
        tools=toolset(echo),
    )
    out = r.result.outcome
    assert isinstance(out, Failed) and out.code == "invalid_state"
    assert echo.calls == []  # type: ignore[attr-defined]
    assert r.events == []
