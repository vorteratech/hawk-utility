from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import sqlite3
import sys
from collections import deque
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator, Optional

from app.config import ENGAGEMENTS_ROOT, PWSH_EXECUTABLE
from app.db import get_conn

# Sentinel pattern from plan §5.2. The wrapper writes try/catch around every
# cmdlet invocation and listens for these tokens to mark run success/failure.
SENTINEL_OK = "__HAWK_WRAPPER_OK__"
SENTINEL_FAIL_PREFIX = "__HAWK_WRAPPER_FAIL__"

# Markers used inside the auth orchestration script to tell us which connect
# step we just finished, so the device-code modal can label the next prompt
# correctly (plan §5.1 step 6: "Expect TWO device-code prompts").
AUTH_MARKER_GRAPH_OK = "__HAWK_AUTH_GRAPH_OK__"
AUTH_MARKER_EXO_OK = "__HAWK_AUTH_EXO_OK__"

# Microsoft.Graph and ExchangeOnlineManagement both print the device-code
# prompt as a single line: "To sign in, use a web browser to open the page
# <URL> and enter the code <CODE> to authenticate." We pull URL + code out
# with one regex.
DEVICE_CODE_RE = re.compile(
    r"open the page (?P<url>https?://\S+) and enter the code (?P<code>\S+)",
    re.IGNORECASE,
)

# Last N lines kept in memory for late WebSocket joiners (plan §5.2 step 6).
RING_BUFFER_SIZE = 1000

# Per-engagement event-bus topics broadcast to /ws/engagements/{id}/state.
# Console output goes through the separate line bus on /ws/.../console.


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class StreamLine:
    """A single line of console output. seq lets late joiners dedupe."""

    seq: int
    stream: str  # 'stdout' | 'stderr' | 'meta'
    text: str
    ts: str
    run_id: Optional[int]


class EngagementProcess:
    """Owns one pwsh.exe subprocess for the lifetime of one engagement.

    Plan §4 invariant: one process per engagement, never reused across
    engagements. PowerShell M365 modules hold connection state at process
    scope, so process isolation is the only reliable cross-tenant boundary.
    """

    def __init__(self, engagement_id: int, output_folder: Path) -> None:
        self.engagement_id = engagement_id
        self.output_folder = output_folder
        self.runs_log_dir = output_folder / "runs"
        self.runs_log_dir.mkdir(parents=True, exist_ok=True)

        self._proc: Optional[asyncio.subprocess.Process] = None
        self._readers: list[asyncio.Task] = []
        self._line_subs: set[asyncio.Queue[StreamLine]] = set()
        self._state_subs: set[asyncio.Queue[dict]] = set()
        self._ring: deque[StreamLine] = deque(maxlen=RING_BUFFER_SIZE)
        self._seq = 0

        self._current_run_id: Optional[int] = None
        self._current_run_log: Optional[Path] = None
        self._current_run_log_fh = None  # type: ignore[assignment]
        # Plain str, not Future, because reads come from many tasks but the
        # consumer (start_run) is single-shot.
        self._sentinel_event: Optional[asyncio.Event] = None
        self._sentinel_outcome: Optional[tuple[str, str]] = None  # (status, detail)

        # Auth state. _auth_target is the connect we're currently driving so
        # device-code prompts can be labeled 'graph' vs 'exo' for the modal.
        self._auth_target: Optional[str] = None
        self._auth_complete: bool = False

        self._lock = asyncio.Lock()
        self._terminated = False

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        # TERM=dumb tells PSReadLine not to emit bracketed-paste / cursor
        # ANSI escape sequences, which keeps stdout parseable for sentinel
        # detection.
        env = {**os.environ, "TERM": "dumb"}
        kwargs: dict = {
            "stdin": asyncio.subprocess.PIPE,
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.PIPE,
            "cwd": str(self.output_folder),
            "env": env,
        }
        if sys.platform == "win32":
            # CREATE_NEW_PROCESS_GROUP so we can later signal the process
            # group without affecting the parent.
            import subprocess

            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]

        # Plain interactive REPL: reads one line at a time from stdin and
        # executes it. `-Command -` would buffer until EOF — wrong for our
        # long-lived session model. Multi-line scripts are sent as base64
        # via Invoke-Expression so they land in a single stdin line.
        self._proc = await asyncio.create_subprocess_exec(
            PWSH_EXECUTABLE,
            "-NoProfile",
            "-NoLogo",
            **kwargs,
        )
        assert self._proc.stdout is not None
        assert self._proc.stderr is not None

        self._readers.append(
            asyncio.create_task(self._pump(self._proc.stdout, "stdout"))
        )
        self._readers.append(
            asyncio.create_task(self._pump(self._proc.stderr, "stderr"))
        )
        await self._emit_state({"type": "engagement_started", "engagement_id": self.engagement_id})
        await self._emit_meta(f"[wrapper] pwsh subprocess started, pid={self._proc.pid}")

        # Persist pid.
        with get_conn() as conn:
            conn.execute(
                "UPDATE engagements SET pwsh_pid = ?, status = 'active' WHERE id = ?",
                (self._proc.pid, self.engagement_id),
            )

    @property
    def pid(self) -> Optional[int]:
        return self._proc.pid if self._proc else None

    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    # ------------------------------------------------------------------
    # pub/sub
    # ------------------------------------------------------------------

    async def subscribe_lines(self) -> AsyncIterator[StreamLine]:
        """Yield buffered history then live lines until the engagement ends."""
        q: asyncio.Queue[StreamLine] = asyncio.Queue()
        # Pre-load with ring buffer snapshot.
        for line in list(self._ring):
            await q.put(line)
        self._line_subs.add(q)
        try:
            while True:
                line = await q.get()
                # Sentinel value to signal closure.
                if line.seq == -1:
                    return
                yield line
        finally:
            self._line_subs.discard(q)

    async def subscribe_state(self) -> AsyncIterator[dict]:
        q: asyncio.Queue[dict] = asyncio.Queue()
        self._state_subs.add(q)
        try:
            while True:
                evt = await q.get()
                if evt.get("type") == "__close__":
                    return
                yield evt
        finally:
            self._state_subs.discard(q)

    async def _emit_line(self, stream: str, text: str) -> None:
        self._seq += 1
        line = StreamLine(
            seq=self._seq,
            stream=stream,
            text=text,
            ts=_now_iso(),
            run_id=self._current_run_id,
        )
        self._ring.append(line)
        if self._current_run_log_fh is not None:
            try:
                self._current_run_log_fh.write(text + "\n")
                self._current_run_log_fh.flush()
            except Exception:
                pass
        for q in list(self._line_subs):
            await q.put(line)

    async def _emit_meta(self, text: str) -> None:
        await self._emit_line("meta", text)

    async def _emit_state(self, evt: dict) -> None:
        evt = {**evt, "ts": _now_iso()}
        for q in list(self._state_subs):
            await q.put(evt)

    # ------------------------------------------------------------------
    # subprocess pumping
    # ------------------------------------------------------------------

    async def _pump(self, reader: asyncio.StreamReader, name: str) -> None:
        while True:
            try:
                raw = await reader.readline()
            except Exception as e:  # noqa: BLE001
                await self._emit_meta(f"[wrapper] {name} read error: {e}")
                return
            if not raw:
                # EOF — subprocess pipe closed.
                return
            try:
                text = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            except Exception:  # noqa: BLE001
                text = repr(raw)
            self._check_sentinel(text)
            await self._check_auth_markers(text)
            await self._check_device_code(text)
            if _is_wrapper_noise(text):
                # Still write to the run log file for forensic completeness;
                # don't fan out to console subscribers.
                if self._current_run_log_fh is not None:
                    with suppress(Exception):
                        self._current_run_log_fh.write(text + "\n")
                        self._current_run_log_fh.flush()
                continue
            await self._emit_line(name, text)

    def _check_sentinel(self, text: str) -> None:
        if self._sentinel_event is None or self._sentinel_event.is_set():
            return
        if text.strip() == SENTINEL_OK:
            self._sentinel_outcome = ("succeeded", "")
            self._sentinel_event.set()
            return
        if text.strip().startswith(SENTINEL_FAIL_PREFIX):
            detail = text.split(":", 1)[1].strip() if ":" in text else ""
            self._sentinel_outcome = ("failed", detail)
            self._sentinel_event.set()
            return

    async def _check_auth_markers(self, text: str) -> None:
        """Track which connect step finished so device-code events can be
        labeled correctly for the modal."""
        s = text.strip()
        if s == "__HAWK_AUTH_MODULES_LOADED__":
            await self._emit_state({"type": "auth_step", "step": "graph_starting"})
        elif s == AUTH_MARKER_GRAPH_OK:
            self._auth_target = "exo"
            await self._emit_state({"type": "auth_step", "step": "graph_done"})
        elif s == AUTH_MARKER_EXO_OK:
            self._auth_target = None
            await self._emit_state({"type": "auth_step", "step": "exo_done"})

    async def _check_device_code(self, text: str) -> None:
        m = DEVICE_CODE_RE.search(text)
        if not m:
            return
        await self._emit_state(
            {
                "type": "device_code",
                "url": m.group("url"),
                "code": m.group("code"),
                "target": self._auth_target,
            }
        )

    # ------------------------------------------------------------------
    # stdin
    # ------------------------------------------------------------------

    async def send_stdin(self, text: str, *, echo: bool = True) -> None:
        if not self._proc or not self._proc.stdin:
            raise RuntimeError("subprocess not running")
        if not text.endswith("\n"):
            text = text + "\n"
        self._proc.stdin.write(text.encode("utf-8"))
        await self._proc.stdin.drain()
        if echo:
            await self._emit_meta(f"> {text.rstrip()}")

    # ------------------------------------------------------------------
    # runs
    # ------------------------------------------------------------------

    async def register_run(
        self,
        cmdlet: str,
        params: dict,
        invocation_script: str,
        clean_invocation: str,
    ) -> int:
        """Insert a runs row, mark current, send the script. Returns run_id.

        Does NOT wait for the sentinel — call `await_run` next (typically as
        a background task) to wait for completion.
        """
        async with self._lock:
            if not self.is_alive():
                raise RuntimeError("subprocess not alive")
            if self._sentinel_event is not None and not self._sentinel_event.is_set():
                raise RuntimeError("another run is in progress")

            log_path = self.runs_log_dir / self._next_run_log_name(cmdlet)
            with get_conn() as conn:
                cur = conn.execute(
                    "INSERT INTO runs (engagement_id, cmdlet, params_json, status, log_path, started_at) "
                    "VALUES (?, ?, ?, 'running', ?, ?)",
                    (
                        self.engagement_id,
                        cmdlet,
                        json.dumps(params),
                        str(log_path),
                        _now_iso(),
                    ),
                )
                run_id = cur.lastrowid
            assert run_id is not None

            self._current_run_id = run_id
            self._current_run_log = log_path
            self._current_run_log_fh = open(log_path, "a", encoding="utf-8")
            self._sentinel_event = asyncio.Event()
            self._sentinel_outcome = None

            await self._emit_state(
                {"type": "run_started", "run_id": run_id, "cmdlet": cmdlet, "clean_invocation": clean_invocation}
            )
            await self._emit_meta(f"[wrapper] $ {clean_invocation}")
            # Don't echo the base64-wrapped invocation — the clean_invocation
            # line above is what the investigator wants to see.
            await self.send_stdin(invocation_script, echo=False)
            return run_id

    async def connect(
        self,
        graph_scopes: Optional[list[str]] = None,
    ) -> tuple[str, str]:
        """Run the Graph + EXO connect sequence inside this engagement.

        Plan §5.1: Graph FIRST (avoids the MSAL/WAM conflict), then EXO.
        v1.1 switched from device-code to interactive browser auth: EXO 3.x
        renamed the device-code parameter (-DeviceAuthentication is gone),
        and the device-code UX adds a step the team didn't want anyway.
        Interactive auth opens the system default browser on the VM; the
        investigator signs in normally (username, password, 2FA).
        """
        if self._auth_complete:
            return ("succeeded", "already authenticated")
        if graph_scopes is None:
            # Conservative starting set per plan §11. Real-world tenant tests
            # may surface that we need more (User.Read.All, etc.) -- expand
            # here when that lands.
            graph_scopes = ["AuditLog.Read.All", "Directory.Read.All"]

        scopes_pwsh = ",".join(f"'{s}'" for s in graph_scopes)
        self._auth_target = "graph"
        await self._emit_state({"type": "auth_step", "step": "importing_modules"})

        # *>&1 routes Information/Warning/Verbose streams into Success so all
        # Connect output (including any prompts from older module versions)
        # reaches our subprocess pipe.
        invocation = (
            "Import-Module Microsoft.Graph -ErrorAction Stop *>&1; "
            "Import-Module ExchangeOnlineManagement -ErrorAction Stop *>&1; "
            "Import-Module HAWK -ErrorAction Stop *>&1; "
            "Write-Output '__HAWK_AUTH_MODULES_LOADED__'; "
            f"Connect-MgGraph -NoWelcome -Scopes {scopes_pwsh} *>&1; "
            f"Write-Output '{AUTH_MARKER_GRAPH_OK}'; "
            "Connect-ExchangeOnline -ShowBanner:$false *>&1; "
            f"Write-Output '{AUTH_MARKER_EXO_OK}'"
        )
        clean = "Connect-MgGraph ; Connect-ExchangeOnline (interactive browser sign-in)"
        script = make_run_script(invocation)

        run_id = await self.register_run(
            cmdlet="Connect",
            params={"graph_scopes": graph_scopes},
            invocation_script=script,
            clean_invocation=clean,
        )
        status, detail = await self.await_run(run_id)
        self._auth_target = None
        if status == "succeeded":
            self._auth_complete = True
            await self._emit_state({"type": "auth_complete"})
        return status, detail

    async def await_run(self, run_id: int) -> tuple[str, str]:
        """Block until the in-flight run hits its sentinel; finalize and emit."""
        if self._sentinel_event is None or self._current_run_id != run_id:
            raise RuntimeError(f"run {run_id} is not the active run")

        await self._sentinel_event.wait()
        status, detail = self._sentinel_outcome or ("failed", "no sentinel emitted")

        async with self._lock:
            with get_conn() as conn:
                conn.execute(
                    "UPDATE runs SET status = ?, ended_at = ?, exit_code = ? WHERE id = ?",
                    (status, _now_iso(), 0 if status == "succeeded" else 1, run_id),
                )
            if self._current_run_log_fh is not None:
                with suppress(Exception):
                    self._current_run_log_fh.close()
            self._current_run_log_fh = None
            self._current_run_id = None
            self._current_run_log = None
            self._sentinel_event = None

        await self._emit_state(
            {"type": "run_finished", "run_id": run_id, "status": status, "detail": detail}
        )
        return status, detail

    def _next_run_log_name(self, cmdlet: str) -> str:
        # runs/run_001_Get-Date.log style per plan §6.1.
        existing = list(self.runs_log_dir.glob("run_*.log"))
        n = len(existing) + 1
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in cmdlet)
        return f"run_{n:03d}_{safe}.log"

    # ------------------------------------------------------------------
    # termination
    # ------------------------------------------------------------------

    async def terminate(self, graceful_timeout: float = 30.0, hard_timeout: float = 10.0) -> None:
        if self._terminated:
            return
        self._terminated = True

        await self._emit_meta("[wrapper] ending engagement")
        # Best-effort graceful shutdown — these may fail on a freshly spawned
        # subprocess that never connected to anything; that's fine.
        if self._proc and self._proc.stdin and not self._proc.stdin.is_closing():
            with suppress(Exception):
                self._proc.stdin.write(
                    b"try { Disconnect-ExchangeOnline -Confirm:$false } catch {}\n"
                    b"try { Disconnect-MgGraph } catch {}\n"
                    b"exit\n"
                )
                await self._proc.stdin.drain()
                self._proc.stdin.close()

        try:
            await asyncio.wait_for(self._proc.wait(), timeout=graceful_timeout) if self._proc else None
        except asyncio.TimeoutError:
            await self._emit_meta(f"[wrapper] graceful exit timed out after {graceful_timeout}s, terminating")
            with suppress(ProcessLookupError):
                self._proc.terminate()  # type: ignore[union-attr]
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=hard_timeout)  # type: ignore[union-attr]
            except asyncio.TimeoutError:
                await self._emit_meta(f"[wrapper] terminate timed out, killing")
                with suppress(ProcessLookupError):
                    self._proc.kill()  # type: ignore[union-attr]

        for t in self._readers:
            t.cancel()
        for t in self._readers:
            with suppress(asyncio.CancelledError, Exception):
                await t

        # Close out any in-flight run.
        if self._current_run_id is not None:
            with get_conn() as conn:
                conn.execute(
                    "UPDATE runs SET status = 'interrupted', ended_at = ? WHERE id = ?",
                    (_now_iso(), self._current_run_id),
                )

        with get_conn() as conn:
            conn.execute(
                "UPDATE engagements SET status = 'ended', ended_at = ?, pwsh_pid = NULL WHERE id = ?",
                (_now_iso(), self.engagement_id),
            )

        await self._emit_state({"type": "engagement_ended", "engagement_id": self.engagement_id})

        # Push close sentinels so subscribers wake and exit their loops.
        for q in list(self._line_subs):
            await q.put(StreamLine(seq=-1, stream="meta", text="", ts=_now_iso(), run_id=None))
        for q in list(self._state_subs):
            await q.put({"type": "__close__"})


# Module-level singleton enforcing v1's "one engagement at a time" rule (plan §4).
_current: Optional[EngagementProcess] = None
_current_lock = asyncio.Lock()


def current() -> Optional[EngagementProcess]:
    return _current


async def set_current(eng: EngagementProcess) -> None:
    global _current
    async with _current_lock:
        if _current is not None and _current.is_alive():
            raise RuntimeError("an engagement is already active")
        _current = eng


async def clear_current(eng: EngagementProcess) -> None:
    global _current
    async with _current_lock:
        if _current is eng:
            _current = None


# ----------------------------------------------------------------------
# helpers used by API handlers
# ----------------------------------------------------------------------


def _is_wrapper_noise(text: str) -> bool:
    """Lines we don't want investigators to see: the base64 Invoke-Expression
    echo, pwsh REPL prompts, and the wrapper's internal sentinel/auth
    markers."""
    s = text.lstrip()
    if "Invoke-Expression" in s and "FromBase64String" in s:
        return True
    if s.startswith("PS ") and s.rstrip().endswith(">"):
        return True
    s_strip = s.rstrip()
    if s_strip == SENTINEL_OK or s_strip.startswith(SENTINEL_FAIL_PREFIX):
        return True
    if s_strip in (AUTH_MARKER_GRAPH_OK, AUTH_MARKER_EXO_OK, "__HAWK_AUTH_MODULES_LOADED__"):
        return True
    return False


def make_run_script(invocation: str) -> str:
    """Wrap a PowerShell invocation in the sentinel try/catch (plan §5.2),
    returning a single-line stdin-safe statement.

    The body may be arbitrary multi-line PowerShell. We base64-encode it and
    use Invoke-Expression so the whole payload lands in one stdin readline,
    sidestepping the REPL's per-line evaluation.
    """
    body = (
        "try {\n"
        f"    {invocation}\n"
        f"    Write-Output '{SENTINEL_OK}'\n"
        "} catch {\n"
        f"    Write-Output \"{SENTINEL_FAIL_PREFIX}: $($_.Exception.Message)\"\n"
        "}"
    )
    encoded = base64.b64encode(body.encode("utf-16-le")).decode("ascii")
    return (
        "Invoke-Expression "
        "([System.Text.Encoding]::Unicode.GetString("
        f"[Convert]::FromBase64String('{encoded}')))"
    )


def build_engagement_folder(client_name: str, root: Path = ENGAGEMENTS_ROOT) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in client_name).strip("_")
    if not safe:
        safe = "engagement"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    folder = root / f"{safe}_{stamp}"
    folder.mkdir(parents=True, exist_ok=False)
    return folder


# Keep shlex import used (Windows-friendly quoting comes later for HAWK
# arguments built from user input).
__all__ = [
    "EngagementProcess",
    "current",
    "set_current",
    "clear_current",
    "make_run_script",
    "build_engagement_folder",
    "shlex",
]
