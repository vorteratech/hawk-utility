from __future__ import annotations

import os
import sys
from pathlib import Path

# Defaults align with plan §3 / §6.1. On Windows, the engagement root lives
# under C:\HawkWrapper. On Mac/Linux dev boxes we use a folder under the repo.
IS_WINDOWS = sys.platform == "win32"

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _default_engagements_root() -> Path:
    if IS_WINDOWS:
        return Path(r"C:\HawkWrapper\engagements")
    return REPO_ROOT / "dev_engagements"


ENGAGEMENTS_ROOT = Path(os.environ.get("HAWK_ENGAGEMENTS_ROOT", _default_engagements_root()))
DB_PATH = Path(os.environ.get("HAWK_DB_PATH", BACKEND_ROOT / "data" / "hawk_wrapper.db"))
PWSH_EXECUTABLE = os.environ.get("HAWK_PWSH", "pwsh.exe" if IS_WINDOWS else "pwsh")
