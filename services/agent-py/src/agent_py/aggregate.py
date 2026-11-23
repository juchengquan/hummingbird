"""Pure formatting of child subagent results into the tool_result text
the orchestrator sees on resume."""

from __future__ import annotations

from agent_py.store import ChildResult

SKIPPED = {
    "cancelled": "cancelled before it finished; don't wait for its result",
    "deleted": "deleted before its result was read",
}


def aggregate_child_results(results: list[ChildResult]) -> str:
    if not results:
        return "No subagent ran."
    blocks: list[str] = []
    for r in results:
        header = f"### {r.persona_slug}: {r.subgoal}".rstrip()
        if r.status == "done" and r.final_text.strip():
            blocks.append(f"{header}\n{r.final_text.strip()}")
        elif r.status in SKIPPED:
            blocks.append(f"{header}\n[skipped: {SKIPPED[r.status]}]")
        else:
            reason = r.final_text.strip() or f"no result (status: {r.status})"
            blocks.append(f"{header}\n[failed: {reason}]")
    return "\n\n".join(blocks)
