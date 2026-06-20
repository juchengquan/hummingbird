from __future__ import annotations

from agent_py.aggregate import aggregate_child_results
from agent_py.store import ChildResult


def test_success_and_failure_blocks_in_order() -> None:
    results = [
        ChildResult(
            persona_slug="researcher", subgoal="find sources", status="done", final_text="Found 3."
        ),
        ChildResult(persona_slug="critic", subgoal="critique", status="failed", final_text=""),
    ]
    text = aggregate_child_results(results)
    assert "### researcher: find sources" in text
    assert "Found 3." in text
    assert "### critic: critique" in text
    assert "[failed" in text
    assert text.index("researcher") < text.index("critic")


def test_done_but_empty_text_is_treated_as_failure_block() -> None:
    results = [ChildResult(persona_slug="x", subgoal="g", status="done", final_text="   ")]
    text = aggregate_child_results(results)
    assert "[failed" in text


def test_empty_list_returns_empty_string() -> None:
    assert aggregate_child_results([]) == ""
