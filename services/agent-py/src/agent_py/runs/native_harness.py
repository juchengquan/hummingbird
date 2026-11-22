"""The native harness adapter — today's agent loop behind `HarnessAdapter`.

Wave 3b-C of `docs/PLAN-frontend-backend-split.md` (Q8): the loop
`/v1/chat` runs (`chat_loop.run_turn_loop`) as the first adapter, for
**interactive** runs. Background runs keep going through the poller and
`executor.py` this wave.

**Input.** The browser owns the history (Q15): `RunInput.messages` are
AG-UI messages, translated by `runs.history` (activity / reasoning
messages dropped, system / developer text joined into the system
prompt). `forwardedProps` (`RunInput.options`, `RunForwardedProps`):

| key | use |
|---|---|
| `model` | allow-listed catalog id (`config/models.json`); absent → the service default. Unknown → `Failed("unknown_model")`, like `/v1/chat`'s 400 |
| `systemPrompt` | prepended to the system prompt |
| `skills[]` | the backend tools offered: `webSearch`, `webFetch`, `imageGen` (→ `generateImage`), `searchFiles` (signed-in runs), with their per-skill config |
| `maxSteps` | model calls per run, 1 to 50; absent → `DEFAULT_MAX_STEPS` (chat's 6) |
| `requireApprovalFor[]` | tool names that wait for the user's approval |
| `workspaceId` | scopes `searchFiles` and adds the workspace's cloud MCP tools (signed-in runs) |
| `reasoningEffort` | `low` / `medium` / `high` → extended thinking with that tier's budget, as the Next chat route maps it (`reasoning_effort.py`); ignored for a model the catalog does not flag `supportsReasoningEffort`, and on a call continuing a tool-use turn whose assistant turns carry no thinking blocks (a resume of a run that did not think — Anthropic rejects thinking there) |

User messages may carry images and documents (`runs.history`,
*Attachments* — refused at the API when they cannot be given to the
model). A tool that produces images or files (`generateImage`) emits
them as a `tool_image` / `tool_file` part after its result
(`chat_loop.emit_tool_run`; RUN_EVENTS.md § 3.3).

`askUser` and `renderUI` are always offered and always wait for an
answer; MCP tools their server marks for approval wait too. Client-side
AG-UI `tools` are offered to the model and never run here.

**Interrupts (RUN_EVENTS.md § 4).** When the model calls a gated tool the
step's other calls still run, then the run ends `Interrupted` with one
`PendingInterrupt` per gated call (id = the tool call id): `approval`
(an approval-gated tool), `choice` / `input` (`askUser`), `ui-part`
(`renderUI`); a client tool is `input` — the client runs it and answers
`{value: <result text>}`.

**Resume (Q24).** A resume run gets `resume[]` + `previous_run_id`, and
the history the browser holds. What it continues from is the harness
state the interrupted run returned (`HarnessResult.checkpoint`, which the
driver stores in that run's `tasks.checkpoint` and hands to the resume
run as `RunInput.previous_checkpoint` — Q31: opaque, keyed by run):

    {"harness": "loop-v1", "version": 1,
     "turn":    [Anthropic messages the interrupted turn added, from its
                 first assistant turn to the one holding the gated calls],
     "pending": [{"toolCallId", "toolName", "args", "client"}],
     "results": [tool_result blocks of that step's calls that did run],
     "taintedBy": "<first untrusted tool>" | null}

The resume run rebuilds the model input as *the browser's history up to
its last user message* + `turn` + one `tool_result` per call (the
answers, then the stored results), so the model sees the turn exactly as
it was — full tool results, not the summaries the browser holds — while
the history before it stays the browser's. Answers: an approved
`approval` runs the tool (with `payload.args` when given), a declined or
cancelled one tells the model the user declined; `choice` / `input` /
`ui-part` / client-tool answers become the result text. Their
`tool_output`s are emitted in a step of their own. A chain of interrupts
works the same way (`turn` grows). Without a checkpoint (none stored,
or an anonymous run's expired) the run falls back to the browser's
history alone: the gated calls are looked up in its assistant messages
and earlier tool results are what the browser kept (summaries).

**Extension points (wave 5a).** The system prompt, the backend tools,
the turn's memory-taint seed, the model and the succeeded result come
from hooks (`HarnessHooks`, `hook_types.py`), registered in order in
`harness_hooks.DEFAULT_HOOKS` — which reproduces the harness as it was.
Each run gets one `HookContext` (emitter, cancel, usage meter, the
user-scoped `ToolContext` when signed in with a database, and the
always-present `RunToolContext` the loop hands to every tool — client
key, per-IP budget, `localFilesOnly`, taint so far). Wave 5b's
workstreams add hooks there; see `harness_hooks.py`.

**Cancel.** `cancel` is checked before every model call and raced
against the provider stream, every tool execution and the suggestions
call: the operation in flight is abandoned (the provider stream closed)
within one event-loop turn, and the run returns `Cancelled`. Emitter
sinks are never interrupted, so no log append is cut in half. A step left
open by a cancel or a provider error is closed (`step_end`) before
returning, so every `STEP_STARTED` has its `STEP_FINISHED`.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import structlog

from ..chat import generate_suggestions
from ..chat_loop import (
    DEFAULT_MAX_TOKENS,
    TRUSTED_TOOLS,
    CancelRequested,
    LoopCancelled,
    LoopFailed,
    LoopInterrupted,
    LoopSucceeded,
    PendingCall,
    ToolRun,
    UsageMeter,
    emit_tool_run,
    execute_tool,
    race_cancel,
    run_turn_loop,
)
from ..emitter import RunEmitter
from ..events import InputRequestOption, SuggestionsEvent
from ..input_policy import request_kind_for
from ..model_allowlist import UnknownModelError
from ..providers.anthropic_provider import AsyncAnthropicClient, _make_tool_result_block
from ..rate_limit import ToolBudgets
from ..reasoning_effort import thinking_params
from ..settings import Settings
from ..tools import BudgetVerdict, RunToolContext, ToolContext, ToolDescriptor, ToolError
from .harness import CancelSignal, HarnessResult, ResumeAnswer, RunInput
from .harness_hooks import DEFAULT_HOOKS, HITL_TOOLS, SKILL_TOOLS
from .history import (
    attach_tool_results,
    find_tool_call,
    last_user_index,
    last_user_text,
    normalize,
    to_anthropic,
)
from .hook_types import (
    HarnessHooks,
    HookContext,
    Toolset,
    build_system_prompt,
    build_toolset,
    seed_taint,
)
from .model import (
    Cancelled,
    Failed,
    Interrupted,
    PendingInterrupt,
    Succeeded,
)
from .options import RunOptions, parse_run_options, validate_run_options

logger = structlog.get_logger(__name__)

__all__ = [
    "CHECKPOINT_VERSION",
    "HARNESS_NAME",
    "HITL_TOOLS",
    "SKILL_TOOLS",
    "BudgetPolicy",
    "NativeHarness",
    "RunOptions",
    "Toolset",
    "ToolsetBuilder",
    "build_native_harness",
    "default_toolset_builder",
    "parse_run_options",
    "validate_run_options",
]

HARNESS_NAME = "loop-v1"
CHECKPOINT_VERSION = 1

_TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

DECLINED_APPROVAL = (
    "User declined to run this action. Consider an alternative or ask the user how to proceed."
)
DECLINED_ANSWER = "The user declined to answer."


# --- Tools ------------------------------------------------------------------------------


ToolsetBuilder = Callable[[RunInput], Awaitable[Toolset]]
"""Replaces the whole tool lookup (tests); the default is the hooks'
tool contributors (`harness_hooks.TOOL_CONTRIBUTORS`)."""
PoolProvider = Callable[[], Any]
BudgetPolicy = Callable[[str | None, str], BudgetVerdict]
"""`(client_key, kind) -> verdict` — takes one unit of the caller's
per-IP budget `kind`; becomes each run's `RunToolContext.consume_budget`
(`rate_limit.ToolBudgets` by default)."""


def _default_pool() -> Any:
    from .. import db

    return db.get_pool() if db.has_pool() else None


def _hook_context(
    run_input: RunInput,
    opts: RunOptions,
    *,
    emitter: RunEmitter,
    cancel: CancelSignal,
    usage: UsageMeter,
    pool_provider: PoolProvider,
    budget: BudgetPolicy | None,
) -> HookContext:
    """The per-run `HookContext`: a user-scoped `ToolContext` for a
    signed-in run with a DB pool, and the run-scoped `RunToolContext`
    every run gets."""
    pool = pool_provider() if run_input.user_id else None
    tool_context = (
        ToolContext(pool=pool, user_id=run_input.user_id, workspace_id=opts.workspace_id)
        if pool is not None and run_input.user_id
        else None
    )
    client_key = run_input.client_key
    run_tools = RunToolContext(
        run_id=run_input.run_id,
        user_id=run_input.user_id,
        client_key=client_key,
        local_files_only=opts.local_files_only,
    )
    if budget is not None:

        def consume(kind: str) -> BudgetVerdict:
            return budget(client_key, kind)

        run_tools = dataclasses.replace(run_tools, consume_budget=consume)
    return HookContext(
        emitter=emitter,
        cancel=cancel,
        usage=usage,
        pool=pool,
        tool_context=tool_context,
        run_tools=run_tools,
    )


async def _discard(_event: object) -> None:
    return None


def default_toolset_builder(pool_provider: PoolProvider = _default_pool) -> ToolsetBuilder:
    """The default hooks' tools as a standalone `ToolsetBuilder`: the
    skills the run asked for (`SKILL_TOOLS`) + `HITL_TOOLS`; for a
    signed-in run with a DB pool also the user-scoped tools
    (`searchFiles`) and, with a `workspaceId`, the workspace's cloud MCP
    tools (`harness_hooks.TOOL_CONTRIBUTORS`)."""

    async def build(run_input: RunInput) -> Toolset:
        opts = parse_run_options(run_input.options)
        ctx = _hook_context(
            run_input,
            opts,
            emitter=RunEmitter(run_id=run_input.run_id, sink=_discard),
            cancel=asyncio.Event(),
            usage=UsageMeter(),
            pool_provider=pool_provider,
            budget=None,
        )
        return await build_toolset(DEFAULT_HOOKS.tool_contributors, run_input, opts, ctx)

    return build


async def _client_tool_execute(_args: dict[str, Any]) -> Any:
    raise ToolError("client-side tool: run by the client, never by the backend")


def _client_tools(
    raw: Sequence[Mapping[str, object]], taken: set[str]
) -> dict[str, ToolDescriptor]:
    """AG-UI `tools` as descriptors the model can call. A name the
    backend already uses, or one Anthropic would reject, is skipped."""
    out: dict[str, ToolDescriptor] = {}
    for tool in raw:
        name = tool.get("name")
        if not isinstance(name, str) or not _TOOL_NAME_RE.fullmatch(name):
            continue
        if name in taken or name in out:
            logger.warning("native_harness.client_tool_skipped", tool=name)
            continue
        params = tool.get("parameters")
        schema = (
            dict(params)
            if isinstance(params, Mapping) and params.get("type") == "object"
            else {"type": "object", "properties": {}}
        )
        description = tool.get("description")
        out[name] = ToolDescriptor(
            name=name,
            description=description if isinstance(description, str) else "",
            input_schema=schema,
            execute=_client_tool_execute,
        )
    return out


# --- Interrupts ----------------------------------------------------------------------------


def _pending_interrupt(call: PendingCall, client_tools: frozenset[str]) -> PendingInterrupt:
    """One `PendingInterrupt` per gated call — the same classification
    and fields the background executor's suspend path emits
    (`executor._emit_pending_input_request`)."""
    args = call.args
    if call.tool_name in client_tools:
        return PendingInterrupt(
            id=call.tool_call_id,
            request_kind="input",
            tool=call.tool_name,
            tool_call_id=call.tool_call_id,
            args=args,
        )
    kind = request_kind_for(call.tool_name, args)
    prompt: str | None = None
    options: tuple[InputRequestOption, ...] | None = None
    multi: bool | None = None
    ui_kind: str | None = None
    ui_props: dict[str, object] | None = None
    if kind in ("choice", "input"):
        raw_prompt = args.get("prompt")
        prompt = raw_prompt if isinstance(raw_prompt, str) else None
        raw_multi = args.get("multi")
        multi = raw_multi if isinstance(raw_multi, bool) else None
        if kind == "choice":
            raw_options = args.get("options")
            built = [
                InputRequestOption(id=o["id"], label=o["label"])
                for o in (raw_options if isinstance(raw_options, list) else [])
                if isinstance(o, dict)
                and isinstance(o.get("id"), str)
                and isinstance(o.get("label"), str)
            ]
            options = tuple(built) or None
    elif kind == "ui-part":
        raw_kind = args.get("kind")
        raw_props = args.get("props")
        ui_kind = raw_kind if isinstance(raw_kind, str) else None
        ui_props = raw_props if isinstance(raw_props, dict) else None
    return PendingInterrupt(
        id=call.tool_call_id,
        request_kind=kind,
        tool=call.tool_name,
        tool_call_id=call.tool_call_id,
        args=args,
        prompt=prompt,
        options=options,
        multi=multi,
        ui_kind=ui_kind,
        ui_props=ui_props,
    )


@dataclass(frozen=True)
class _Checkpoint:
    turn: list[dict[str, Any]]
    pending: tuple[PendingCall, ...]
    results: tuple[dict[str, Any], ...]
    tainted_by: str | None
    client_calls: frozenset[str] = frozenset()
    """Ids of pending calls to client-side tools (answered `{value}`),
    kept so a resume run classifies them even if `tools` is not resent."""

    def to_json(self) -> dict[str, object]:
        raw: dict[str, object] = {
            "harness": HARNESS_NAME,
            "version": CHECKPOINT_VERSION,
            "turn": self.turn,
            "pending": [
                {
                    "toolCallId": p.tool_call_id,
                    "toolName": p.tool_name,
                    "args": p.args,
                    "client": p.tool_call_id in self.client_calls,
                }
                for p in self.pending
            ],
            "results": list(self.results),
            "taintedBy": self.tainted_by,
        }
        # SDK blocks were `model_dump`ed; make sure what is stored is JSON.
        decoded: dict[str, object] = json.loads(json.dumps(raw, default=str))
        return decoded

    @staticmethod
    def parse(raw: object) -> _Checkpoint | None:
        """None unless `raw` is a well-formed checkpoint of this harness
        whose turn ends in the assistant turn holding every pending call."""
        if not isinstance(raw, Mapping) or raw.get("harness") != HARNESS_NAME:
            return None
        if raw.get("version") != CHECKPOINT_VERSION:
            return None
        turn, pending, results = raw.get("turn"), raw.get("pending"), raw.get("results")
        if not isinstance(turn, list) or not turn or not isinstance(pending, list) or not pending:
            return None
        if not all(isinstance(m, dict) and m.get("role") in ("user", "assistant") for m in turn):
            return None
        if turn[0]["role"] != "assistant" or turn[-1]["role"] != "assistant":
            return None
        calls: list[PendingCall] = []
        client_calls: set[str] = set()
        for p in pending:
            if not isinstance(p, Mapping):
                return None
            cid, name, args = p.get("toolCallId"), p.get("toolName"), p.get("args")
            if not isinstance(cid, str) or not isinstance(name, str):
                return None
            calls.append(PendingCall(cid, name, dict(args) if isinstance(args, dict) else {}))
            if p.get("client") is True:
                client_calls.add(cid)
        last = turn[-1].get("content")
        ids = {
            b.get("id")
            for b in (last if isinstance(last, list) else [])
            if isinstance(b, dict) and b.get("type") == "tool_use"
        }
        if any(c.tool_call_id not in ids for c in calls):
            return None
        tainted = raw.get("taintedBy")
        return _Checkpoint(
            turn=[dict(m) for m in turn],
            pending=tuple(calls),
            results=tuple(
                dict(r)
                for r in (results if isinstance(results, list) else [])
                if isinstance(r, dict)
            ),
            tainted_by=tainted if isinstance(tainted, str) else None,
            client_calls=frozenset(client_calls),
        )


# --- The adapter ------------------------------------------------------------------------------


@dataclass
class _Prepared:
    messages: list[dict[str, Any]]
    turn_start: int
    tainted_by: str | None


ClientFactory = Callable[[], AsyncAnthropicClient | None]


class NativeHarness:
    """`HarnessAdapter` over `chat_loop.run_turn_loop` (see the module
    docstring). Build it with `build_native_harness`."""

    name = HARNESS_NAME

    def __init__(
        self,
        *,
        client_factory: ClientFactory,
        build_tools: ToolsetBuilder | None = None,
        hooks: HarnessHooks = DEFAULT_HOOKS,
        pool_provider: PoolProvider = _default_pool,
        consume_budget: BudgetPolicy | None = None,
        suggestions: bool = True,
        max_tokens: int = DEFAULT_MAX_TOKENS,
    ) -> None:
        self._client_factory = client_factory
        self._client: AsyncAnthropicClient | None = None
        self._build_tools = build_tools
        self._hooks = hooks
        self._pool_provider = pool_provider
        self._budget = consume_budget
        self._suggestions = suggestions
        self._max_tokens = max_tokens

    def _resolve_client(self) -> AsyncAnthropicClient | None:
        if self._client is None:
            self._client = self._client_factory()
        return self._client

    async def run(
        self, run_input: RunInput, emitter: RunEmitter, cancel: CancelSignal
    ) -> HarnessResult:
        meter = UsageMeter()
        try:
            return await self._run(run_input, emitter, cancel, meter)
        except Exception as exc:
            # A bug, not an agent-level failure — fail the run rather
            # than let the driver guess.
            logger.exception("native_harness.crashed", run_id=run_input.run_id, error=str(exc))
            return HarnessResult(
                Failed("unknown", "The agent failed unexpectedly.", usage=meter.totals())
            )

    async def _run(
        self, run_input: RunInput, emitter: RunEmitter, cancel: CancelSignal, meter: UsageMeter
    ) -> HarnessResult:
        opts = parse_run_options(run_input.options)
        hooks = self._hooks
        ctx = _hook_context(
            run_input,
            opts,
            emitter=emitter,
            cancel=cancel,
            usage=meter,
            pool_provider=self._pool_provider,
            budget=self._budget,
        )
        try:
            model = await hooks.resolve_model(run_input, opts, ctx)
        except UnknownModelError as exc:
            return HarnessResult(Failed(exc.code, str(exc)))
        client = self._resolve_client()
        if client is None:
            return HarnessResult(
                Failed("unavailable", "ANTHROPIC_API_KEY is not configured on the agent service.")
            )
        if cancel.is_set():
            return HarnessResult(Cancelled())

        toolset = (
            await self._build_tools(run_input)
            if self._build_tools is not None
            else await build_toolset(hooks.tool_contributors, run_input, opts, ctx)
        )
        tools = dict(toolset.tools)
        client_tools = _client_tools(run_input.tools, set(tools))
        tools.update(client_tools)
        client_names = frozenset(client_tools)
        gated = HITL_TOOLS | opts.require_approval_for | toolset.gated | client_names

        def taint_of(messages: Sequence[Mapping[str, object]]) -> str | None:
            return seed_taint(hooks.taint_seeds, run_input, opts, ctx, messages)

        history = run_input.messages
        if run_input.resume:
            prepared = await self._prepare_resume(
                run_input, emitter, cancel, tools, client_names, gated, taint_of, ctx.run_tools
            )
            if isinstance(prepared, HarnessResult):
                return prepared
        else:
            messages = normalize(to_anthropic(history))
            prepared = _Prepared(messages, len(messages), taint_of(history))

        async def on_answer(text: str) -> None:
            await self._suggest(client, history, text, emitter, cancel, meter)

        thinking = thinking_params(model.catalog_id, opts.reasoning_effort)
        if thinking is not None and not _turn_can_think(prepared.messages):
            thinking = None

        system = await build_system_prompt(hooks.prompt_sections, run_input, opts, ctx)
        result = await run_turn_loop(
            client=client,
            emitter=emitter,
            model=model.api_id,
            messages=prepared.messages,
            system=system,
            max_tokens=max(self._max_tokens, thinking.max_tokens) if thinking else self._max_tokens,
            thinking=thinking.thinking if thinking else None,
            tools=list(tools.values()),
            max_steps=opts.max_steps,
            gated=gated,
            cancel=cancel,
            on_answer=on_answer if self._suggestions else None,
            tainted_by=prepared.tainted_by,
            usage=meter,
            run_context=ctx.run_tools,
        )
        if result.step_open:
            await emitter.end_step()
        outcome = result.outcome
        if isinstance(outcome, LoopSucceeded):
            data = await hooks.post_success(run_input, opts, ctx, result)
            return HarnessResult(Succeeded(data, usage=meter.totals()))
        usage = meter.totals()
        if isinstance(outcome, LoopFailed):
            return HarnessResult(Failed(outcome.code, outcome.message, usage=usage))
        if isinstance(outcome, LoopCancelled):
            return HarnessResult(Cancelled(usage=usage))
        assert isinstance(outcome, LoopInterrupted)
        checkpoint = _Checkpoint(
            turn=prepared.messages[prepared.turn_start :],
            pending=outcome.pending,
            results=outcome.results,
            tainted_by=result.tainted_by,
            client_calls=frozenset(
                c.tool_call_id for c in outcome.pending if c.tool_name in client_names
            ),
        )
        return HarnessResult(
            Interrupted(tuple(_pending_interrupt(c, client_names) for c in outcome.pending)),
            checkpoint=checkpoint.to_json(),
        )

    async def _prepare_resume(
        self,
        run_input: RunInput,
        emitter: RunEmitter,
        cancel: CancelSignal,
        tools: Mapping[str, ToolDescriptor],
        client_names: frozenset[str],
        gated: frozenset[str],
        taint_of: Callable[[Sequence[Mapping[str, object]]], str | None],
        run_tools: RunToolContext,
    ) -> _Prepared | HarnessResult:
        history = run_input.messages
        before = history[: last_user_index(history) + 1]
        state = _Checkpoint.parse(run_input.previous_checkpoint)
        # The checkpoint continues the turn after the browser's last user
        # message; if the gated calls already sit before it (the user
        # wrote again since), the browser's history is the turn.
        if state is not None and any(find_tool_call(before, p.tool_call_id) for p in state.pending):
            state = None

        pending: list[PendingCall]
        client_calls: set[str]
        if state is not None:
            pending = list(state.pending)
            client_calls = set(state.client_calls)
            tainted = state.tainted_by or taint_of(before)
        else:
            # No stored state: the calls come from the browser's history,
            # so only one that waits for an answer in this run's own
            # configuration may be answered (an "approval" of a tool that
            # is not gated would run it on the client's say-so alone).
            pending = []
            for answer in run_input.resume:
                found = find_tool_call(history, answer.interrupt_id)
                if found is None or found[0] not in gated:
                    return HarnessResult(
                        Failed(
                            "invalid_state",
                            f"Cannot resume: tool call {answer.interrupt_id} is not an open "
                            "interrupt in the history.",
                        )
                    )
                pending.append(PendingCall(answer.interrupt_id, found[0], found[1]))
            client_calls = {c.tool_call_id for c in pending if c.tool_name in client_names}
            tainted = taint_of(history)

        answers = {a.interrupt_id: a for a in run_input.resume}
        results: list[dict[str, Any]] = []
        await emitter.start_step()
        waiter = _cancel_waiter(cancel)
        try:
            for call in pending:
                try:
                    run, ran = await self._answer(
                        call,
                        answers.get(call.tool_call_id),
                        tools,
                        call.tool_call_id in client_calls,
                        waiter,
                        dataclasses.replace(run_tools, tainted_by=tainted),
                    )
                except CancelRequested:
                    await emitter.end_step()
                    return HarnessResult(Cancelled())
                if ran and tainted is None and call.tool_name not in TRUSTED_TOOLS:
                    tainted = call.tool_name
                await emit_tool_run(
                    emitter, tool_call_id=call.tool_call_id, tool_name=call.tool_name, run=run
                )
                results.append(
                    _make_tool_result_block(call.tool_call_id, run.text, is_error=run.is_error)
                )
        finally:
            waiter.cancel()
        await emitter.end_step()

        if state is not None:
            prefix = normalize(to_anthropic(before))
            turn = [dict(m) for m in state.turn]
            attach_tool_results(turn, [*results, *state.results])
            messages = prefix + normalize(turn, user_first=False)
            return _Prepared(messages, len(prefix), tainted)
        translated = to_anthropic(history)
        attach_tool_results(translated, results)
        messages = normalize(translated)
        return _Prepared(messages, len(normalize(to_anthropic(before))), tainted)

    async def _answer(
        self,
        call: PendingCall,
        answer: ResumeAnswer | None,
        tools: Mapping[str, ToolDescriptor],
        client_call: bool,
        waiter: Any,
        run_context: RunToolContext,
    ) -> tuple[ToolRun, bool]:
        """The tool result for one answered interrupt, and whether a tool
        actually ran to produce it (which may taint the turn)."""
        resolved = answer is not None and answer.status == "resolved"
        payload = answer.payload if answer is not None else None
        p: Mapping[str, object] = payload if resolved and isinstance(payload, Mapping) else {}
        if client_call:
            if not resolved:
                return ToolRun(DECLINED_ANSWER, DECLINED_ANSWER, False), False
            value = p.get("value")
            text = value if isinstance(value, str) else json.dumps(payload, default=str)
            return ToolRun(text, text[:200], False), True
        kind = request_kind_for(call.tool_name, call.args)
        if kind == "approval":
            if not resolved or p.get("approved") is not True:
                return ToolRun(DECLINED_APPROVAL, "Declined by the user", False), False
            descriptor = tools.get(call.tool_name)
            if descriptor is None:
                text = f'(Approved, but the tool "{call.tool_name}" is not available for this run.)'
                return ToolRun(text, text, True), False
            override = p.get("args")
            args = dict(override) if isinstance(override, dict) else call.args
            run = await race_cancel(
                execute_tool(descriptor, call.tool_name, args, run_context), waiter
            )
            return run, True
        if not resolved:
            return ToolRun(DECLINED_ANSWER, DECLINED_ANSWER, False), False
        selection = [s for s in _list(p.get("selection")) if isinstance(s, str)]
        value = p.get("value")
        if kind == "choice":
            text = (
                f"User selected: {', '.join(selection)}"
                if selection
                else "(User submitted no selection.)"
            )
        elif kind == "input":
            text = value if isinstance(value, str) and value else "(User submitted no value.)"
        else:  # ui-part: the client's formatted text, else the raw answer
            ui_answer = p.get("uiAnswer")
            if isinstance(value, str) and value:
                text = value
            elif selection:
                text = ", ".join(selection)
            elif isinstance(ui_answer, dict) and ui_answer:
                text = json.dumps(ui_answer, default=str)
            else:
                text = "(User submitted no answer.)"
        return ToolRun(text, text[:200], False), False

    async def _suggest(
        self,
        client: AsyncAnthropicClient,
        history: Sequence[Mapping[str, object]],
        text: str,
        emitter: RunEmitter,
        cancel: CancelSignal,
        meter: UsageMeter,
    ) -> None:
        """Follow-up chips after the answer (`suggestions` part), as on
        `/v1/chat`. Decoration: failures yield nothing."""
        if cancel.is_set() or not text.strip():
            return
        waiter = _cancel_waiter(cancel)
        try:
            values = await race_cancel(
                generate_suggestions(
                    client=client,
                    user_text=last_user_text(history),
                    assistant_reply=text,
                    usage=meter,
                ),
                waiter,
            )
        except CancelRequested:
            return
        finally:
            waiter.cancel()
        if values:
            await emitter.emit(SuggestionsEvent, values=tuple(values))


_THINKING_BLOCKS = frozenset({"thinking", "redacted_thinking"})


def _turn_can_think(messages: Sequence[Mapping[str, Any]]) -> bool:
    """Whether a call on `messages` may enable extended thinking: with
    thinking on, Anthropic requires every assistant turn that continues
    the current tool-use turn (after the last user turn that is more than
    tool results) to open with a thinking block. A fresh turn always
    can; a resume continues a turn whose assistant turns only carry
    thinking blocks if the interrupted run thought too."""
    for m in reversed(messages):
        content = m.get("content")
        blocks = content if isinstance(content, list) else []
        if m.get("role") == "user":
            if isinstance(content, str) or any(
                isinstance(b, Mapping) and b.get("type") != "tool_result" for b in blocks
            ):
                return True
            continue
        first = blocks[0] if blocks else None
        if not isinstance(first, Mapping) or first.get("type") not in _THINKING_BLOCKS:
            return False
    return True


def _cancel_waiter(cancel: CancelSignal) -> Any:
    import asyncio

    return asyncio.ensure_future(cancel.wait())


def _list(value: object) -> list[object]:
    return value if isinstance(value, list) else []


# --- Factory ----------------------------------------------------------------------------


def _client_from_settings(settings: Settings) -> ClientFactory:
    def make() -> AsyncAnthropicClient | None:
        api_key = settings.ANTHROPIC_API_KEY.strip()
        if not api_key:
            return None
        from anthropic import AsyncAnthropic

        base_url = settings.ANTHROPIC_BASE_URL.strip()
        if base_url:
            return AsyncAnthropic(api_key=api_key, base_url=base_url)  # type: ignore[return-value]
        return AsyncAnthropic(api_key=api_key)  # type: ignore[return-value]

    return make


def build_native_harness(
    settings: Settings,
    *,
    client: AsyncAnthropicClient | None = None,
    pool_provider: PoolProvider | None = None,
    build_tools: ToolsetBuilder | None = None,
    hooks: HarnessHooks | None = None,
    consume_budget: BudgetPolicy | None = None,
    suggestions: bool = True,
) -> NativeHarness:
    """The native adapter for interactive runs.

    `client`: the Anthropic client (tests pass a fake); default — one
    built lazily from `settings.ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`
    on first use (unset key → each run fails `unavailable`).
    `pool_provider`: returns the asyncpg pool for the user-scoped tools,
    or None; default — the lifespan pool (`db.get_pool()`) when open.
    `build_tools`: replaces the hooks' tool contributors (tests).
    `hooks`: the extension points (`harness_hooks.DEFAULT_HOOKS`).
    `consume_budget`: the per-IP tool budgets (`RunToolContext.consume_budget`);
    default — `rate_limit.ToolBudgets` from `settings` (web tools 20/min,
    `generateImage` `MINIMAX_IMAGE_RATE_LIMIT_PER_MINUTE`, per client key).
    `suggestions`: generate follow-up chips after an answer."""
    factory: ClientFactory = (
        (lambda: client) if client is not None else _client_from_settings(settings)
    )
    if consume_budget is None:
        # The Next chat route's `chatWebToolLimit` / `chatImageGenLimit`:
        # one set of windows per harness, i.e. per process (`wiring.py`
        # builds one harness).
        consume_budget = ToolBudgets.from_settings(settings)
    return NativeHarness(
        client_factory=factory,
        build_tools=build_tools,
        hooks=hooks or DEFAULT_HOOKS,
        pool_provider=pool_provider or _default_pool,
        consume_budget=consume_budget,
        suggestions=suggestions,
    )
