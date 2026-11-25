"""The startup check (Q92): a sandbox where this host can run one, else
None and `runCode` is simply absent — like Next without
`CODE_SANDBOX_ENABLED`, and never a mock.

It passes when the code interpreter is on (`config.is_enabled`), the
`sandbox` extra is installed, and either the remote backend is configured
(`MSB_BACKEND=remote` with `MSB_API_KEY`, read by the SDK) or this host can
boot a local microVM: read / write `/dev/kvm` (Linux), or macOS on arm64
(Hypervisor.framework). A failed check is logged once."""

from __future__ import annotations

import importlib.util
import os
import platform
from collections.abc import Callable, Mapping
from dataclasses import dataclass

import structlog

from ..settings import Settings, get_settings
from .config import is_enabled, limits
from .microsandbox_sandbox import MicrosandboxSandbox
from .types import CodeSandbox

logger = structlog.get_logger(__name__)


@dataclass(frozen=True)
class Host:
    """What the check reads about the host (a seam for tests)."""

    system: str
    machine: str
    env: Mapping[str, str]
    kvm_usable: Callable[[], bool]
    sdk_installed: Callable[[], bool]


def _kvm_usable() -> bool:
    return os.access("/dev/kvm", os.R_OK | os.W_OK)


def _sdk_installed() -> bool:
    return importlib.util.find_spec("microsandbox") is not None


def this_host() -> Host:
    return Host(
        system=platform.system(),
        machine=platform.machine(),
        env=os.environ,
        kvm_usable=_kvm_usable,
        sdk_installed=_sdk_installed,
    )


def why_unavailable(settings: Settings | None = None, host: Host | None = None) -> str | None:
    """None when a sandbox can run here, else the reason (for the log)."""
    s = settings or get_settings()
    h = host or this_host()
    if not is_enabled(s):
        return "disabled (CODE_SANDBOX_ENABLED unset)"
    if not h.sdk_installed():
        return "the microsandbox SDK is not installed (the `sandbox` extra)"
    if h.env.get("MSB_BACKEND", "").strip().lower() == "remote":
        return (
            None
            if h.env.get("MSB_API_KEY", "").strip()
            else "MSB_BACKEND=remote without MSB_API_KEY"
        )
    if h.system == "Darwin" and h.machine in {"arm64", "aarch64"}:
        return None
    if h.system == "Linux" and h.kvm_usable():
        return None
    return f"this host can't boot a microVM ({h.system}/{h.machine}, no usable /dev/kvm)"


_logged = False


def sandbox(settings: Settings | None = None, host: Host | None = None) -> CodeSandbox | None:
    """A sandbox, or None (then `runCode` isn't registered)."""
    global _logged
    s = settings or get_settings()
    reason = why_unavailable(s, host)
    if reason is not None:
        if is_enabled(s) and not _logged:
            logger.warning("code_sandbox.unavailable", reason=reason)
            _logged = True
        return None
    return MicrosandboxSandbox(limits(s))
