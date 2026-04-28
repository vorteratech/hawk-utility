# bootstrap.ps1 --one-time setup for hawk-wrapper on a fresh Windows VM.
# Idempotent: re-running it is safe and skips anything already installed.
#
# Usage (in PowerShell 7 from the repo root):
#     .\bootstrap.ps1
#
# What it does:
#   1. Installs runtimes via winget (Git, Python 3.11, Node.js LTS, PowerShell 7, gh).
#   2. Refreshes PATH for the current session.
#   3. Installs HAWK + Microsoft.Graph PowerShell modules (CurrentUser scope).
#   4. Creates the backend venv and installs Python deps.
#   5. Installs frontend npm deps.

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Refresh-Path {
    $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Ensure-WingetPackage([string]$Id) {
    Write-Host "  - $Id" -NoNewline
    $existing = winget list --id $Id --exact 2>$null | Select-String -Pattern $Id -Quiet
    if ($existing) {
        Write-Host " (already installed)" -ForegroundColor DarkGray
        return
    }
    Write-Host " installing..." -ForegroundColor Yellow
    winget install --id $Id --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Null
}

# --- 1. Runtimes ---------------------------------------------------------
Write-Step "Installing runtimes via winget"
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget not found. Install 'App Installer' from the Microsoft Store and re-run."
}
Ensure-WingetPackage 'Git.Git'
Ensure-WingetPackage 'Python.Python.3.11'
Ensure-WingetPackage 'OpenJS.NodeJS.LTS'
Ensure-WingetPackage 'Microsoft.PowerShell'
Ensure-WingetPackage 'GitHub.cli'

Refresh-Path

# Validate everything is reachable in this session.
Write-Step "Verifying tools on PATH"
$tools = @('git', 'python', 'node', 'npm', 'gh', 'pwsh')
$missing = @()
foreach ($t in $tools) {
    if (Get-Command $t -ErrorAction SilentlyContinue) {
        Write-Host "  OK  $t" -ForegroundColor Green
    } else {
        Write-Host "  --  $t (missing)" -ForegroundColor Red
        $missing += $t
    }
}
if ($missing.Count -gt 0) {
    Write-Warning "Some tools are not on PATH yet. Open a NEW PowerShell window and re-run this script --winget installs sometimes only register on shell restart. Missing: $($missing -join ', ')"
    return
}

# --- 2. PowerShell modules -----------------------------------------------
Write-Step "Installing HAWK and Microsoft.Graph PowerShell modules"
Write-Host "  This pulls ~30 Graph submodules and can take 5+ minutes." -ForegroundColor DarkGray

# Use CurrentUser scope to avoid the AllUsers PackageManagement lock issues
# that hit Windows machines where modules are open in another process.
foreach ($mod in @('HAWK', 'Microsoft.Graph')) {
    $existing = Get-Module -ListAvailable -Name $mod | Sort-Object Version -Descending | Select-Object -First 1
    if ($existing) {
        Write-Host "  - $mod $($existing.Version) already installed" -ForegroundColor DarkGray
        continue
    }
    Write-Host "  - $mod installing..." -ForegroundColor Yellow
    Install-Module -Name $mod -Force -SkipPublisherCheck -Scope CurrentUser -AllowClobber
}

# --- 3. Backend ----------------------------------------------------------
Write-Step "Setting up Python backend"
Push-Location (Join-Path $RepoRoot 'backend')
try {
    if (-not (Test-Path '.venv')) {
        Write-Host "  Creating venv..." -ForegroundColor Yellow
        python -m venv .venv
    } else {
        Write-Host "  venv already exists" -ForegroundColor DarkGray
    }
    & .\.venv\Scripts\python.exe -m pip install --upgrade pip --quiet
    & .\.venv\Scripts\python.exe -m pip install --quiet -e .
    Write-Host "  Backend deps installed" -ForegroundColor Green
} finally {
    Pop-Location
}

# --- 4. Frontend ---------------------------------------------------------
Write-Step "Installing frontend npm deps"
Push-Location (Join-Path $RepoRoot 'frontend')
try {
    if (-not (Test-Path 'node_modules')) {
        npm install --silent
    } else {
        Write-Host "  node_modules already exists --running 'npm install' to sync lockfile" -ForegroundColor DarkGray
        npm install --silent
    }
    Write-Host "  Frontend deps installed" -ForegroundColor Green
} finally {
    Pop-Location
}

# --- Done ----------------------------------------------------------------
Write-Step "Bootstrap complete"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. (One-time)  gh auth login    # so future git operations are seamless" -ForegroundColor Gray
Write-Host "  2. Run         .\start.ps1       # spins up backend + frontend and opens the browser" -ForegroundColor Gray
Write-Host ""
