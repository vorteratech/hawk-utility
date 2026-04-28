from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

from app.config import DB_PATH, ENGAGEMENTS_ROOT, PWSH_EXECUTABLE
from app.db import init_db

Status = Literal["ok", "fail", "warn", "unknown"]

# Minimum versions per plan §3 / §9.
MIN_PWSH = (7, 0, 3)
MIN_HAWK = (4, 0, 0)
MIN_EXO = (2, 0, 4)
MIN_GRAPH = (1, 0, 0)


@dataclass
class CheckResult:
    id: str
    label: str
    status: Status
    detail: str = ""
    fix: str = ""


def _parse_version(s: str) -> tuple[int, ...] | None:
    parts = s.strip().split(".")
    out: list[int] = []
    for p in parts:
        digits = "".join(c for c in p if c.isdigit())
        if not digits:
            break
        out.append(int(digits))
    return tuple(out) if out else None


def _cmp_version(actual: tuple[int, ...], minimum: tuple[int, ...]) -> bool:
    # Pad to equal length so (4, 0) compares >= (4, 0, 0). PowerShell modules
    # often report two-segment versions ("4.0") while we declare a three-
    # segment minimum.
    n = max(len(actual), len(minimum))
    a = actual + (0,) * (n - len(actual))
    m = minimum + (0,) * (n - len(minimum))
    return a >= m


def _run_pwsh(command: str, timeout: float = 10.0) -> tuple[int, str, str]:
    """Run a PowerShell one-liner. Returns (returncode, stdout, stderr).

    Returns (-1, '', '<reason>') if pwsh is not on PATH or the call timed out.
    """
    if shutil.which(PWSH_EXECUTABLE) is None:
        return -1, "", f"{PWSH_EXECUTABLE} not found on PATH"
    try:
        proc = subprocess.run(
            [PWSH_EXECUTABLE, "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return -1, "", f"timed out after {timeout}s"
    except Exception as e:  # noqa: BLE001
        return -1, "", f"{type(e).__name__}: {e}"


def check_pwsh() -> CheckResult:
    fix = "Install PowerShell 7.0.3+ from https://aka.ms/powershell"
    rc, out, err = _run_pwsh("$PSVersionTable.PSVersion.ToString()")
    if rc != 0:
        return CheckResult(
            "pwsh",
            "PowerShell 7.0.3+",
            "fail",
            err.strip() or "pwsh not available",
            fix,
        )
    v = _parse_version(out)
    if v is None:
        return CheckResult("pwsh", "PowerShell 7.0.3+", "fail", f"could not parse version: {out!r}", fix)
    actual = ".".join(str(x) for x in v)
    if not _cmp_version(v, MIN_PWSH):
        return CheckResult(
            "pwsh",
            "PowerShell 7.0.3+",
            "fail",
            f"found {actual}, need >= 7.0.3",
            fix,
        )
    return CheckResult("pwsh", "PowerShell 7.0.3+", "ok", f"v{actual}")


def _check_module(
    check_id: str,
    module_name: str,
    label: str,
    min_version: tuple[int, ...],
    install_cmd: str,
) -> CheckResult:
    cmd = (
        f"$m = Get-Module -ListAvailable {module_name} "
        "| Sort-Object Version -Descending | Select-Object -First 1; "
        "if ($m) { $m.Version.ToString() }"
    )
    rc, out, err = _run_pwsh(cmd, timeout=20.0)
    if rc != 0:
        if "not found on PATH" in err:
            return CheckResult(check_id, label, "unknown", "pwsh not available", install_cmd)
        return CheckResult(check_id, label, "fail", err.strip() or "lookup failed", install_cmd)
    out_clean = out.strip()
    if not out_clean:
        return CheckResult(check_id, label, "fail", "module not installed", install_cmd)
    v = _parse_version(out_clean)
    if v is None:
        return CheckResult(check_id, label, "fail", f"could not parse version: {out_clean!r}", install_cmd)
    actual = ".".join(str(x) for x in v)
    if not _cmp_version(v, min_version):
        need = ".".join(str(x) for x in min_version)
        return CheckResult(check_id, label, "fail", f"found {actual}, need >= {need}", install_cmd)
    return CheckResult(check_id, label, "ok", f"v{actual}")


def check_hawk() -> CheckResult:
    return _check_module(
        "hawk",
        "HAWK",
        "HAWK module 4.0+",
        MIN_HAWK,
        "Install-Module -Name HAWK -Force -SkipPublisherCheck -Scope CurrentUser -AllowClobber",
    )


def check_exo() -> CheckResult:
    return _check_module(
        "exo",
        "ExchangeOnlineManagement",
        "ExchangeOnlineManagement 2.0.4+",
        MIN_EXO,
        "Install-Module -Name ExchangeOnlineManagement -Force -SkipPublisherCheck -Scope CurrentUser -AllowClobber",
    )


def check_graph() -> CheckResult:
    # Microsoft.Graph is a meta-module; presence of any version is sufficient.
    # We pin to 2.25.0 -- 2.36.1 has a broken Authentication.Core that crashes
    # Import-Module HAWK with TypeLoadException.
    return _check_module(
        "graph",
        "Microsoft.Graph",
        "Microsoft.Graph",
        MIN_GRAPH,
        "Install-Module -Name Microsoft.Graph -RequiredVersion 2.25.0 -Force -SkipPublisherCheck -Scope CurrentUser -AllowClobber",
    )


def check_output_root() -> CheckResult:
    label = "Output folder writable"
    fix = f"Create the directory and grant write permission: {ENGAGEMENTS_ROOT}"
    try:
        ENGAGEMENTS_ROOT.mkdir(parents=True, exist_ok=True)
    except Exception as e:  # noqa: BLE001
        return CheckResult("output_root", label, "fail", f"mkdir failed: {e}", fix)
    if not os.access(ENGAGEMENTS_ROOT, os.W_OK):
        return CheckResult("output_root", label, "fail", f"{ENGAGEMENTS_ROOT} not writable", fix)
    return CheckResult("output_root", label, "ok", str(ENGAGEMENTS_ROOT))


def check_db() -> CheckResult:
    label = "SQLite database"
    fix = f"Ensure path is writable: {DB_PATH}"
    try:
        init_db(DB_PATH)
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("SELECT 1 FROM engagements LIMIT 1")
            conn.execute("SELECT 1 FROM runs LIMIT 1")
    except Exception as e:  # noqa: BLE001
        return CheckResult("db", label, "fail", f"{type(e).__name__}: {e}", fix)
    return CheckResult("db", label, "ok", str(DB_PATH))


REQUIRED_IDS = {"pwsh", "hawk", "exo", "graph", "output_root", "db"}


def run_all() -> dict:
    checks = [
        check_pwsh(),
        check_hawk(),
        check_exo(),
        check_graph(),
        check_output_root(),
        check_db(),
    ]
    ready = all(c.status == "ok" for c in checks if c.id in REQUIRED_IDS)
    return {
        "checks": [asdict(c) for c in checks],
        "ready": ready,
    }
