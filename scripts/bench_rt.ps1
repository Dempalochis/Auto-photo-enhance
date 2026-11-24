<#
  Version 2, Phase 0: stand-alone RawTherapee benchmark + CLI behaviour check.
  Changes NOTHING in the production pipeline: it only reads profiles/presets and writes into
  -OutputDir (default: .webapp_cache/bench/<timestamp>/).

  Cases (each timed case runs -Runs times, the median is reported):
    A  Production final: today's stack (base [+ format overlay], -q), one process per file.
    B  Process start cost: (B1) `rawtherapee-cli` on an unreadable tiny file = start-up + profile/
       ICC load + immediate failure; (B2) the smallest sample with a 64 px resize override.
    C  Batch: the same N files in one `-c f1 f2 ...` call vs N single calls (final settings).
       Per-file difference = the real batching gain. GATE: batching worth it if >= 10 %.
    D  Current draft: -f + profiles/preview_fast_resize.pp3 (or draft_override.pp3 after Phase 1).
    E  Draft variants: E1 = D with Scale 0.25; E2 = no -f but explicit fast-demosaic / no-denoise
       override at Scale 0.15. GATE: does any variant beat D?
    F  Parallel: 2 and 3 concurrent final renders (throughput, files per minute).
    X  Behaviour (not timed): 5-file batch incl. one truncated file. Records what RawTherapee prints
       per file, whether those lines arrive live or in a burst at the end (pipe buffering),
       output naming with `-o <dir>`, and the exit code with one corrupt file.

  Output: results.json + results.md in -OutputDir, and a summary on the console with each gate.

  Usage (Windows):
    powershell -ExecutionPolicy Bypass -File scripts\bench_rt.ps1 -SamplesDir C:\photos\bench
    powershell -ExecutionPolicy Bypass -File scripts\bench_rt.ps1 -SamplesDir C:\photos\bench -Cases A,C -Runs 1

  Works on Windows PowerShell 5.1 and pwsh 7 (Linux too, for the dev container).
#>
[CmdletBinding()]
param(
    [string]$SamplesDir,
    [string[]]$Files,
    [int]$Runs = 3,
    [string[]]$Cases = @("A", "B", "C", "D", "E", "F", "X"),
    [int]$BatchSize = 5,
    [string]$RTPath,
    [string]$ConfigPath,
    [string]$OutputDir,
    [int]$MaxFilesPerCase = 0
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib_common.ps1")
# `-File` passes "A,C" as one string (no array parsing), so split it here.
$Cases = @($Cases | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object { $_ })
if ($Files) { $Files = @($Files | ForEach-Object { $_ -split ',' } | Where-Object { $_ }) }
$RepoRoot = Get-RepoRoot

function Fail($message) { Write-Host "ERROR: $message" -ForegroundColor Red; exit 1 }

if (-not $ConfigPath) { $ConfigPath = Join-Path $RepoRoot "config\config.json" }
$config = Read-EnhanceConfig $ConfigPath
if (-not $RTPath) { $RTPath = $config.rtPath }
$RTPath = Resolve-RTPath $RTPath
if (-not $RTPath -or -not (Test-Path -LiteralPath $RTPath)) {
    $onPath = Get-Command "rawtherapee-cli" -ErrorAction SilentlyContinue
    if ($onPath) { $RTPath = $onPath.Source } else { Fail "RawTherapee CLI not found: $RTPath" }
}

if (-not $SamplesDir) { $SamplesDir = Join-Path $RepoRoot "_samples" }
if ($Files -and $Files.Count -gt 0) {
    $sampleFiles = @($Files | ForEach-Object { Get-Item -LiteralPath $_ })
} else {
    if (-not (Test-Path -LiteralPath $SamplesDir)) { Fail "Samples folder not found: $SamplesDir" }
    $sampleFiles = @(Get-ChildItem -LiteralPath $SamplesDir -File | Where-Object { Test-IsRawFile $_ } | Sort-Object Name)
}
if ($sampleFiles.Count -eq 0) { Fail "No raw files found (looked in $SamplesDir)" }
if ($MaxFilesPerCase -gt 0 -and $sampleFiles.Count -gt $MaxFilesPerCase) { $sampleFiles = @($sampleFiles | Select-Object -First $MaxFilesPerCase) }

if (-not $OutputDir) { $OutputDir = Join-Path $RepoRoot (".webapp_cache\bench\" + (Get-Date -Format "yyyyMMdd_HHmmss")) }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$workDir = Join-Path $OutputDir "work"
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

$baseCtx = Initialize-BaseProfileContext -RepoRoot $RepoRoot -config $config -ProfilePath $null -Profile $null -ExplicitProfileOverride $false

# Draft profile: draft_override.pp3 once Phase 1 renamed it, preview_fast_resize.pp3 before.
$draftPp3 = Join-Path $RepoRoot "profiles\draft_override.pp3"
if (-not (Test-Path -LiteralPath $draftPp3)) { $draftPp3 = Join-Path $RepoRoot "profiles\preview_fast_resize.pp3" }

# Generated variant overlays (bench-only, live in the output folder, never in profiles/).
function Write-Pp3([string]$Path, [string]$Text) { Set-Content -LiteralPath $Path -Value $Text -Encoding ASCII; return $Path }
$resize025 = Write-Pp3 (Join-Path $OutputDir "bench_resize_025.pp3") "[Resize]`r`nEnabled=true`r`nScale=0.25`r`nAppliesTo=Full image`r`nMethod=Lanczos`r`nDataSpecified=0`r`nWidth=1500`r`nHeight=1500`r`n"
$resize64 = Write-Pp3 (Join-Path $OutputDir "bench_resize_64px.pp3") "[Resize]`r`nEnabled=true`r`nScale=0.01`r`nAppliesTo=Full image`r`nMethod=Nearest`r`nDataSpecified=0`r`nWidth=64`r`nHeight=64`r`n"
$explicitDraft = Write-Pp3 (Join-Path $OutputDir "bench_explicit_draft.pp3") (@(
    "[RAW Bayer]", "Method=fast", "", "[RAW X-Trans]", "Method=fast", "",
    "[Directional Pyramid Denoising]", "Enabled=false", "", "[Sharpening]", "Enabled=false", "",
    "[Defringing]", "Enabled=false", "", "[Wavelet]", "Enabled=false", "",
    "[Resize]", "Enabled=true", "Scale=0.15", "AppliesTo=Full image", "Method=Lanczos", "DataSpecified=0", "Width=900", "Height=900", ""
) -join "`r`n")

function ConvertTo-ArgLine([string[]]$Argv) {
    ($Argv | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
}

function Get-StackArgs([System.IO.FileInfo]$File, [string[]]$Extra) {
    $base = Get-BaseProfileForFile -ctx $baseCtx -file $File
    $a = @("-p", $base.ProfilePath)
    if ($base.FormatOverlayPath) { $a += @("-p", $base.FormatOverlayPath) }
    if ($Extra) { foreach ($e in $Extra) { $a += @("-p", $e) } }
    return $a
}

<#
  Runs rawtherapee-cli once, reading stdout line by line through a pipe (exactly what a batch
  progress reader would see) and timestamping every line relative to process start.
  Returns { Ms, ExitCode, Lines = @({ Ms; Text }), Stderr }.
#>
function Invoke-RTTimed([string[]]$RTArgs) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $RTPath
    $psi.Arguments = ConvertTo-ArgLine $RTArgs
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $p = [System.Diagnostics.Process]::Start($psi)
    $errTask = $p.StandardError.ReadToEndAsync()
    $lines = New-Object System.Collections.Generic.List[object]
    while ($null -ne ($line = $p.StandardOutput.ReadLine())) {
        $lines.Add([pscustomobject]@{ Ms = [math]::Round($sw.Elapsed.TotalMilliseconds); Text = $line })
    }
    $p.WaitForExit()
    $sw.Stop()
    return [pscustomobject]@{ Ms = [math]::Round($sw.Elapsed.TotalMilliseconds); ExitCode = $p.ExitCode; Lines = $lines; Stderr = $errTask.Result }
}

function Get-Median([double[]]$Values) {
    if (-not $Values -or $Values.Count -eq 0) { return $null }
    $s = @($Values | Sort-Object)
    $n = $s.Count
    if ($n % 2 -eq 1) { return [math]::Round($s[($n - 1) / 2], 0) }
    return [math]::Round(($s[$n / 2 - 1] + $s[$n / 2]) / 2, 0)
}

function New-CaseDir([string]$Name) {
    $d = Join-Path $workDir $Name
    if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    return $d
}

# One render per file per run; returns per-file medians and the overall median.
function Measure-PerFile([string]$CaseName, [scriptblock]$ArgsFor) {
    $perFile = @()
    foreach ($f in $sampleFiles) {
        $times = @()
        $exit = $null
        for ($r = 1; $r -le $Runs; $r++) {
            $dir = New-CaseDir "$CaseName"
            $out = Join-Path $dir "$($f.BaseName).jpg"
            $res = Invoke-RTTimed (& $ArgsFor $f $out)
            $exit = $res.ExitCode
            if ($res.ExitCode -eq 0 -and (Test-Path -LiteralPath $out)) { $times += $res.Ms }
        }
        $size = if (Test-Path -LiteralPath $out) { (Get-Item -LiteralPath $out).Length } else { 0 }
        $perFile += [pscustomobject]@{ File = $f.Name; MedianMs = (Get-Median $times); Runs = $times.Count; ExitCode = $exit; OutBytes = $size }
        Write-Host ("  {0,-4} {1,-28} {2,8} ms  (ok runs {3}/{4})" -f $CaseName, $f.Name, (Get-Median $times), $times.Count, $Runs)
    }
    $ok = @($perFile | Where-Object { $null -ne $_.MedianMs } | ForEach-Object { [double]$_.MedianMs })
    return [pscustomobject]@{ Case = $CaseName; PerFile = $perFile; MedianMs = (Get-Median $ok) }
}

$results = [ordered]@{
    generatedAt   = (Get-Date -Format "o")
    platform      = if ($PSVersionTable.Platform) { "$($PSVersionTable.Platform)" } else { "Win32NT" }
    os            = [System.Environment]::OSVersion.VersionString
    psVersion     = $PSVersionTable.PSVersion.ToString()
    cpuCount      = [System.Environment]::ProcessorCount
    rtPath        = $RTPath
    rtVersion     = ((& $RTPath -v 2>&1 | Out-String) -split "`r?`n" | Where-Object { $_ -match "version" } | Select-Object -First 1)
    runs          = $Runs
    files         = @($sampleFiles | ForEach-Object { $_.Name })
    draftProfile  = [System.IO.Path]::GetFileName($draftPp3)
    cases         = [ordered]@{}
    gates         = [ordered]@{}
}
Write-Host "Benchmark: $($sampleFiles.Count) file(s), $Runs run(s) each, RawTherapee: $RTPath"
Write-Host "Output: $OutputDir"

$finalArgs = { param($f, $out) (Get-StackArgs $f @()) + @("-o", $out, "-j95", "-Y", "-q", "-c", $f.FullName) }
$draftArgs = { param($f, $out) @("-f") + (Get-StackArgs $f @($draftPp3)) + @("-o", $out, "-j95", "-Y", "-q", "-c", $f.FullName) }

if ($Cases -contains "A") {
    Write-Host "`n[A] production final, one process per file"
    $results.cases.A = Measure-PerFile "A" $finalArgs
}

if ($Cases -contains "B") {
    Write-Host "`n[B] process start cost"
    $bDir = New-CaseDir "B"
    $junk = Join-Path $bDir "unreadable.arw"
    [System.IO.File]::WriteAllBytes($junk, [byte[]](1..4096 | ForEach-Object { $_ % 251 }))
    $t1 = @()
    for ($r = 1; $r -le $Runs; $r++) {
        $res = Invoke-RTTimed (@("-p", $baseCtx.StaticProfilePath, "-o", (Join-Path $bDir "unreadable.jpg"), "-j95", "-Y", "-q", "-c", $junk))
        $t1 += $res.Ms
    }
    $smallest = $sampleFiles | Sort-Object Length | Select-Object -First 1
    $t2 = @()
    for ($r = 1; $r -le $Runs; $r++) {
        $out = Join-Path $bDir "tiny.jpg"
        $res = Invoke-RTTimed ((Get-StackArgs $smallest @($resize64)) + @("-f", "-o", $out, "-j95", "-Y", "-q", "-c", $smallest.FullName))
        if ($res.ExitCode -eq 0) { $t2 += $res.Ms }
    }
    $results.cases.B = [pscustomobject]@{ Case = "B"; StartupFailMs = (Get-Median $t1); Tiny64pxMs = (Get-Median $t2); Tiny64pxFile = $smallest.Name }
    Write-Host "  B1 start-up + profile load + fail: $(Get-Median $t1) ms"
    Write-Host "  B2 smallest file ($($smallest.Name)) at 64 px, -f: $(Get-Median $t2) ms"
}

if ($Cases -contains "C") {
    Write-Host "`n[C] batch (one -c call) vs single calls, $BatchSize files, final settings"
    $batchFiles = @($sampleFiles | Select-Object -First $BatchSize)
    # The batch needs a shared -p stack: use the static base profile for every file (no ISO
    # branching, no format overlay) on both sides, so the comparison is like for like.
    $stack = @("-p", $baseCtx.StaticProfilePath)
    $single = @(); $batch = @()
    for ($r = 1; $r -le $Runs; $r++) {
        $dir = New-CaseDir "C_single"
        $sum = 0
        foreach ($f in $batchFiles) {
            $res = Invoke-RTTimed ($stack + @("-o", (Join-Path $dir "$($f.BaseName).jpg"), "-j95", "-Y", "-q", "-c", $f.FullName))
            $sum += $res.Ms
        }
        $single += $sum
        $dir = New-CaseDir "C_batch"
        $res = Invoke-RTTimed ($stack + @("-o", $dir, "-j95", "-Y", "-q", "-c") + @($batchFiles | ForEach-Object { $_.FullName }))
        $batch += $res.Ms
        Write-Host ("  run {0}: {1} singles = {2} ms, one batch = {3} ms" -f $r, $batchFiles.Count, $sum, $res.Ms)
    }
    $ms = Get-Median $single; $mb = Get-Median $batch
    $n = [math]::Max(1, $batchFiles.Count)
    $gain = if ($ms -gt 0) { [math]::Round(100.0 * ($ms - $mb) / $ms, 1) } else { $null }
    $results.cases.C = [pscustomobject]@{ Case = "C"; Files = $batchFiles.Count; SinglesTotalMs = $ms; BatchTotalMs = $mb; PerFileSingleMs = [math]::Round($ms / $n); PerFileBatchMs = [math]::Round($mb / $n); GainPercent = $gain }
    $results.gates.batching = [pscustomobject]@{ rule = "go if C saves >= 10% per file"; gainPercent = $gain; verdict = if ($null -ne $gain -and $gain -ge 10) { "GO (set batchRender: true)" } else { "NO-GO (keep batchRender: false)" } }
}

if ($Cases -contains "D") {
    Write-Host "`n[D] current draft: -f + $([System.IO.Path]::GetFileName($draftPp3))"
    $results.cases.D = Measure-PerFile "D" $draftArgs
}

if ($Cases -contains "E") {
    Write-Host "`n[E1] draft at Scale 0.25"
    $results.cases.E1 = Measure-PerFile "E1" { param($f, $out) @("-f") + (Get-StackArgs $f @($resize025)) + @("-o", $out, "-j95", "-Y", "-q", "-c", $f.FullName) }
    Write-Host "`n[E2] no -f, explicit fast demosaic / no denoise / Scale 0.15"
    $results.cases.E2 = Measure-PerFile "E2" { param($f, $out) (Get-StackArgs $f @($explicitDraft)) + @("-o", $out, "-j95", "-Y", "-q", "-c", $f.FullName) }
}

if ($results.cases.Contains("D")) {
    $d = $results.cases.D.MedianMs
    $best = "D"; $bestMs = $d
    foreach ($k in @("E1", "E2")) {
        if ($results.cases.Contains($k) -and $null -ne $results.cases[$k].MedianMs -and $results.cases[$k].MedianMs -lt $bestMs * 0.9) { $best = $k; $bestMs = $results.cases[$k].MedianMs }
    }
    $results.gates.draftProfile = [pscustomobject]@{
        rule = "a variant replaces D only if >= 10% faster"; D = $d
        E1 = if ($results.cases.Contains("E1")) { $results.cases.E1.MedianMs } else { $null }
        E2 = if ($results.cases.Contains("E2")) { $results.cases.E2.MedianMs } else { $null }
        verdict = if ($best -eq "D") { "keep D (-f + Scale 0.15)" } else { "consider $best" }
        draftLatencyMs = $bestMs
    }
}

if ($Cases -contains "F") {
    Write-Host "`n[F] parallel final renders (throughput)"
    $fFiles = @($sampleFiles | Select-Object -First 6)
    $fRes = [ordered]@{}
    foreach ($conc in @(1, 2, 3)) {
        $dir = New-CaseDir "F_$conc"
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $queue = New-Object System.Collections.Generic.Queue[object]
        foreach ($f in $fFiles) { $queue.Enqueue($f) }
        $active = New-Object System.Collections.Generic.List[object]
        while ($queue.Count -gt 0 -or $active.Count -gt 0) {
            while ($active.Count -lt $conc -and $queue.Count -gt 0) {
                $f = $queue.Dequeue()
                $argv = (Get-StackArgs $f @()) + @("-o", (Join-Path $dir "$($f.BaseName).jpg"), "-j95", "-Y", "-q", "-c", $f.FullName)
                $p = Start-Process -FilePath $RTPath -ArgumentList (ConvertTo-ArgLine $argv) -NoNewWindow -PassThru `
                    -RedirectStandardOutput (Join-Path $dir "$($f.BaseName).out.txt") -RedirectStandardError (Join-Path $dir "$($f.BaseName).err.txt")
                $active.Add($p)
            }
            Start-Sleep -Milliseconds 100
            $still = New-Object System.Collections.Generic.List[object]
            foreach ($p in $active) { if (-not $p.HasExited) { $still.Add($p) } }
            $active = $still
        }
        $sw.Stop()
        $perMin = [math]::Round($fFiles.Count / $sw.Elapsed.TotalMinutes, 2)
        $fRes["c$conc"] = [pscustomobject]@{ Concurrency = $conc; Files = $fFiles.Count; WallMs = [math]::Round($sw.Elapsed.TotalMilliseconds); FilesPerMinute = $perMin }
        Write-Host ("  concurrency {0}: {1} files in {2} ms = {3} files/min" -f $conc, $fFiles.Count, [math]::Round($sw.Elapsed.TotalMilliseconds), $perMin)
    }
    $results.cases.F = $fRes
    $bestC = ($fRes.Values | Sort-Object FilesPerMinute -Descending | Select-Object -First 1).Concurrency
    $results.gates.renderLimiter = [pscustomobject]@{ rule = "default max concurrent renders while a run is active"; bestConcurrency = $bestC; c1 = $fRes.c1.FilesPerMinute; c2 = $fRes.c2.FilesPerMinute; c3 = $fRes.c3.FilesPerMinute }
}

if ($Cases -contains "X") {
    Write-Host "`n[X] behaviour: $BatchSize-file batch with one truncated file"
    $xDir = New-CaseDir "X"
    $inDir = Join-Path $xDir "in"; $outDir = Join-Path $xDir "out"
    New-Item -ItemType Directory -Force -Path $inDir, $outDir | Out-Null
    $goodFiles = @($sampleFiles | Select-Object -First ([math]::Max(1, $BatchSize - 1)))
    $inputs = @()
    $i = 0
    foreach ($f in $goodFiles) {
        $inputs += $f.FullName
        $i++
        if ($i -eq 2) {
            # A truncated copy of a real raw (first 50 KB): the header parses, the data is gone.
            $trunc = Join-Path $inDir "truncated_$($f.Name)"
            $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
            [System.IO.File]::WriteAllBytes($trunc, $bytes[0..([math]::Min(51199, $bytes.Length - 1))])
            $inputs += $trunc
        }
    }
    $res = Invoke-RTTimed (@("-p", $baseCtx.StaticProfilePath, "-p", $draftPp3, "-f", "-o", $outDir, "-j95", "-Y", "-q", "-c") + $inputs)
    $processing = @($res.Lines | Where-Object { $_.Text -match '^Processing: ' })
    $spreadMs = if ($processing.Count -ge 2) { $processing[-1].Ms - $processing[0].Ms } else { 0 }
    # Live if the per-file lines are spread over most of the run; a burst puts them all at the end.
    $live = ($processing.Count -ge 2) -and ($spreadMs -ge 0.4 * $res.Ms)
    $outputs = @(Get-ChildItem -LiteralPath $outDir -File | ForEach-Object { $_.Name })
    $results.cases.X = [pscustomobject]@{
        Inputs = @($inputs | ForEach-Object { [System.IO.Path]::GetFileName($_) })
        ExitCode = $res.ExitCode; TotalMs = $res.Ms
        PerFileLinePattern = "Processing: <full input path>"
        ErrorLines = @($res.Lines | Where-Object { $_.Text -match 'Error' } | ForEach-Object { $_.Text })
        ProcessingLineTimesMs = @($processing | ForEach-Object { $_.Ms })
        StdoutArrivesLive = $live
        OutputNames = $outputs
        Timeline = @($res.Lines | ForEach-Object { "{0,7} ms  {1}" -f $_.Ms, $_.Text })
    }
    $results.gates.progressSource = [pscustomobject]@{
        rule = "stdout if per-file lines arrive live through a pipe, else outputFolder"
        stdoutArrivesLive = $live
        verdict = if ($live) { "stdout works on this machine (outputFolder stays the safe default)" } else { "outputFolder (stdout is buffered)" }
    }
    Write-Host "  exit code: $($res.ExitCode); outputs: $($outputs -join ', ')"
    Write-Host "  'Processing:' lines at ms: $(@($processing | ForEach-Object { $_.Ms }) -join ', ') of $($res.Ms) ms -> live: $live"
}

if ($results.cases.Contains("A") -and $results.cases.Contains("B") -and $results.cases.A.MedianMs) {
    $share = [math]::Round(100.0 * $results.cases.B.StartupFailMs / $results.cases.A.MedianMs, 1)
    $results.gates.startupShare = [pscustomobject]@{ rule = "batching only pays if start-up >= 10% of a final render"; startupMs = $results.cases.B.StartupFailMs; finalMs = $results.cases.A.MedianMs; sharePercent = $share }
}

# ---- report ----
$jsonPath = Join-Path $OutputDir "results.json"
$results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$md = New-Object System.Collections.Generic.List[string]
$md.Add("# bench_rt.ps1 results")
$md.Add("")
$md.Add("- Generated: $($results.generatedAt)")
$md.Add("- Platform: $($results.platform) / $($results.os) / PowerShell $($results.psVersion) / $($results.cpuCount) logical CPUs")
$md.Add("- RawTherapee: $($results.rtVersion) ($RTPath)")
$md.Add("- Files: $($results.files -join ', '); runs per case: $Runs (median reported)")
$md.Add("")
$md.Add("| Case | Median ms |")
$md.Add("|---|---|")
foreach ($k in @("A", "D", "E1", "E2")) { if ($results.cases.Contains($k)) { $md.Add("| $k | $($results.cases[$k].MedianMs) |") } }
if ($results.cases.Contains("B")) { $md.Add("| B1 start-up + fail | $($results.cases.B.StartupFailMs) |"); $md.Add("| B2 64 px render | $($results.cases.B.Tiny64pxMs) |") }
if ($results.cases.Contains("C")) { $c = $results.cases.C; $md.Add("| C per file, single calls | $($c.PerFileSingleMs) |"); $md.Add("| C per file, one batch | $($c.PerFileBatchMs) |") }
if ($results.cases.Contains("F")) { foreach ($v in $results.cases.F.Values) { $md.Add("| F concurrency $($v.Concurrency) | $($v.WallMs) wall, $($v.FilesPerMinute) files/min |") } }
$md.Add("")
$md.Add("## Gates")
foreach ($g in $results.gates.Keys) { $md.Add("- **$g**: " + (($results.gates[$g].PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join "; ")) }
if ($results.cases.Contains("X")) {
    $md.Add("")
    $md.Add("## Behaviour (case X)")
    $md.Add("- Exit code with one truncated file: $($results.cases.X.ExitCode)")
    $md.Add("- Output names: $($results.cases.X.OutputNames -join ', ')")
    $md.Add("- Stdout arrives live: $($results.cases.X.StdoutArrivesLive)")
    $md.Add("")
    $md.Add('```')
    foreach ($l in $results.cases.X.Timeline) { $md.Add($l) }
    $md.Add('```')
}
$mdPath = Join-Path $OutputDir "results.md"
$md -join "`r`n" | Set-Content -LiteralPath $mdPath -Encoding UTF8

Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "====================================="
foreach ($g in $results.gates.Keys) {
    $v = $results.gates[$g]
    $verdict = if ($v.PSObject.Properties.Name -contains "verdict") { $v.verdict } else { ($v.PSObject.Properties | Where-Object { $_.Name -ne "rule" } | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join " " }
    Write-Host ("GATE {0,-14} {1}" -f $g, $verdict)
}
Write-Host "Results: $mdPath"
Write-Host "====================================="
