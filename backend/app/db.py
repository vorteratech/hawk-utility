from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from app.config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS engagements (
    id              INTEGER PRIMARY KEY,
    client_name     TEXT NOT NULL,
    tenant_hint     TEXT,
    start_date      TEXT NOT NULL,
    end_date        TEXT NOT NULL,
    output_folder   TEXT NOT NULL,
    pwsh_pid        INTEGER,
    status          TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    ended_at        TEXT
);

CREATE TABLE IF NOT EXISTS runs (
    id              INTEGER PRIMARY KEY,
    engagement_id   INTEGER NOT NULL REFERENCES engagements(id),
    cmdlet          TEXT NOT NULL,
    params_json     TEXT NOT NULL,
    status          TEXT NOT NULL,
    exit_code       INTEGER,
    log_path        TEXT,
    started_at      TEXT NOT NULL,
    ended_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_engagement ON runs(engagement_id);
CREATE INDEX IF NOT EXISTS idx_engagements_status ON engagements(status);
"""


def init_db(path: Path = DB_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.executescript(SCHEMA)
        conn.commit()


@contextmanager
def get_conn(path: Path = DB_PATH) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
