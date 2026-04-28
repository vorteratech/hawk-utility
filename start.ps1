# start.ps1 -- spins up the hawk-wrapper backend + frontend in two windows
# and opens the browser. Daily-use script.
#
# Usage (from the repo root):
#     .\start.ps1
#
# Each server runs in its own PowerShell window so you can see logs and
# Ctrl+C to stop. Closing the window stops that server.

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot

$backendDir = Join-Path $RepoRoot 'backend'
$frontendDir = Join-Path $RepoRoot 'frontend'

if (-not (Test-Path (Join-Path $backendDir '.venv\Scripts\Activate.ps1'))) {
    throw "Backend venv missing. Run .\setup.ps1 first."
}
if (-not (Test-Path (Join-Path $frontendDir 'node_modules'))) {
    throw "Frontend node_modules missing. Run .\setup.ps1 first."
}

# `pip install -e .` and `npm install` are fast no-ops when nothing changed
# (uv-style: only fetches deltas), so running them on every start makes
# `git pull` + `.\start.ps1` 'just work' even after a commit adds new deps.
$backendCmd = "Set-Location '$backendDir'; .\.venv\Scripts\Activate.ps1; pip install --quiet -e .; uvicorn main:app --host 127.0.0.1 --port 8000"
$frontendCmd = "Set-Location '$frontendDir'; npm install --silent; npm run dev"

Write-Host "Starting backend in a new window..." -ForegroundColor Cyan
Start-Process pwsh -ArgumentList '-NoExit', '-NoLogo', '-Command', $backendCmd

Write-Host "Starting frontend in a new window..." -ForegroundColor Cyan
Start-Process pwsh -ArgumentList '-NoExit', '-NoLogo', '-Command', $frontendCmd

# Give vite a moment to bind, then open the browser.
Start-Sleep -Seconds 4
Write-Host "Opening browser to http://localhost:5173" -ForegroundColor Cyan
Start-Process 'http://localhost:5173'

Write-Host ""
Write-Host "Both servers running in separate windows. Close those windows or Ctrl+C inside them to stop."
