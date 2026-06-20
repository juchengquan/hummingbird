"""Pure formatting of child subagent results into the tool_result text
the orchestrator sees on resume."""

from __future__ import annotations

from agent_py.store import ChildResult


def aggregate_child_results(results: list[ChildResult]) -> str:
    blocks: list[str] = []
    for r in results:
        header = f"### {r.persona_slug}: {r.subgoal}".rstrip()
        if r.status == "done" and r.final_text.strip():
            blocks.append(f"{header}\n{r.final_text.strip()}")
        else:
            reason = r.final_text.strip() or f"no result (status: {r.status})"
            blocks.append(f"{header}\n[failed: {reason}]")
    return "\n\n".join(blocks)
