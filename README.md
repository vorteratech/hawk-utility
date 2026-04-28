# HAWK Investigation Utility

A web wrapper around the [HAWK](https://github.com/T0pCyber/Hawk) PowerShell module
([hawkforensics.io](https://hawkforensics.io)) for Microsoft 365 forensics. The
wrapper does not reimplement HAWK — it shells out to the real cmdlets and provides
a GUI on top so investigators can run a tenant or per-user investigation, watch
the cmdlets stream live, browse the output CSVs in-app, and hand off the zipped
engagement folder to the analyst at the end.

It addresses three pain points the team had with bare HAWK:

1. **Auth surface.** Native HAWK assumes the host machine is joined to the target
   tenant's Entra. Our investigators run from a shared VM that isn't. The wrapper
   handles the `Connect-MgGraph` + `Connect-ExchangeOnline` dance up front and
   surfaces auth prompts in the GUI rather than burying them in a console window.
2. **Output review.** A tenant investigation produces ~30 CSVs (and a per-user
   run adds another folder per UPN). Opening them in Excel one by one is friction.
   The Files tab gives a tree view with `_Investigate_*` files visually badged
   (those are HAWK's flagged suspicious findings) and an inline CSV grid.
3. **Packaging.** Previous attempts to ship as a `.exe` / `.pkg` repeatedly broke.
   This is a plain web service: `git pull` → `setup.ps1` once → `start.ps1` daily.

## Architecture

| Layer    | Stack |
|----------|-------|
| Backend  | Python 3.11 + FastAPI (sync REST + native WebSockets) |
| Frontend | React + Vite + TypeScript + Tailwind v4 |
| Storage  | SQLite (engagements + runs tables) |
| Process  | `subprocess` to a long-lived `pwsh.exe` per engagement |
| Streaming| WebSocket for live console output and run state changes |
| CSV view | AG Grid Community |

Plan/spec lives in [`hawk-wrapper-plan.md`](hawk-wrapper-plan.md) (engagement
model, sentinel-wrapped run lifecycle, failure modes, etc.). The wrapper holds
**one `pwsh` subprocess per engagement** and never reuses it — process isolation
is the only reliable way to keep tenant connections from cross-contaminating.

## Requirements

A Windows 10/11 or Windows Server 2019+ box. Everything else is installed by
`setup.ps1`. The recurring services that run while it's in use:

- PowerShell 7.0.3+ (`pwsh.exe`)
- Python 3.11+
- Node.js LTS
- HAWK 4.0+ (CurrentUser scope)
- Microsoft.Graph 2.25.0 (pinned — see [Known issues](#known-issues))
- ExchangeOnlineManagement 3.0+

The pre-flight panel on the home page reports each check live and gates
engagement creation if anything is red.

## First-time setup on a fresh Windows VM

These steps need to happen **before** you can clone the repo and run `setup.ps1`,
because the repo can't install Git for you and PowerShell won't run a script at
all under the default execution policy.

### 1. Install Git

```powershell
winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements
```

Close that PowerShell window and open a fresh PowerShell 7 (or Windows PowerShell)
window so `git` is on `PATH`.

### 2. Allow local PowerShell scripts to run

Default Windows blocks `.ps1` files outright. Enable signed local scripts for
the current user (one-time, no admin needed):

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

It'll prompt — answer **Y**.

### 3. Clone the repo

```powershell
cd $env:USERPROFILE
git clone https://github.com/vorteratech/hawk-wrapper.git
cd hawk-wrapper
```

### 4. Run `setup.ps1`

```powershell
.\setup.ps1
```

This installs Python 3.11, Node.js LTS, PowerShell 7 (if you weren't already in
it), GitHub CLI, the HAWK + Microsoft.Graph + ExchangeOnlineManagement modules
(CurrentUser scope, with stale-version cleanup), the backend Python venv, and the
frontend npm dependencies. Idempotent — safe to re-run after a `git pull` to
pick up new deps.

**About 5–10 minutes total**, dominated by the Microsoft.Graph install.

If you started from `powershell.exe` (Windows PowerShell 5.1) the script
re-launches itself in `pwsh.exe` (PowerShell 7) so module installs land in the
path the wrapper backend actually queries. You don't need to do anything special.

## Daily use

```powershell
.\start.ps1
```

Spins up two PowerShell windows — one running `uvicorn` for the FastAPI backend
on `127.0.0.1:8000`, one running `vite` for the frontend on `127.0.0.1:5173` —
and opens the browser to `http://localhost:5173`.

Both windows auto-run their dep manager (`pip install -e .` and `npm install`)
on every launch so a `git pull` that adds a new package doesn't leave you with
a broken import.

To stop, close either window or `Ctrl+C` inside it.

## Typical engagement flow

1. **New Engagement** on the home page. Enter client name and the date range you
   want HAWK to scan. Click Create.
2. Two browser windows open for sign-in (Microsoft Graph, then Exchange Online).
   Sign in with whatever investigator credential has the necessary scopes on the
   client tenant.
3. Status flips to **READY**. The cmdlet picker lights up.
4. **Run Tenant Investigation** — single click; reuses the date range and output
   folder you set up. HAWK 4.0's non-interactive mode kicks in automatically.
5. **Run User Investigation…** — modal opens; paste UPNs (one per line). Reuses
   the same date range. Spawns a per-user folder for each.
6. Switch to **Files** to browse the output. `_Investigate_*` CSVs are red-badged
   — those are HAWK's flagged findings.
7. **Download Engagement (.zip)** to hand off to the analyst.
8. **End Engagement** when done. The pwsh subprocess is shut down cleanly
   (`Disconnect-ExchangeOnline`, `Disconnect-MgGraph`, then exit).

## Project layout

```
hawk-wrapper/
├── README.md                  # this file
├── hawk-wrapper-plan.md       # design doc, behavior contracts, failure modes
├── setup.ps1                  # one-time install for a fresh Windows VM
├── start.ps1                  # daily dev loop (backend + frontend + browser)
├── backend/
│   ├── main.py                # FastAPI entry, lifespan startup hooks
│   └── app/
│       ├── api/               # REST + WebSocket routers
│       ├── engagement.py      # pwsh subprocess + sentinel-wrapped run lifecycle
│       ├── preflight.py       # PowerShell version + module checks
│       ├── db.py              # SQLite schema + connection helper
│       └── config.py          # env-driven paths
└── frontend/
    └── src/
        ├── pages/             # HomePage, EngagementPage, FilesTab
        ├── components/        # Brand, ui (Button, Card, Modal, ...)
        └── lib/               # api client + WebSocket hooks
```

## Known issues

- **Microsoft.Graph 2.36.1** has a `TypeLoadException` on
  `UserProvidedTokenCredential.GetTokenAsync` that crashes `Import-Module Hawk`
  at module-load time. We pin to `Microsoft.Graph 2.25.0`. `setup.ps1` removes
  any other version it finds (including from OneDrive-synced module paths).
- **Risky Users / Risk Detections / Entra Sign-In Logs** require
  Microsoft Entra ID P1 or P2 on the target tenant. On non-licensed tenants the
  wrapper surfaces a friendly `[wrapper] Skipping ...` line; HAWK continues with
  the remaining cmdlets.
- **Graph 429 throttling** mid-investigation is transient — wait 5–10 minutes
  and re-run.
- **HAWK issue #292** (`Module could not be correctly formed. Please run
  Connect-ExchangeOnline again`) — the wrapper detects this in stdout and
  surfaces a one-click **Reconnect EXO** banner.

## License

Internal — Vendetta.
