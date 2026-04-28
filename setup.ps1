# setup.ps1 --one-time setup for hawk-utility on a fresh Windows VM.
# Idempotent: re-running it is safe and skips anything already installed.
#
# Usage (in PowerShell 7 from the repo root):
#     .\setup.ps1
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

# If we're running under Windows PowerShell 5.1, anything we Install-Module
# would land in WindowsPowerShell\Modules and be invisible to pwsh 7 (which
# the wrapper backend uses). Re-launch under pwsh if it's already on the
# system; otherwise winget will install it below and we'll re-launch on the
# next setup run.
if ($PSVersionTable.PSVersion.Major -lt 7) {
    if (Get-Command pwsh -ErrorAction SilentlyContinue) {
        Write-Host "Detected Windows PowerShell 5.1 -- re-launching setup in PowerShell 7..." -ForegroundColor Yellow
        & pwsh -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
        exit $LASTEXITCODE
    } else {
        Write-Host "Running under Windows PowerShell 5.1. Installing PowerShell 7 first; you'll then need to close this window and re-run setup from a fresh 'pwsh' window so module installs land in the PS 7 path." -ForegroundColor Yellow
    }
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

# Force TLS 1.2 -- fresh Windows defaults are often too old for PSGallery.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# Use Microsoft.PowerShell.PSResourceGet (Install-PSResource) instead of
# the legacy PowerShellGet stack. The legacy chain (Install-PackageProvider
# -> NuGet provider download -> Register-PSRepository -> Set-PSRepository
# -> Install-Module) is broken on fresh PS 7 VMs: the onegetcdn endpoint
# Microsoft used to host the NuGet provider DLL is now retired, and
# Register-PSRepository -Default itself needs the NuGet provider, which
# we can't bootstrap. PSResourceGet ships built-in with PS 7.4+ and uses
# direct HTTPS to PSGallery -- no NuGet provider required.
if (-not (Get-Command Install-PSResource -ErrorAction SilentlyContinue)) {
    throw "PowerShell 7.4+ with Install-PSResource is required. Detected: $($PSVersionTable.PSVersion). Re-launch setup.ps1 in a fresh pwsh window after winget finishes installing PowerShell 7."
}

# Make sure PSGallery is registered (and trusted) for PSResourceGet's repo store.
$psGallery = Get-PSResourceRepository -Name PSGallery -ErrorAction SilentlyContinue
if (-not $psGallery) {
    Write-Host "  - Registering PSGallery for PSResourceGet..." -ForegroundColor Yellow
    Register-PSResourceRepository -PSGallery -Trusted -Force
} elseif (-not $psGallery.Trusted) {
    Set-PSResourceRepository -Name PSGallery -Trusted
}

# Microsoft.Graph 2.36.1 ships a broken Authentication.Core (TypeLoadException
# on UserProvidedTokenCredential.GetTokenAsync) that crashes Import-Module
# HAWK at module load time. 2.25.0 is the last widely-deployed stable build
# that works with HAWK 4.0 -- HAWK's loose RequiredModules constraint
# (>= 2.0.0) means it accepts 2.25.0. Pin to 2.25.0 and aggressively
# uninstall any other version present.
$GraphPinnedVersion = '2.25.0'

# CurrentUser scope sidesteps the AllUsers module-lock issues that hit
# shared machines.
$existingHawk = Get-Module -ListAvailable -Name HAWK | Sort-Object Version -Descending | Select-Object -First 1
if ($existingHawk) {
    Write-Host "  - HAWK $($existingHawk.Version) already installed" -ForegroundColor DarkGray
} else {
    Write-Host "  - HAWK installing..." -ForegroundColor Yellow
    Install-PSResource -Name HAWK -Repository PSGallery -TrustRepository -Scope CurrentUser -Reinstall:$false
}

# Always remove non-pinned Graph versions, even if the pinned one is
# already installed. Mixed versions cause assembly load conflicts at
# Import-Module HAWK time (2.36.1 in particular has a broken
# Authentication.Core).
$stale = Get-Module -ListAvailable -Name 'Microsoft.Graph*' |
         Where-Object Version -ne ([version]$GraphPinnedVersion)
if ($stale) {
    Write-Host "  - Removing $($stale.Count) stale Microsoft.Graph* version(s) to avoid assembly conflicts..." -ForegroundColor Yellow
    $stale | Group-Object Name | ForEach-Object {
        $modName = $_.Name
        $_.Group | ForEach-Object {
            Uninstall-PSResource -Name $modName -Version "[$($_.Version),$($_.Version)]" -Scope CurrentUser -ErrorAction SilentlyContinue
        }
    }
    # Belt-and-braces: nuke leftover folders Uninstall sometimes misses.
    # Includes OneDrive-synced module paths because OneDrive redirects
    # %USERPROFILE%\Documents to %USERPROFILE%\OneDrive\Documents on
    # machines where OneDrive has folder backup enabled.
    @(
        "$env:USERPROFILE\OneDrive\Documents\PowerShell\Modules",
        "$env:USERPROFILE\OneDrive\Documents\WindowsPowerShell\Modules",
        "$env:USERPROFILE\Documents\PowerShell\Modules",
        "$env:USERPROFILE\Documents\WindowsPowerShell\Modules",
        "C:\Program Files\PowerShell\Modules",
        "C:\Program Files\WindowsPowerShell\Modules"
    ) | ForEach-Object {
        Get-ChildItem $_ -Filter 'Microsoft.Graph*' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $modDir = $_
            Get-ChildItem $modDir.FullName -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -ne $GraphPinnedVersion } |
                Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$existingGraph = Get-Module -ListAvailable -Name Microsoft.Graph |
                 Where-Object Version -eq ([version]$GraphPinnedVersion) |
                 Select-Object -First 1
if ($existingGraph) {
    Write-Host "  - Microsoft.Graph $GraphPinnedVersion already installed" -ForegroundColor DarkGray
} else {
    Write-Host "  - Microsoft.Graph $GraphPinnedVersion installing (this is the slow one)..." -ForegroundColor Yellow
    Install-PSResource -Name Microsoft.Graph -Version "[$GraphPinnedVersion,$GraphPinnedVersion]" -Repository PSGallery -TrustRepository -Scope CurrentUser -Reinstall:$false
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

# --- 5. Desktop shortcut -------------------------------------------------
Write-Step "Creating 'Start HAWK' desktop shortcut"
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Start HAWK.lnk'
$startScript = Join-Path $RepoRoot 'start.ps1'

$pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $pwshCmd) {
    Write-Host "  pwsh not found on PATH; skipping shortcut. Re-run setup.ps1 after PowerShell 7 install completes." -ForegroundColor Yellow
} else {
    try {
        $WshShell = New-Object -ComObject WScript.Shell
        $sc = $WshShell.CreateShortcut($shortcutPath)
        $sc.TargetPath = $pwshCmd.Source
        $sc.Arguments = "-ExecutionPolicy Bypass -File `"$startScript`""
        $sc.WorkingDirectory = $RepoRoot
        # Minimized so the launcher's brief existence doesn't grab focus;
        # start.ps1 spawns its own visible windows for the backend + frontend.
        $sc.WindowStyle = 7
        $sc.Description = 'Launch the HAWK Investigation Utility (backend + frontend + browser)'
        $sc.Save()
        Write-Host "  Created: $shortcutPath" -ForegroundColor Green
    } catch {
        Write-Host "  Failed to create shortcut: $_" -ForegroundColor Yellow
    }
}

# --- Done ----------------------------------------------------------------
Write-Step "Setup complete"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  - Double-click 'Start HAWK' on your desktop, or run .\start.ps1 from this folder." -ForegroundColor Gray
Write-Host "  - (Optional, one-time) gh auth login -- enables seamless future git pushes." -ForegroundColor Gray
Write-Host ""
