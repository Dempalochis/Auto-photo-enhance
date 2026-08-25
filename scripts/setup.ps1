<#
  First-run setup for a fresh clone (V8 Phase 4 - "a few clicks" Windows setup): checks
  prerequisites (Node.js, RawTherapee, ExifTool), offers to install missing ones via winget,
  sets up config/config.json from the tracked config.example.json template with auto-discovered
  local paths, then installs npm dependencies and builds the production client.

  Run by double-clicking setup.bat (repo root), or directly:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1

  Idempotent: safe to re-run. An existing config/config.json is never replaced wholesale - only
  its rtPath/exiftoolPath fields are updated, and only when a real path was actually found, so a
  second run never clobbers other settings (quality, presets, quarantine threshold, etc.) someone
  already customized.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib_common.ps1")
$RepoRoot = Get-RepoRoot

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-SetupWarning($msg) { Write-Host "    WARNING: $msg" -ForegroundColor Yellow }

$wingetAvailable = [bool](Get-Command winget -ErrorAction SilentlyContinue)
if (-not $wingetAvailable) {
    Write-SetupWarning "winget not found - this is normal on older Windows 10 builds. Missing prerequisites below will need a manual download instead of an automatic install."
}

# --- 1. Node.js (hard requirement - nothing else in this script can run without it) ---
Write-Step "Checking for Node.js..."
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    Write-Ok "Node.js found: $($node.Source) ($(node --version))"
} else {
    Write-SetupWarning "Node.js not found on PATH."
    Write-Host "    Auto Photo Enhance's web UI needs Node.js 18+ to run."
    Write-Host "    Download and install it from https://nodejs.org/ (the LTS version), then re-run this script."
    exit 1
}

# --- 2. RawTherapee (reuses lib_common.ps1's own auto-discovery, same logic auto_enhance.ps1
#        and preview_presets.ps1 already use, so this doesn't duplicate/diverge from it) ---
Write-Step "Checking for RawTherapee..."
$configPath = Join-Path $RepoRoot "config\config.json"
$existingConfig = Read-EnhanceConfig $configPath
$rtPath = Resolve-RTPath $existingConfig.rtPath
if ($rtPath -and (Test-Path -LiteralPath $rtPath)) {
    Write-Ok "RawTherapee found: $rtPath"
} else {
    Write-SetupWarning "RawTherapee CLI not found."
    if ($wingetAvailable) {
        Write-Host "    Installing via winget (RawTherapee.RawTherapee)..."
        winget install -e --id RawTherapee.RawTherapee --accept-source-agreements --accept-package-agreements
        $rtPath = Resolve-RTPath $null
    }
    if ($rtPath -and (Test-Path -LiteralPath $rtPath)) {
        Write-Ok "RawTherapee found: $rtPath"
    } else {
        Write-SetupWarning "Could not find or install RawTherapee automatically. Download it from https://rawtherapee.com/downloads and set `"rtPath`" in config\config.json afterwards."
        $rtPath = $null
    }
}

# --- 3. ExifTool (optional - the app degrades gracefully without it, see startupChecks.js) ---
Write-Step "Checking for ExifTool..."
$exiftoolPath = Find-ExifToolPath $existingConfig.exiftoolPath $null
if ($exiftoolPath) {
    Write-Ok "ExifTool found: $exiftoolPath"
} else {
    Write-SetupWarning "ExifTool not found."
    if ($wingetAvailable) {
        Write-Host "    Installing via winget (OliverBetz.ExifTool)..."
        winget install -e --id OliverBetz.ExifTool --accept-source-agreements --accept-package-agreements
        $exiftoolPath = Find-ExifToolPath $null $null
    }
    if ($exiftoolPath) {
        Write-Ok "ExifTool found: $exiftoolPath"
    } else {
        Write-SetupWarning "Could not find or install ExifTool automatically. The app still works without it (capture dates fall back to file-modified time, thumbnails are unavailable) - download it from https://exiftool.org and set `"exiftoolPath`" in config\config.json to enable those features later."
    }
}

# --- 4. config/config.json ---
Write-Step "Setting up config\config.json..."
$examplePath = Join-Path $RepoRoot "config\config.example.json"
if (-not (Test-Path -LiteralPath $configPath)) {
    Copy-Item -LiteralPath $examplePath -Destination $configPath
    Write-Ok "Created config\config.json from config.example.json."
} else {
    Write-Ok "config\config.json already exists - only updating the paths just discovered above, nothing else."
}
$cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($rtPath) { $cfg.rtPath = $rtPath }
if ($exiftoolPath) { $cfg.exiftoolPath = $exiftoolPath }
$cfg | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath
Write-Ok "config\config.json is up to date."

# --- 5. npm install + production build ---
Write-Step "Installing dependencies (npm install)..."
Push-Location $RepoRoot
try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    Write-Ok "Dependencies installed."

    Write-Step "Building the production client (npm run build)..."
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
    Write-Ok "Client built."
} finally {
    Pop-Location
}

Write-Host "`nSetup complete! Double-click start.bat to launch Auto Photo Enhance." -ForegroundColor Green
