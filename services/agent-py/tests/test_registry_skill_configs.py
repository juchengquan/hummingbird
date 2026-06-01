"""Tests for `SkillConfigs` plumbing into `default_tool_registry`.

Phase 4-3 follow-up — the chat route used to pass `context=None`
and ignore per-request skill config. Now it builds a `ToolContext`
from the JWT sub + workspace_id and threads per-skill overrides
into the registry.
"""

from __future__ import annotations

import os
from unittest.mock import patch

from agent_py.tools import SkillConfigs, default_tool_registry
from agent_py.tools.registry import _clamp_max_calls


class TestClampMaxCalls:
    def test_none_returns_default(self) -> None:
        assert _clamp_max_calls(None, default=2, lo=1, hi=50) == 2

    def test_in_range_passthrough(self) -> None:
        assert _clamp_max_calls(5, default=2, lo=1, hi=50) == 5

    def test_below_lo_clamps_up(self) -> None:
        assert _clamp_max_calls(0, default=2, lo=1, hi=50) == 1

    def test_above_hi_clamps_down(self) -> None:
        assert _clamp_max_calls(999, default=2, lo=1, hi=50) == 50

    def test_unparseable_returns_default(self) -> None:
        assert _clamp_max_calls("not a number", default=7, lo=1, hi=50) == 7
        assert _clamp_max_calls({}, default=7, lo=1, hi=50) == 7
        assert _clamp_max_calls([1, 2], default=7, lo=1, hi=50) == 7

    def test_stringified_number_parses(self) -> None:
        # Pydantic typically gives us a real int; but a client could send
        # `"3"` and the helper is permissive enough to accept it.
        assert _clamp_max_calls("3", default=2, lo=1, hi=50) == 3

    def test_float_truncates_via_int(self) -> None:
        # Floats coerce via `int()` → truncates toward zero. Edge case;
        # this is what the TS side does too.
        assert _clamp_max_calls(3.9, default=2, lo=1, hi=50) == 3


class TestDefaultToolRegistry:
    def test_no_skill_configs_uses_image_gen_default_cap(self) -> None:
        """Backward-compatible call (no skill_configs) gets the
        built-in `DEFAULT_MAX_CALLS_PER_TURN`."""
        with patch.dict(os.environ, {"MINIMAX_CN_API_KEY": "k"}):
            registry = default_tool_registry(context=None)
        # `generateImage` registers when the env key is set; we don't
        # need to inspect its internal cap here — the smoke test is
        # that the entry exists alongside `webFetch`.
        assert "generateImage" in registry
        assert "webFetch" in registry

    def test_image_gen_config_max_calls_threads_through(self) -> None:
        """`SkillConfigs.image_gen.maxCalls` makes its way to
        `build_image_gen_tool`'s `max_calls_per_turn` parameter."""
        captured: dict[str, object] = {}

        from agent_py.tools import image_gen as image_gen_mod

        real_build = image_gen_mod.build_image_gen_tool

        def spy(**kwargs: object) -> object:
            captured.update(kwargs)
            return real_build(**kwargs)  # type: ignore[arg-type]

        with (
            patch.dict(os.environ, {"MINIMAX_CN_API_KEY": "k"}),
            patch.object(image_gen_mod, "build_image_gen_tool", side_effect=spy),
        ):
            default_tool_registry(
                context=None,
                skill_configs=SkillConfigs(image_gen={"maxCalls": 5}),
            )
        assert captured["max_calls_per_turn"] == 5

    def test_image_gen_max_calls_clamps_out_of_range(self) -> None:
        captured: dict[str, object] = {}
        from agent_py.tools import image_gen as image_gen_mod

        real_build = image_gen_mod.build_image_gen_tool

        def spy(**kwargs: object) -> object:
            captured.update(kwargs)
            return real_build(**kwargs)  # type: ignore[arg-type]

        with (
            patch.dict(os.environ, {"MINIMAX_CN_API_KEY": "k"}),
            patch.object(image_gen_mod, "build_image_gen_tool", side_effect=spy),
        ):
            # Above max → clamps to 50.
            default_tool_registry(
                context=None,
                skill_configs=SkillConfigs(image_gen={"maxCalls": 9999}),
            )
        assert captured["max_calls_per_turn"] == 50

    def test_skill_configs_dataclass_defaults_are_none(self) -> None:
        s = SkillConfigs()
        assert s.web_search is None
        assert s.web_fetch is None
        assert s.image_gen is None
