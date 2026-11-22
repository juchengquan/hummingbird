"""Wave 5a — the native harness's extension points (`runs/hook_types.py`,
`runs/harness_hooks.py`), the run-scoped tool context
(`tools.registry.RunToolContext`) and the `mcp_app` tool-result field.

The model is `test_native_harness`'s scripted fake.
"""

from __future__ import annotations

import asyncio
import dataclasses
from collections.abc import Mapping, Sequence
from typing import Any

from agent_py.chat_loop import LoopResult
from agent_py.emitter import RunEmitter
from agent_py.events import McpAppEvent, TaskEvent
from agent_py.runs.agui_encoder import AgUiRunEncoder
from agent_py.runs.harness import HarnessResult, ResumeAnswer, RunInput
from agent_py.runs.harness_hooks import DEFAULT_HOOKS, PROMPT_SECTIONS
from agent_py.runs.hook_types import HookContext, ResolvedModel, ToolsetDraft
from agent_py.runs.model import RunResultData, Succeeded
from agent_py.runs.native_harness import build_native_harness
from agent_py.runs.options import RunOptions, parse_run_options
from agent_py.settings import Settings
from agent_py.tools.registry import (
    McpAppPayload,
    RunToolContext,
    ToolDescriptor,
    ToolInvocationResult,
)

from .runs_support import assert_valid
from .test_native_harness import MODEL, _Call, _Model, call, run_input, text, tool, toolset, user


async def _run(
    model: _Model,
    inp: RunInput,
    **harness_kw: Any,
) -> tuple[HarnessResult, list[TaskEvent]]:
    events: list[TaskEvent] = []

    async def sink(e: TaskEvent) -> None:
        events.append(e)

    harness = build_native_harness(
        Settings(),
        client=model,  # type: ignore[arg-type]
        suggestions=False,
        **harness_kw,
    )
    result = await harness.run(inp, RunEmitter(run_id=inp.run_id, sink=sink), asyncio.Event())
    return result, events


# --- the system prompt is what it was before wave 5a -----------------------------------------


def _pre_5a_system_prompt(opts: RunOptions, ri: RunInput) -> str | None:
    """`native_harness._system_prompt` as it was, verbatim."""
    from agent_py.runs.history import system_texts

    parts: list[str] = []
    if opts.system_prompt:
        parts.append(opts.system_prompt)
    parts.extend(system_texts(ri.messages))
    context_lines = [
        f"- {c.get('description')}: {c.get('value')}"
        for c in ri.context
        if isinstance(c.get("description"), str) and isinstance(c.get("value"), str)
    ]
    if context_lines:
        parts.append("Context from the application:\n" + "\n".join(context_lines))
    return "\n\n".join(parts) or None


async def test_default_prompt_sections_are_byte_identical_to_the_old_prompt() -> None:
    messages = [
        {"id": "s1", "role": "system", "content": "Be brief."},
        {"id": "d1", "role": "developer", "content": "Line one.\n\nLine two."},
        {"id": "s2", "role": "system", "content": "   "},
        user("hi"),
    ]
    context = (
        {"description": "Open document", "value": "notes.md"},
        {"description": "Skipped", "value": 3},
        {"description": "Locale", "value": "en-GB"},
    )
    cases = [
        run_input(messages, options={"systemPrompt": "You are Humm."}, context=context),
        run_input(messages),
        run_input([user("hi")], context=context),
        run_input([user("hi")], options={"systemPrompt": "Only this."}),
    ]
    for inp in cases:
        model = _Model(_Call([text("ok")]))
        await _run(model, inp, build_tools=toolset())
        expected = _pre_5a_system_prompt(parse_run_options(inp.options), inp)
        assert expected is not None
        assert model.requests[0]["system"] == expected
    assert model.requests[0]["system"] == "Only this."
    # Pinned literally once, so the reference above cannot drift with it.
    assert _pre_5a_system_prompt(parse_run_options(cases[0].options), cases[0]) == (
        "You are Humm.\n\nBe brief.\n\nLine one.\n\nLine two.\n\n"
        "Context from the application:\n- Open document: notes.md\n- Locale: en-GB"
    )


async def test_no_section_means_no_system_parameter() -> None:
    model = _Model(_Call([text("ok")]))
    await _run(model, run_input(), build_tools=toolset())
    assert "system" not in model.requests[0]


async def test_default_hooks_are_the_registered_lists() -> None:
    assert DEFAULT_HOOKS.prompt_sections == PROMPT_SECTIONS
    assert [f.__name__ for f in DEFAULT_HOOKS.tool_contributors] == [
        "skill_tools",
        "cloud_mcp_tools",
        "local_mcp_tools",
        "rag_search_files",
        "memory_tools",
        "citation_sources",
    ]
    assert [f.__name__ for f in DEFAULT_HOOKS.taint_seeds] == [
        "history_taint",
        "attachment_context_taint",
    ]


# --- a workstream's hooks plug in without touching the harness ---------------------------------


async def test_added_hooks_extend_the_prompt_tools_taint_model_and_result() -> None:
    seen: dict[str, Any] = {}

    async def remix_note(ri: RunInput, opts: RunOptions, ctx: HookContext) -> str | None:
        ctx.scratch["note"] = True
        return "Reference image: x" if opts.reference_image else None

    def attachment_taint(
        ri: RunInput, opts: RunOptions, ctx: HookContext, history: Sequence[Mapping[str, object]]
    ) -> str | None:
        return "a bookmark" if opts.attachments else None

    async def extra_tool(
        ri: RunInput, opts: RunOptions, ctx: HookContext, draft: ToolsetDraft
    ) -> None:
        seen["tools_before"] = sorted(draft.tools)
        draft.tools["mcp__local__ping"] = tool("mcp__local__ping")
        draft.gated.add("mcp__local__ping")

    async def pick_model(ri: RunInput, opts: RunOptions, ctx: HookContext) -> ResolvedModel:
        seen["model"] = opts.model
        return ResolvedModel(catalog_id=MODEL, api_id="routed-model")

    async def verified(
        ri: RunInput, opts: RunOptions, ctx: HookContext, result: LoopResult
    ) -> RunResultData:
        seen["scratch"] = dict(ctx.scratch)
        return RunResultData(text=f"{result.text} (checked)", memory_tainted=True)

    hooks = dataclasses.replace(
        DEFAULT_HOOKS,
        prompt_sections=(*DEFAULT_HOOKS.prompt_sections, remix_note),
        tool_contributors=(*DEFAULT_HOOKS.tool_contributors, extra_tool),
        taint_seeds=(*DEFAULT_HOOKS.taint_seeds, attachment_taint),
        resolve_model=pick_model,
        post_success=verified,
    )
    model = _Model(_Call([text("answer")]))
    inp = run_input(
        options={
            "model": "auto",
            "systemPrompt": "Base.",
            "skills": [{"id": "webFetch"}],
            "referenceImage": {"url": "https://img/x.png"},
            "attachments": [{"kind": "bookmark", "url": "https://b", "title": "B", "text": "t"}],
        }
    )
    result, _ = await _run(model, inp, hooks=hooks, pool_provider=lambda: None)
    request = model.requests[0]
    assert request["model"] == "routed-model" and seen["model"] == "auto"
    # The bookmark renders through 5b-B's `attachment_context` section.
    assert request["system"].startswith("Base.\n\nThe user has saved these web pages")
    assert request["system"].endswith("--- B (https://b) ---\nt\n\nReference image: x")
    assert {t["name"] for t in request["tools"]} == {
        "webFetch",
        "askUser",
        "renderUI",
        "mcp__local__ping",
    }
    assert seen["tools_before"] == ["askUser", "renderUI", "webFetch"]
    out = result.outcome
    assert isinstance(out, Succeeded)
    assert out.result.text == "answer (checked)" and out.result.memory_tainted
    assert seen["scratch"] == {"note": True}


async def test_a_contributed_gated_tool_interrupts() -> None:
    async def gated_tool(
        ri: RunInput, opts: RunOptions, ctx: HookContext, draft: ToolsetDraft
    ) -> None:
        draft.tools["mcp__local__rm"] = tool("mcp__local__rm")
        draft.gated.add("mcp__local__rm")

    hooks = dataclasses.replace(
        DEFAULT_HOOKS, tool_contributors=(*DEFAULT_HOOKS.tool_contributors, gated_tool)
    )
    result, _ = await _run(
        _Model(_Call(tools=[call("c1", "mcp__local__rm")])),
        run_input(),
        hooks=hooks,
        pool_provider=lambda: None,
    )
    assert type(result.outcome).__name__ == "Interrupted"


async def test_a_taint_seed_taints_the_turn() -> None:
    def always(
        ri: RunInput, opts: RunOptions, ctx: HookContext, history: Sequence[Mapping[str, object]]
    ) -> str | None:
        return "an attached bookmark"

    hooks = dataclasses.replace(DEFAULT_HOOKS, taint_seeds=(*DEFAULT_HOOKS.taint_seeds, always))
    result, _ = await _run(
        _Model(_Call([text("ok")])), run_input(), hooks=hooks, build_tools=toolset()
    )
    out = result.outcome
    assert isinstance(out, Succeeded) and out.result.memory_tainted


# --- RunToolContext ------------------------------------------------------------------------


def _context_tool(name: str, seen: list[RunToolContext]) -> ToolDescriptor:
    async def execute(_args: dict[str, Any]) -> ToolInvocationResult:
        raise AssertionError("the loop must call run_execute")

    async def run_execute(_args: dict[str, Any], ctx: RunToolContext) -> ToolInvocationResult:
        seen.append(ctx)
        ok = ctx.consume_budget("imageGen")
        return ToolInvocationResult(text=f"budget ok: {ok}", summary="ok")

    return ToolDescriptor(
        name=name,
        description=name,
        input_schema={"type": "object"},
        execute=execute,
        run_execute=run_execute,
    )


async def test_every_tool_gets_the_run_context_even_anonymous() -> None:
    seen: list[RunToolContext] = []
    asked: list[tuple[str | None, str]] = []

    def budget(client_key: str | None, kind: str) -> bool:
        asked.append((client_key, kind))
        return False

    inp = dataclasses.replace(
        run_input(options={"localFilesOnly": True}), user_id=None, client_key="203.0.113.7"
    )
    model = _Model(
        _Call(tools=[call("c1", "webFetch"), call("c2", "generateImage")]), _Call([text("done")])
    )
    result, _ = await _run(
        model,
        inp,
        build_tools=toolset(tool("webFetch"), _context_tool("generateImage", seen)),
        consume_budget=budget,
    )
    assert isinstance(result.outcome, Succeeded)
    (ctx,) = seen
    assert ctx.client_key == "203.0.113.7" and ctx.user_id is None and ctx.run_id == "run-1"
    assert ctx.local_files_only is True
    # The untrusted webFetch ran first in the turn.
    assert ctx.tainted_by == "webFetch"
    assert asked == [("203.0.113.7", "imageGen")]
    assert model.requests[1]["messages"][-1]["content"][1]["content"] == "budget ok: False"


async def test_the_default_budget_allows_and_resumed_approvals_get_the_context() -> None:
    seen: list[RunToolContext] = []
    rm = _context_tool("rm", seen)
    r1, _ = await _run(
        _Model(_Call(tools=[call("c1", "rm")])),
        run_input(options={"requireApprovalFor": ["rm"]}),
        build_tools=toolset(rm),
    )
    r2, _ = await _run(
        _Model(_Call([text("done")])),
        run_input(
            [user("hi")],
            run_id="run-2",
            options={"requireApprovalFor": ["rm"]},
            resume=(ResumeAnswer("c1", "resolved", {"approved": True}),),
            previous_run_id="run-1",
            previous_checkpoint=r1.checkpoint,
            client_key="198.51.100.2",
        ),
        build_tools=toolset(rm),
    )
    assert isinstance(r2.outcome, Succeeded)
    (ctx,) = seen
    assert ctx.client_key == "198.51.100.2" and ctx.run_id == "run-2"
    assert ctx.consume_budget("anything")


# --- mcp_app --------------------------------------------------------------------------------


def _app_tool(*, fail: bool = False) -> ToolDescriptor:
    async def execute(_args: dict[str, Any]) -> ToolInvocationResult:
        if fail:
            from agent_py.tools.registry import ToolError

            raise ToolError("server down")
        return ToolInvocationResult(
            text="chart rendered",
            summary="chart",
            mcp_app=McpAppPayload(
                server_id="srv-1", html="<div>chart</div>", resource_uri="ui://chart"
            ),
        )

    return ToolDescriptor(
        name="mcp__srv-1__chart", description="", input_schema={"type": "object"}, execute=execute
    )


async def test_an_mcp_app_on_the_tool_result_is_emitted_after_it() -> None:
    result, events = await _run(
        _Model(_Call(tools=[call("c-app", "mcp__srv-1__chart")]), _Call([text("Here.")])),
        run_input(),
        build_tools=toolset(_app_tool()),
    )
    assert isinstance(result.outcome, Succeeded)
    kinds = [e.kind for e in events]
    assert kinds[:5] == ["step_start", "tool_input", "tool_output", "mcp_app", "step_end"]
    app = next(e for e in events if isinstance(e, McpAppEvent))
    assert (app.tool_call_id, app.server_id, app.html, app.resource_uri, app.truncated) == (
        "c-app",
        "srv-1",
        "<div>chart</div>",
        "ui://chart",
        False,
    )
    # …and encodes as the existing `hummingbird.mcp_app` activity.
    encoded = AgUiRunEncoder("run-1").encode(app)
    (activity,) = [e for e in encoded if e["type"] == "ACTIVITY_SNAPSHOT"]
    assert_valid(activity)
    assert activity["activityType"] == "hummingbird.mcp_app"
    assert activity["content"] == {
        "id": "c-app",
        "serverId": "srv-1",
        "html": "<div>chart</div>",
        "resourceUri": "ui://chart",
    }


async def test_a_failed_tool_emits_no_mcp_app() -> None:
    _, events = await _run(
        _Model(_Call(tools=[call("c-app", "mcp__srv-1__chart")]), _Call([text("Sorry.")])),
        run_input(),
        build_tools=toolset(_app_tool(fail=True)),
    )
    assert "mcp_app" not in [e.kind for e in events]
