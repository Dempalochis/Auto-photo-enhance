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
    [Nullable[bool]]$ScanSubfolders,
    # Version 2 Phase 4: JSON file mapping raw path -> AI correction overlay (see below).
    [string]$CorrectionsJson,
    # Version 2 Phase 2: override config.batchRender for this run: "true" / "false" (a string, so
    # it also works through `powershell -File`, which can't pass a [bool]).
    [string]$BatchRender,
    # Version 2 Phase 1: also print machine-readable "@@EVENT {...}" lines (the web UI passes this;
    # without it the console output is exactly Version 1's).
    [switch]$EmitEvents
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib_common.ps1")
$RepoRoot = Get-RepoRoot
Enable-PipelineEvents $EmitEvents.IsPresent

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

$stats = @{ processed = 0; skipped = 0; failed = 0; quarantined = 0 }
$totalSw = [System.Diagnostics.Stopwatch]::StartNew()
$fileTotal = $arwFiles.Count
$presetLabel = if ($presetPath) { $Preset } else { "none" }

# ---- Version 2 Phase 4: optional per-photo AI correction overlays ----
# -CorrectionsJson <file>: { "<full raw path>": "<overlay.pp3>" | { overlay, summary, scene, note } }.
# A file WITH an entry renders as <name>_ai[_<preset>].jpg, with the overlay (if any - an all-zero
# or failed analysis has none) stacked after base/format overlay and before the preset. Without
# -CorrectionsJson nothing here changes Version 1 behaviour (names, stack, CSV columns).
$aiMap = $null
if ($CorrectionsJson) {
    if (-not (Test-Path -LiteralPath $CorrectionsJson)) { Fail "Corrections file not found: $CorrectionsJson" }
    try { $aiRaw = Get-Content -LiteralPath $CorrectionsJson -Raw | ConvertFrom-Json } catch { Fail "Failed to parse -CorrectionsJson (invalid JSON): $_" }
    $aiMap = @{}
    foreach ($prop in $aiRaw.PSObject.Properties) {
        $v = $prop.Value
        $entry = if ($v -is [string]) { [pscustomobject]@{ overlay = $v; summary = ""; scene = ""; note = "" } } else { $v }
        if ($entry.overlay -and -not (Test-Path -LiteralPath $entry.overlay)) { Fail "AI overlay not found: $($entry.overlay)" }
        $aiMap[[System.IO.Path]::GetFullPath($prop.Name).ToLowerInvariant()] = $entry
    }
}
function Get-AiEntry([System.IO.FileInfo]$File) {
    if (-not $aiMap) { return $null }
    $k = $File.FullName.ToLowerInvariant()
    if ($aiMap.ContainsKey($k)) { return $aiMap[$k] }
    return $null
}

# ---- Version 2 Phase 2: batched rendering (opt-in: config.batchRender / -BatchRender) ----
$useBatch = if ($BatchRender) { $BatchRender -match '^(1|true|\$true|yes|on)$' } else { ($config.batchRender -eq $true) }
$maxBatchSize = if ($config.maxBatchSize -gt 0) { [int]$config.maxBatchSize } else { 20 }
$maxCommandChars = if ($config.maxCommandChars -gt 0) { [int]$config.maxCommandChars } else { 16000 }
$progressSource = if ($config.progressSource -eq "stdout") { "stdout" } else { "outputFolder" }

# Everything about one input file that doesn't need RawTherapee: output name, skip check, base
# profile, AI overlay. Index = position in the input list (what @@EVENT "index" refers to).
function New-FileJob([System.IO.FileInfo]$arw, [int]$index) {
    $relSubfolder = Get-RelativeSubfolder $mirrorRoot $arw.DirectoryName
    $outSubdir = if ($relSubfolder) { Join-Path $OutputDir $relSubfolder } else { $OutputDir }
    if ($relSubfolder) { New-Item -ItemType Directory -Force -Path $outSubdir | Out-Null }
    $ai = Get-AiEntry $arw
    # No preset (plain color correction) keeps the original base name, unchanged from before
    # presets existed. A selected preset appends "_<preset>" so different looks rendered from the
    # same source photo land as separate files instead of overwriting each other. AI-corrected
    # renders add "_ai" so they never collide with (or get skipped because of) plain ones.
    $nameBase = if ($ai) { "$($arw.BaseName)_ai" } else { $arw.BaseName }
    $outBaseName = if ($presetPath) { "$($nameBase)_$Preset" } else { $nameBase }
    return [pscustomobject]@{
        Index = $index; Arw = $arw; OutSubdir = $outSubdir; OutFile = (Join-Path $outSubdir "$outBaseName.jpg")
        Ai = $ai; AiOverlay = $(if ($ai -and $ai.overlay) { $ai.overlay } else { $null })
        Base = $null; Signature = $null
    }
}

function Add-Row($job, [hashtable]$row) {
    $o = [ordered]@{}
    foreach ($k in @("Timestamp", "File", "Status", "ExitCode", "DurationSec", "ISO", "Profile", "Preset", "OutputPath", "Note")) {
        if ($row.ContainsKey($k)) { $o[$k] = $row[$k] }
    }
    if ($aiMap) {
        $o["AiCorrection"] = if ($job.Ai -and $job.Ai.summary) { $job.Ai.summary } elseif ($job.Ai) { "none" } else { "" }
        $o["AiScene"] = if ($job.Ai -and $job.Ai.scene) { $job.Ai.scene } else { "" }
    }
    $rowsByIndex[$job.Index] = [pscustomobject]$o
}

function Write-Skipped($job) {
    $arw = $job.Arw
    Write-Host "Skipping $($arw.Name) (output already exists)"
    Write-PipelineEvent "file_skipped" @{ file = $arw.FullName; index = $job.Index; total = $fileTotal; output = $job.OutFile; note = "output already exists" }
    $stats.skipped++
    Add-Row $job @{
        Timestamp = (Get-Date -Format "o"); File = $arw.Name; Status = "Skipped"; ExitCode = ""; DurationSec = ""
        OutputPath = $job.OutFile; Note = "output already exists"
    }
}

function Resolve-JobProfiles($job) {
    if (-not $job.Base) { $job.Base = Get-BaseProfileForFile -ctx $baseCtx -file $job.Arw }
}

function Write-StartLine($job) {
    $arw = $job.Arw
    $overlayLabel = if ($job.Base.FormatOverlayPath) { ", overlay=$([System.IO.Path]::GetFileNameWithoutExtension($job.Base.FormatOverlayPath))" } else { "" }
    $aiLabel = if ($job.Ai) { ", ai=$(if ($job.Ai.summary) { $job.Ai.summary } else { 'none' })" } else { "" }
    Write-Host "Enhancing $($arw.Name) (ISO=$($job.Base.ISO), profile=$([System.IO.Path]::GetFileNameWithoutExtension($job.Base.ProfilePath))$overlayLabel$aiLabel, preset=$presetLabel)"
    Write-PipelineEvent "file_started" @{ file = $arw.FullName; index = $job.Index; total = $fileTotal; output = $job.OutFile }
}

# Status bookkeeping shared by the single-file and batch paths: attempt markers, quarantine after
# quarantineAfterFailures, CSV row, console + event lines. Identical to Version 1's per-file code.
function Complete-FileJob($job, [string]$status, [string]$note, $exitCode, [double]$seconds) {
    $arw = $job.Arw
    if ($job.Ai -and $job.Ai.note) { $note = if ($note) { "$note; $($job.Ai.note)" } else { $job.Ai.note } }
    $attemptsMarker = "$($arw.FullName).attempts"
    if ($status -eq "Processed") {
        $stats.processed++
        if (Test-Path -LiteralPath $attemptsMarker) { Remove-Item -LiteralPath $attemptsMarker -Force }
    } else {
        $stats.failed++
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
            $stats.quarantined++
        } else {
            Set-Content -LiteralPath $attemptsMarker -Value $attempts
            $note = "$note (attempt $attempts of $quarantineAfterFailures before quarantine)"
        }
    }

    Add-Row $job @{
        Timestamp = (Get-Date -Format "o"); File = $arw.Name; Status = $status; ExitCode = $exitCode
        DurationSec = [math]::Round($seconds, 2); ISO = $job.Base.ISO
        Profile = [System.IO.Path]::GetFileNameWithoutExtension($job.Base.ProfilePath); Preset = $presetLabel
        OutputPath = $job.OutFile; Note = $note
    }

    if ($status -eq "Failed") {
        Write-Host "  FAILED: $note" -ForegroundColor Red
        Write-PipelineEvent "file_failed" @{ file = $arw.FullName; index = $job.Index; total = $fileTotal; note = $note; quarantined = ($note -match "quarantined") }
    } else {
        Write-PipelineEvent "file_completed" @{ file = $arw.FullName; index = $job.Index; total = $fileTotal; output = $job.OutFile; durationSec = [math]::Round($seconds, 2) }
    }
}

function Get-JobArgs($job, [string[]]$Inputs, [string]$Out) {
    return Build-RTArgs -Mode final -Base $job.Base.ProfilePath -FormatOverlay $job.Base.FormatOverlayPath -AiOverlay $job.AiOverlay `
        -Preset $presetPath -Inputs $Inputs -Out $Out -Quality $Quality
}

# The Version 1 path: one rawtherapee-cli process for one file.
function Invoke-SingleFileJob($job) {
    Resolve-JobProfiles $job
    Write-StartLine $job
    $rtArgs = Get-JobArgs $job @($job.Arw.FullName) $job.OutFile

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
    } elseif (-not (Test-Path -LiteralPath $job.OutFile)) {
        $status = "Failed"
        $note = "no output file was created"
    }
    Complete-FileJob $job $status $note $exitCode $sw.Elapsed.TotalSeconds
}

$rowsByIndex = @{}
$jobs = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $arwFiles.Count; $i++) { $jobs.Add((New-FileJob $arwFiles[$i] $i)) }

if (-not $useBatch) {
    foreach ($job in $jobs) {
        if (Test-Path -LiteralPath $job.OutFile) { Write-Skipped $job; continue }
        Invoke-SingleFileJob $job
    }
} else {
    # 1. Idempotency check first (today's rule), then group the rest by profile signature.
    $todo = New-Object System.Collections.Generic.List[object]
    foreach ($job in $jobs) {
        if (Test-Path -LiteralPath $job.OutFile) { Write-Skipped $job; continue }
        Resolve-JobProfiles $job
        $job.Signature = Get-BatchSignature -ProfileStack (Get-RTProfileStack (Get-JobArgs $job @("x") "x")) -OutSubdir $job.OutSubdir -Mode "final"
        $todo.Add($job)
    }
    # 2. Split each signature group into batches (unique stems, maxBatchSize, maxCommandChars).
    $batches = Split-IntoBatches -Jobs $todo -MaxBatchSize $maxBatchSize -MaxCommandChars $maxCommandChars -RTPath $RTPath `
        -ArgsFor { param($group, $tempDir) Get-JobArgs $group[0] @($group | ForEach-Object { $_.Arw.FullName }) $tempDir } `
        -TempDirFor { param($j) Join-Path $j.OutSubdir ".rt_batch_00000000000000000000000000000000" }

    $batchNo = 0
    foreach ($batchIn in $batches) {
        $batchNo++
        # Re-check the idempotency rule at batch start: two inputs that map to the same output
        # name (possible when files flatten into one folder) behave as in Version 1 - the later
        # one is skipped once the earlier one exists.
        $batch = @($batchIn | Where-Object { if (Test-Path -LiteralPath $_.OutFile) { Write-Skipped $_; $false } else { $true } })
        if ($batch.Count -eq 0) { continue }
        if ($batch.Count -eq 1) { Invoke-SingleFileJob $batch[0]; continue }
        # 3. One call per batch into a fresh temp folder; each finished output is moved to its
        #    final name as soon as it is complete.
        $tempDir = Join-Path $batch[0].OutSubdir (".rt_batch_" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
        $rtArgs = Get-JobArgs $batch[0] @($batch | ForEach-Object { $_.Arw.FullName }) $tempDir
        Write-Host "Batch $batchNo of $($batches.Count): $($batch.Count) files in one RawTherapee call"
        Write-PipelineEvent "batch_started" @{ batch = $batchNo; tempDir = $tempDir; indexes = @($batch | ForEach-Object { $_.Index }) }

        $batchState = @{ Next = 0; LastMark = [System.Diagnostics.Stopwatch]::StartNew(); Done = @{} }
        Write-StartLine $batch[0]
        $onReady = {
            param([string]$stem)
            $j = $null
            foreach ($b in $batch) { if ($b.Arw.BaseName -ieq $stem) { $j = $b } }
            if (-not $j -or $batchState.Done.ContainsKey($j.Index)) { return }
            $src = Join-Path $tempDir "$stem.jpg"
            Move-Item -LiteralPath $src -Destination $j.OutFile -Force
            $secs = $batchState.LastMark.Elapsed.TotalSeconds
            $batchState.LastMark.Restart()
            $batchState.Done[$j.Index] = $true
            Complete-FileJob $j "Processed" "" 0 $secs
            # Next file in input order that isn't finished yet = the one now rendering.
            foreach ($b in $batch) { if (-not $batchState.Done.ContainsKey($b.Index)) { Write-StartLine $b; break } }
        }
        $res = Invoke-RawTherapeeBatch -RTPath $RTPath -RTArgs $rtArgs -TempDir $tempDir `
            -Stems @($batch | ForEach-Object { $_.Arw.BaseName }) -ProgressSource $progressSource -OnFileReady $onReady
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath "$tempDir.stdout.txt", "$tempDir.stderr.txt" -Force -ErrorAction SilentlyContinue

        # 4. Fault isolation: anything the batch didn't produce is retried ALONE through the
        #    Version 1 path (attempt markers + quarantine exactly as before).
        foreach ($j in $batch) {
            if ($batchState.Done.ContainsKey($j.Index)) { continue }
            Write-Host "  Batch produced no output for $($j.Arw.Name) - retrying it on its own"
            Invoke-SingleFileJob $j
        }
    }
}

$rows = New-Object System.Collections.Generic.List[object]
foreach ($k in ($rowsByIndex.Keys | Sort-Object)) { $rows.Add($rowsByIndex[$k]) }
$processed = $stats.processed; $skipped = $stats.skipped; $failed = $stats.failed; $quarantined = $stats.quarantined

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
Write-PipelineEvent "summary" @{ processed = $processed; skipped = $skipped; failed = $failed; quarantined = $quarantined; totalSec = [math]::Round($totalSw.Elapsed.TotalSeconds, 1); log = $logFile }

if ($failed -gt 0) { exit 1 } else { exit 0 }
