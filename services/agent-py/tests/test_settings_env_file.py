"""Which `.env` agent-py reads (wave 14, Q154, Q155).

The file is `services/agent-py/.env`, found from the package rather than the
start directory; `AGENT_PY_ENV_FILE` names another and an empty value reads
none. A repo-root `.env` / `.env.local` left from before the split stops the
service at boot instead of being silently ignored.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_py import settings as settings_module
from agent_py.main import create_app


def test_service_dir_is_this_service() -> None:
    assert (settings_module.SERVICE_DIR / "pyproject.toml").is_file()
    assert settings_module.SERVICE_DIR.parts[-2:] == ("services", "agent-py")


def test_default_env_file_is_the_services_own(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("AGENT_PY_ENV_FILE", raising=False)
    monkeypatch.chdir(tmp_path)  # the start directory doesn't matter
    assert settings_module.env_file_path() == settings_module.SERVICE_DIR / ".env"


def test_override_names_another_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AGENT_PY_ENV_FILE", str(tmp_path / "other.env"))
    assert settings_module.env_file_path() == tmp_path / "other.env"


def test_empty_override_reads_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_PY_ENV_FILE", "")
    assert settings_module.env_file_path() is None


def test_the_suite_reads_no_env_file() -> None:
    """conftest sets AGENT_PY_ENV_FILE="" before agent_py is imported, so a
    developer's services/agent-py/.env never reaches a test."""
    assert settings_module.Settings.model_config.get("env_file") is None


def test_settings_load_the_named_file(tmp_path: Path) -> None:
    env = tmp_path / "agent.env"
    env.write_text("SUPABASE_URL=http://from-file.test\n")
    assert settings_module.Settings(_env_file=env).SUPABASE_URL == "http://from-file.test"  # type: ignore[call-arg]


def _checkout(tmp_path: Path) -> Path:
    service = tmp_path / "services" / "agent-py"
    service.mkdir(parents=True)
    return service


@pytest.mark.parametrize("name", [".env", ".env.local"])
def test_root_env_is_stale(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, name: str) -> None:
    monkeypatch.setattr(settings_module, "SERVICE_DIR", _checkout(tmp_path))
    monkeypatch.delenv("AGENT_PY_ENV_FILE", raising=False)
    (tmp_path / name).write_text("ANTHROPIC_API_KEY=x\n")
    assert settings_module.stale_root_env() == tmp_path / name


def test_no_root_env_is_fine(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(settings_module, "SERVICE_DIR", _checkout(tmp_path))
    monkeypatch.delenv("AGENT_PY_ENV_FILE", raising=False)
    (tmp_path / ".env.example").write_text("")  # an example is not a settings file
    assert settings_module.stale_root_env() is None


def test_root_env_ignored_when_no_env_file_is_read(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(settings_module, "SERVICE_DIR", _checkout(tmp_path))
    monkeypatch.setenv("AGENT_PY_ENV_FILE", "")
    (tmp_path / ".env").write_text("")
    assert settings_module.stale_root_env() is None


def test_outside_a_checkout_there_is_no_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app_dir = tmp_path / "app"  # the image: /app
    app_dir.mkdir()
    monkeypatch.setattr(settings_module, "SERVICE_DIR", app_dir)
    monkeypatch.delenv("AGENT_PY_ENV_FILE", raising=False)
    (tmp_path / ".env").write_text("")
    assert settings_module.stale_root_env() is None


def test_boot_refuses_a_root_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(settings_module, "SERVICE_DIR", _checkout(tmp_path))
    monkeypatch.delenv("AGENT_PY_ENV_FILE", raising=False)
    (tmp_path / ".env").write_text("")
    with pytest.raises(RuntimeError, match=r"bun run env:split"):
        create_app(enable_poller=False)
