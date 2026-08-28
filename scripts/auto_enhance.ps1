<#
  Hardened, idempotent wrapper around rawtherapee-cli.
  Converts raw photos (.arw/.nef/.dng/.raf - see lib_common.ps1's $SupportedRawExtensions) in
  -InputDir to JPEG using a RawTherapee pp3 profile (color correction), optionally with a second
  pp3 "look" preset stacked on top, logging one row per file and exiting non-zero if anything
  failed.

  Settings resolve in this order (highest wins): explicit -Param > config/config.json > built-in default.

  To process an explicit subset of files instead of a whole -InputDir, pass -FilesJson with a
  JSON array of paths, e.g.: -FilesJson '["C:\a.ARW","C:\b.ARW"]'
  (a single JSON string sidesteps PowerShell's array/positional argv parsing quirks entirely -
  this is how the web UI backend calls it.)
#>
[CmdletBinding()]
param(
    [string]$InputDir,
    [string]$OutputDir,
    [string]$RTPath,
    [string]$ProfilePath,
    [string]$Profile,
    [string]$Preset,
    [Nullable[int]]$Quality,
    [string]$LogDir,
    [string]$ConfigPath,
    [string]$FilesJson,
    [string]$PhotosRoot,
    [Nullable[bool]]$ScanSubfolders
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib_common.ps1")
$RepoRoot = Get-RepoRoot

function Fail($message) {
    Write-Host "ERROR: $message" -ForegroundColor Red
    exit 1
}

if (-not $ConfigPath) { $ConfigPath = Join-Path $RepoRoot "config\config.json" }
$config = Read-EnhanceConfig $ConfigPath

if ($config.quality -and ($config.quality -lt 1 -or $config.quality -gt 100)) {
    Fail "Invalid 'quality' in config (must be 1-100): $($config.quality)"
}

if (-not $RTPath) { $RTPath = $config.rtPath }
$RTPath = Resolve-RTPath $RTPath
if (-not $InputDir) { $InputDir = $RepoRoot }
if (-not $OutputDir) { $OutputDir = if ($config.outputDir) { Resolve-RepoPath $RepoRoot $config.outputDir } else { Join-Path $RepoRoot "edited_jpg" } }
if (-not $LogDir)    { $LogDir    = if ($config.logDir)    { Resolve-RepoPath $RepoRoot $config.logDir }    else { Join-Path $RepoRoot "logs" } }
if (-not $Quality)   { $Quality   = if ($config.quality)   { $config.quality }                    else { 95 } }
$quarantineAfterFailures = if ($config.quarantineAfterFailures) { $config.quarantineAfterFailures } else { 2 }
if ($null -eq $ScanSubfolders) { $ScanSubfolders = if ($null -ne $config.scanSubfolders) { [bool]$config.scanSubfolders } else { $true } }

if (-not (Test-Path -LiteralPath $RTPath)) {
    Fail "RawTherapee CLI not found: $RTPath"
}

$explicitProfileOverride = $PSBoundParameters.ContainsKey('ProfilePath') -or $PSBoundParameters.ContainsKey('Profile')
$baseCtx = Initialize-BaseProfileContext -RepoRoot $RepoRoot -config $config -ProfilePath $ProfilePath -Profile $Profile -ExplicitProfileOverride $explicitProfileOverride

# Preset ("look"): an optional second pp3 stacked on top of the base color-correction profile.
# Not set (default) => behaves exactly as before presets existed.
if (-not $PSBoundParameters.ContainsKey('Preset') -and $config.preset) { $Preset = $config.preset }
$presetPath = $null
if ($Preset) {
    $presetPath = Join-Path $RepoRoot "presets\$Preset.pp3"
    if (-not (Test-Path -LiteralPath $presetPath)) {
        Fail "Missing preset: $presetPath"
    }
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$existingCount = @(Get-ChildItem -LiteralPath $OutputDir -Force -ErrorAction SilentlyContinue).Count
if ($existingCount -gt 0) {
    Write-Host "WARNING: Output folder already contains $existingCount item(s): $OutputDir"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$logFile = Join-Path $LogDir "run_$timestamp.csv"
$rows = New-Object System.Collections.Generic.List[object]

if ($FilesJson) {
    try {
        $fileList = @(ConvertFrom-Json -InputObject $FilesJson)
    } catch {
        Fail "Failed to parse -FilesJson (invalid JSON): $_"
    }
    $arwFiles = @()
    foreach ($f in $fileList) {
        if (-not (Test-Path -LiteralPath $f)) { Fail "File not found: $f" }
        $arwFiles += Get-Item -LiteralPath $f
    }
} else {
    # $arwFiles keeps its name for now (pre-V9 naming; renaming every use below is a larger,
    # purely-cosmetic follow-up not worth the risk right before real multi-format testing) - it
    # holds any supported raw format, not just .arw, via Test-IsRawFile below.
    $arwFiles = @(Get-ChildItem -LiteralPath $InputDir -File -Recurse:$ScanSubfolders | Where-Object { Test-IsRawFile $_ })
}
if ($arwFiles.Count -eq 0) {
    Write-Host "No raw photos found in $InputDir (looked for: $($SupportedRawExtensions -join ', '))"
}

# Root used to compute each file's relative subfolder, so a recursive scan's output mirrors
# the input structure instead of flattening everything into one folder. -PhotosRoot lets a
# caller (the web UI, which passes an explicit -FilesJson list) supply this even though
# $InputDir isn't the relevant root in that mode.
$mirrorRoot = if ($PhotosRoot) { $PhotosRoot } else { $InputDir }

$processed = 0
$skipped = 0
$failed = 0
$quarantined = 0
$totalSw = [System.Diagnostics.Stopwatch]::StartNew()

foreach ($arw in $arwFiles) {
    $relSubfolder = Get-RelativeSubfolder $mirrorRoot $arw.DirectoryName
    $outSubdir = if ($relSubfolder) { Join-Path $OutputDir $relSubfolder } else { $OutputDir }
    if ($relSubfolder) { New-Item -ItemType Directory -Force -Path $outSubdir | Out-Null }
    # No preset (plain color correction) keeps the original base name, unchanged from before
    # presets existed. A selected preset appends "_<preset>" so different looks rendered from the
    # same source photo land as separate files instead of overwriting each other.
    $outBaseName = if ($presetPath) { "$($arw.BaseName)_$Preset" } else { $arw.BaseName }
    $outFile = Join-Path $outSubdir "$outBaseName.jpg"

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

    $base = Get-BaseProfileForFile -ctx $baseCtx -file $arw
    $profileForThisFile = $base.ProfilePath
    $formatOverlay = $base.FormatOverlayPath
    $isoValue = $base.ISO

    $presetLabel = if ($presetPath) { $Preset } else { "none" }
    $overlayLabel = if ($formatOverlay) { ", overlay=$([System.IO.Path]::GetFileNameWithoutExtension($formatOverlay))" } else { "" }
    Write-Host "Enhancing $($arw.Name) (ISO=$isoValue, profile=$([System.IO.Path]::GetFileNameWithoutExtension($profileForThisFile))$overlayLabel, preset=$presetLabel)"

    $rtArgs = @("-p", $profileForThisFile)
    if ($formatOverlay) { $rtArgs += @("-p", $formatOverlay) }
    if ($presetPath) { $rtArgs += @("-p", $presetPath) }
    $rtArgs += @("-o", $outFile, "-j$Quality", "-Y", "-q", "-c", $arw.FullName)

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $rtResult = Invoke-RawTherapee -RTPath $RTPath -RTArgs $rtArgs
    $sw.Stop()
    $stdout = $rtResult.Stdout
    $exitCode = $rtResult.ExitCode

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
            $failedDir = Join-Path $arw.DirectoryName "failed"
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
        Preset      = $presetLabel
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
Write-Host "Base profile: $($baseCtx.StaticProfilePath)"
Write-Host "Preset: $(if ($presetPath) { $presetPath } else { 'none' })"
Write-Host "Processed: $processed  Skipped: $skipped  Failed: $failed  Quarantined: $quarantined"
Write-Host "Total time: $([math]::Round($totalSw.Elapsed.TotalSeconds, 1))s"
Write-Host "Log: $logFile"
Write-Host "Output: $OutputDir"
Write-Host "====================================="

if ($failed -gt 0) { exit 1 } else { exit 0 }
