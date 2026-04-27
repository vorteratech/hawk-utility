from __future__ import annotations

from fastapi import APIRouter

from app.config import (
    DB_PATH,
    ENGAGEMENTS_ROOT,
    IS_WINDOWS,
    PWSH_EXECUTABLE,
)
from app.preflight import run_all

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/ping")
def ping() -> dict:
    return {"ok": True}


@router.get("/info")
def info() -> dict:
    return {
        "platform_is_windows": IS_WINDOWS,
        "pwsh_executable": PWSH_EXECUTABLE,
        "engagements_root": str(ENGAGEMENTS_ROOT),
        "db_path": str(DB_PATH),
    }


@router.get("/status")
def status() -> dict:
    return run_all()
