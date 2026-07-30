<#
  Hardened, idempotent wrapper around rawtherapee-cli.
  Converts *.arw files in -InputDir to JPEG using a RawTherapee pp3 profile,
  logging one row per file and exiting non-zero if anything failed.

  Settings resolve in this order (highest wins): explicit -Param > config/config.json > built-in default.
#>
[CmdletBinding()]
param(
    [string]$InputDir,
    [string]$OutputDir,
    [string]$RTPath,
    [string]$ProfilePath,
    [string]$Profile,
    [Nullable[int]]$Quality,
    [string]$LogDir,
    [string]$ConfigPath
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Fail($message) {
    Write-Host "ERROR: $message" -ForegroundColor Red
    exit 1
}

function Resolve-RepoPath($path) {
    if ([System.IO.Path]::IsPathRooted($path)) { return $path }
    return (Join-Path $RepoRoot $path)
}

if (-not $ConfigPath) { $ConfigPath = Join-Path $RepoRoot "config\config.json" }

$config = [pscustomobject]@{}
if (Test-Path -LiteralPath $ConfigPath) {
    try {
        $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    } catch {
        Fail "Failed to parse config file (invalid JSON): $ConfigPath`n$_"
    }
}

if ($config.quality -and ($config.quality -lt 1 -or $config.quality -gt 100)) {
    Fail "Invalid 'quality' in config (must be 1-100): $($config.quality)"
}

if (-not $RTPath)  { $RTPath  = if ($config.rtPath)  { $config.rtPath }  else { "C:\Program Files\RawTherapee\5.12\rawtherapee-cli.exe" } }
if (-not $InputDir) { $InputDir = $RepoRoot }
if (-not $OutputDir) { $OutputDir = if ($config.outputDir) { Resolve-RepoPath $config.outputDir } else { Join-Path $RepoRoot "edited_jpg" } }
if (-not $LogDir)    { $LogDir    = if ($config.logDir)    { Resolve-RepoPath $config.logDir }    else { Join-Path $RepoRoot "logs" } }
if (-not $Quality)   { $Quality   = if ($config.quality)   { $config.quality }                    else { 95 } }
$quarantineAfterFailures = if ($config.quarantineAfterFailures) { $config.quarantineAfterFailures } else { 2 }

$explicitProfileOverride = $PSBoundParameters.ContainsKey('ProfilePath') -or $PSBoundParameters.ContainsKey('Profile')

if (-not $ProfilePath) {
    if (-not $Profile) {
        $Profile = if ($config.defaultProfile) { $config.defaultProfile } else { "default" }
    }
    $ProfilePath = Join-Path $RepoRoot "profiles\$Profile.pp3"
}

if (-not (Test-Path -LiteralPath $RTPath)) {
    Fail "RawTherapee CLI not found: $RTPath"
}
if (-not (Test-Path -LiteralPath $ProfilePath)) {
    Fail "Missing profile: $ProfilePath"
}

# Auto-profile: pick a profile per file based on ISO (read via exiftool), instead of one
# static profile for every shot. Falls back to the static profile above when disabled,
# overridden explicitly, or exiftool isn't available.
$autoProfileEnabled = (-not $explicitProfileOverride) -and $config.autoProfile -and $config.autoProfile.enabled
$exiftoolPath = $config.exiftoolPath
$exiftoolAvailable = $autoProfileEnabled -and $exiftoolPath -and (Test-Path -LiteralPath $exiftoolPath)

if ($autoProfileEnabled -and -not $exiftoolAvailable) {
    Write-Host "NOTE: autoProfile is enabled in config but exiftool was not found at '$exiftoolPath' - using the static profile for all files."
}

if ($exiftoolAvailable) {
    $isoThreshold = if ($config.autoProfile.isoThreshold) { $config.autoProfile.isoThreshold } else { 800 }
    $lowIsoProfilePath = Join-Path $RepoRoot "profiles\$($config.autoProfile.lowIsoProfile).pp3"
    $highIsoProfilePath = Join-Path $RepoRoot "profiles\$($config.autoProfile.highIsoProfile).pp3"
    if (-not (Test-Path -LiteralPath $lowIsoProfilePath)) { Fail "Missing autoProfile.lowIsoProfile: $lowIsoProfilePath" }
    if (-not (Test-Path -LiteralPath $highIsoProfilePath)) { Fail "Missing autoProfile.highIsoProfile: $highIsoProfilePath" }
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$logFile = Join-Path $LogDir "run_$timestamp.csv"
$rows = New-Object System.Collections.Generic.List[object]

$arwFiles = Get-ChildItem -LiteralPath $InputDir -Filter "*.arw" -File
if ($arwFiles.Count -eq 0) {
    Write-Host "No .arw files found in $InputDir"
}

$processed = 0
$skipped = 0
$failed = 0
$quarantined = 0
$failedDir = Join-Path $InputDir "failed"
$totalSw = [System.Diagnostics.Stopwatch]::StartNew()

foreach ($arw in $arwFiles) {
    $outFile = Join-Path $OutputDir "$($arw.BaseName).jpg"

    if (Test-Path -LiteralPath $outFile) {
        Write-Host "Skipping $($arw.Name) (output already exists)"
        $skipped++
        $rows.Add([pscustomobject]@{
            Timestamp   = (Get-Date -Format "o")
            File        = $arw.Name
            Status      = "Skipped"
            ExitCode    = ""
            DurationSec = ""
            OutputPath  = $outFile
            Note        = "output already exists"
        })
        continue
    }

    $profileForThisFile = $ProfilePath
    $isoValue = ""

    if ($exiftoolAvailable) {
        $isoRaw = (& $exiftoolPath "-ISO" "-s" "-s" "-s" $arw.FullName | Out-String).Trim()
        $isoInt = 0
        if ([int]::TryParse($isoRaw, [ref]$isoInt)) {
            $isoValue = $isoInt
            $profileForThisFile = if ($isoInt -ge $isoThreshold) { $highIsoProfilePath } else { $lowIsoProfilePath }
        }
    }

    Write-Host "Enhancing $($arw.Name) (ISO=$isoValue, profile=$([System.IO.Path]::GetFileNameWithoutExtension($profileForThisFile)))"
    $rtArgs = @(
        "-p", $profileForThisFile,
        "-o", $outFile,
        "-j$Quality",
        "-Y",
        "-c", $arw.FullName
    )

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $stdout = & $RTPath @rtArgs | Out-String
    $sw.Stop()
    $exitCode = $LASTEXITCODE

    $status = "Processed"
    $note = ""

    if ($stdout -match "Usage:") {
        $status = "Failed"
        $note = "RawTherapee printed its help text instead of processing (an option was likely rejected)"
    } elseif ($exitCode -ne 0) {
        $status = "Failed"
        $note = "rawtherapee-cli exited with code $exitCode"
    } elseif (-not (Test-Path -LiteralPath $outFile)) {
        $status = "Failed"
        $note = "no output file was created"
    }

    $attemptsMarker = "$($arw.FullName).attempts"

    if ($status -eq "Processed") {
        $processed++
        if (Test-Path -LiteralPath $attemptsMarker) { Remove-Item -LiteralPath $attemptsMarker -Force }
    } else {
        $failed++
        $attempts = 1
        if (Test-Path -LiteralPath $attemptsMarker) {
            $prev = Get-Content -LiteralPath $attemptsMarker -Raw
            $prevInt = 0
            if ([int]::TryParse($prev.Trim(), [ref]$prevInt)) { $attempts = $prevInt + 1 }
        }

        if ($attempts -ge $quarantineAfterFailures) {
            New-Item -ItemType Directory -Force -Path $failedDir | Out-Null
            $quarantinePath = Join-Path $failedDir $arw.Name
            Move-Item -LiteralPath $arw.FullName -Destination $quarantinePath -Force
            if (Test-Path -LiteralPath $attemptsMarker) { Remove-Item -LiteralPath $attemptsMarker -Force }
            $note = "$note (quarantined to failed\$($arw.Name) after $attempts failed attempts)"
            $quarantined++
        } else {
            Set-Content -LiteralPath $attemptsMarker -Value $attempts
            $note = "$note (attempt $attempts of $quarantineAfterFailures before quarantine)"
        }
    }

    $rows.Add([pscustomobject]@{
        Timestamp   = (Get-Date -Format "o")
        File        = $arw.Name
        Status      = $status
        ExitCode    = $exitCode
        DurationSec = [math]::Round($sw.Elapsed.TotalSeconds, 2)
        ISO         = $isoValue
        Profile     = [System.IO.Path]::GetFileNameWithoutExtension($profileForThisFile)
        OutputPath  = $outFile
        Note        = $note
    })

    if ($status -eq "Failed") {
        Write-Host "  FAILED: $note" -ForegroundColor Red
    }
}

$totalSw.Stop()
$rows | Export-Csv -LiteralPath $logFile -NoTypeInformation

Write-Host ""
Write-Host "====================================="
Write-Host "Profile: $ProfilePath"
Write-Host "Processed: $processed  Skipped: $skipped  Failed: $failed  Quarantined: $quarantined"
Write-Host "Total time: $([math]::Round($totalSw.Elapsed.TotalSeconds, 1))s"
Write-Host "Log: $logFile"
Write-Host "Output: $OutputDir"
Write-Host "====================================="

if ($failed -gt 0) { exit 1 } else { exit 0 }
