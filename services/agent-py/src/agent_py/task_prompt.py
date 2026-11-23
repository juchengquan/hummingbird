"""The research task prompt (Q46) — Next's `buildTaskSystemPrompt`.

A port of `lib/server/agent/task-prompt.ts` for research runs
(`checkpoint.config.mode == "research"`: the old `/api/tasks` route's
`mode: "research"`, or a runs-API background start with
`forwardedProps.research: true`). The executor uses it as the run's
system prompt; every other background run keeps its workspace prompt
alone, as before.

What differs from the TypeScript original, deliberately:

* **No `setPlan`.** agent-py has no plan tool yet, and naming a tool the
  model cannot call invites a failed call. `plan_tool=True` restores the
  original wording byte for byte (pinned by the tests) for when it
  ports.
* **No "Available capabilities" / MCP lines.** agent-py's tools carry
  their own descriptions (the Next skill registry's prompt fragments
  have no Python counterpart), and the MCP tools are named
  `mcp__<serverId>__<tool>` in the tool list itself.
"""

from __future__ import annotations

# The prompt text is Next's byte for byte, en dashes included.
# ruff: noqa: RUF001

__all__ = ["RESEARCH_MODE", "build_research_system_prompt"]

RESEARCH_MODE = "research"
"""`checkpoint.config.mode` of a research run."""

_RESEARCH_LOOP_BASE_HEAD = (
    "You are a research agent inside the Hummingbird app. Your job is to "
    "deliver a structured, cited Markdown report — not a chat reply — on "
    "the user's research goal.\n\n"
    "Workflow (follow it strictly):\n\n"
)

_PLAN_STEP_WITH_TOOL = (
    "1. Plan. Call `setPlan` once with 5–10 concrete sub-questions that, "
    "when answered, will fully address the goal. Each sub-question "
    "becomes one section of the final report. Use stable ids you can "
    "reuse across updates.\n"
    "2. Research each sub-question in plan order:\n"
    "   a. Update `setPlan` to mark the current item `in_progress`.\n"
)
_PLAN_STEP_WITHOUT_TOOL = (
    "1. Plan. Start by writing out 5–10 concrete sub-questions that, "
    "when answered, will fully address the goal. Each sub-question "
    "becomes one section of the final report.\n"
    "2. Research each sub-question in plan order:\n"
    "   a. Say which sub-question you are working on.\n"
)

# Step 2b — files first when the run can search the user's files.
_STEP_2B_FILES_FIRST = (
    "   b. If any attached file looks relevant to this sub-question, "
    "call `searchFiles({ fileId, query })` first — workspace-anchored "
    "answers should be grounded in the user's own sources before the "
    "web. Then use `webSearch` to find broader candidate sources and "
    "(for any sub-question without enough file coverage) fill in from "
    "the web.\n"
)
_STEP_2B_WEB_ONLY = "   b. Use `webSearch` to find candidate sources (start broad, then narrow).\n"

_STEP_2CD = (
    "   c. Use `webFetch` to read the 2–4 most promising results.\n"
    "   d. Write a short factual note (2–6 sentences) for that "
    "sub-question, citing source URLs (or attached-file names) with "
    "`[N]` markers in the order they were discovered.\n"
)
_STEP_2E_WITH_TOOL = (
    "   e. Update `setPlan` to mark the item `completed` and the next one `in_progress`.\n"
)
_STEP_2E_WITHOUT_TOOL = "   e. Move on to the next sub-question.\n"

_STEP_3_FILES = (
    "3. Gap pass. Re-read your notes. Identify sub-questions that are "
    "under-supported (only one source, contradictions, key claim "
    "unanchored). For each, run one targeted `webSearch` + `webFetch` "
    "(or `searchFiles` against a relevant file) to fill the gap. Update "
    "notes in place.\n"
)
_STEP_3_WEB_ONLY = (
    "3. Gap pass. Re-read your notes. Identify sub-questions that are "
    "under-supported (only one source, contradictions, key claim "
    "unanchored). For each, run one targeted `webSearch` + `webFetch` "
    "to fill the gap. Update notes in place.\n"
)


def _step_4(*, files_enabled: bool) -> str:
    return (
        "4. Synthesize. Write the final report as Markdown with:\n"
        "   - A short executive summary (3–5 sentences).\n"
        "   - One `##` section per sub-question, in plan order, headed by "
        "the sub-question.\n"
        "   - Inline `[N]` markers tying every non-trivial claim to a source.\n"
        "   - A `## Sources` section at the end listing each source as "
        + (
            "`[N] Title — URL` (or `[N] file: <name>` for attached files).\n\n"
            if files_enabled
            else "`[N] Title — URL`.\n\n"
        )
    )


_RESEARCH_LOOP_TAIL = (
    "Constraints:\n"
    "- Do not pad. If a sub-question was empty, say so and move on.\n"
    "- Prefer recent (≤ 24 months) sources except for definitional context.\n"
    "- Do not editorialize beyond what your sources support.\n"
    "- Do not ask the user clarifying questions in research mode — raise "
    "an `askUser` only when a sub-question genuinely needs a real-world "
    "choice from the user (a target audience, a specific product to "
    "compare against, etc.).\n"
    "- Stop when the Markdown report is written. The settled report is "
    "the deliverable; no chat reply is needed."
)


def _research_loop(*, files_enabled: bool, plan_tool: bool) -> str:
    return (
        _RESEARCH_LOOP_BASE_HEAD
        + (_PLAN_STEP_WITH_TOOL if plan_tool else _PLAN_STEP_WITHOUT_TOOL)
        + (_STEP_2B_FILES_FIRST if files_enabled else _STEP_2B_WEB_ONLY)
        + _STEP_2CD
        + (_STEP_2E_WITH_TOOL if plan_tool else _STEP_2E_WITHOUT_TOOL)
        + (_STEP_3_FILES if files_enabled else _STEP_3_WEB_ONLY)
        + _step_4(files_enabled=files_enabled)
        + _RESEARCH_LOOP_TAIL
    )


def build_research_system_prompt(
    workspace_system_prompt: str | None,
    *,
    files_enabled: bool,
    plan_tool: bool = False,
) -> str:
    """`buildTaskSystemPrompt({mode: "research", …})`: the trimmed
    workspace prompt, then the research workflow. `files_enabled` — the
    run offers `searchFiles` — switches step 2b to files first."""
    parts = [
        (workspace_system_prompt or "").strip(),
        _research_loop(files_enabled=files_enabled, plan_tool=plan_tool),
    ]
    return "\n\n".join(p for p in parts if p)
