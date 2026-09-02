<#
  Renders one example raw photo through the base color-correction profile alone, then through
  each preset in presets/ stacked on top, so you can compare "looks" side by side before
  picking one for a whole shoot. Writes JPEGs + an index.html gallery to -OutputDir.

  Prints "Rendering <label>..." / "Rendered <label>" / "FAILED rendering <label> (exit N)" as
  each render starts/finishes (in whatever order they actually finish - see below) so a caller
  (e.g. the web UI backend) can parse stdout to show incremental progress. The caller matches
  these lines by label, not by position, so out-of-order completion from concurrent rendering is
  fine.

  Speed, revised after measuring real numbers against this pipeline (see docs/gpu_spike_findings.md
  and V6_PLAN.md's "preview speed" item): a plain resize-only pp3 override barely helped (~30%),
  because RawTherapee resizes at the *end* of its pipeline - demosaic/denoise/sharpen still run
  at full sensor resolution regardless of output size. What actually measured well, combined:

  - `-f` (fast-export: bypasses sharpening/denoise/defringe/wavelet, forces the fastest demosaic)
    - measured ~30-40% faster here specifically *when combined with an explicit resize override*
    (see below). On its own, without the resize override, -f's own built-in resize doesn't apply
    on this RawTherapee build (a known bug, still true) so it used to give no benefit while still
    hurting quality - that's still correct for auto_enhance.ps1's production path, which does NOT
    use -f. It's fine here because quality doesn't matter for a preview grid, per its own purpose.
  - `profiles/preview_fast_resize.pp3`: an explicit [Resize] pp3 override (Scale=0.15, confirmed
    via a real render that RawTherapee honors it correctly even under -f, ~6000x4000 -> ~900x600),
    stacked as the *last* -p layer so it can't be overridden by a preset (presets never touch
    [Resize] - see the main README's Presets section).
  - Rendering up to -MaxConcurrency presets at once (default 3) instead of strictly one at a
    time - measured real, if sub-linear, throughput gains on this machine's 4 physical cores.

  Net effect measured: ~18.5s/render sequential, full quality -> ~6s/render-equivalent throughput
  with all three combined. That's a real ~3x win, not the "under a minute total" originally hoped
  for - RAW demosaic cost scales with sensor resolution, which none of the above actually reduces
  before the expensive stages run. Documented honestly rather than claimed as more than it is.

  Uses RawTherapee's -q (quick-start) flag too, which skips loading cached files at startup for a
  small (~3-5%), zero-quality-cost time saving, independent of everything above.
#>
[CmdletBinding()]
param(
    [string]$SourceFile,
    [string]$OutputDir,
    [string]$RTPath,
    [string]$ProfilePath,
    [string]$Profile,
    [Nullable[int]]$Quality,
    [string]$ConfigPath,
    [int]$MaxConcurrency = 3
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib_common.ps1")
$RepoRoot = Get-RepoRoot

function Fail($message) {
    Write-Host "ERROR: $message" -ForegroundColor Red
    exit 1
}

# Start-Process -ArgumentList <array> does NOT reliably quote elements containing spaces on
# Windows PowerShell 5.1: a source path like "C:\Users\me\My Photos\x.arw" reaches RawTherapee
# split into separate tokens, so it opens nothing and writes no output file - every preview tile
# then fails with "no output file" (auto_enhance.ps1 avoids this by using `& $RTPath @args`, but
# that pattern can't drive the concurrent redirected processes this script needs). Pre-join into
# one correctly-quoted command-line string instead. None of the args here end in a backslash
# (paths end in .arw/.jpg/.pp3), so a plain wrapping quote is sufficient - no \" edge case.
function ConvertTo-ArgLine([string[]]$Argv) {
    ($Argv | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
}

if (-not $ConfigPath) { $ConfigPath = Join-Path $RepoRoot "config\config.json" }
$config = Read-EnhanceConfig $ConfigPath

if (-not $RTPath) { $RTPath = $config.rtPath }
$RTPath = Resolve-RTPath $RTPath
if (-not $Quality) { $Quality = if ($config.quality) { $config.quality } else { 95 } }
if (-not $OutputDir) { $OutputDir = Join-Path $RepoRoot "preview" }

if (-not (Test-Path -LiteralPath $RTPath)) { Fail "RawTherapee CLI not found: $RTPath" }

if (-not $SourceFile) {
    $first = Get-ChildItem -LiteralPath $RepoRoot -File | Where-Object { Test-IsRawFile $_ } | Select-Object -First 1
    if (-not $first) { Fail "No raw photo found to preview (looked for: $($SupportedRawExtensions -join ', ')). Pass -SourceFile <path>." }
    $SourceFile = $first.FullName
}
if (-not (Test-Path -LiteralPath $SourceFile)) { Fail "Source file not found: $SourceFile" }
$sourceItem = Get-Item -LiteralPath $SourceFile

$explicitProfileOverride = $PSBoundParameters.ContainsKey('ProfilePath') -or $PSBoundParameters.ContainsKey('Profile')
$baseCtx = Initialize-BaseProfileContext -RepoRoot $RepoRoot -config $config -ProfilePath $ProfilePath -Profile $Profile -ExplicitProfileOverride $explicitProfileOverride
$base = Get-BaseProfileForFile -ctx $baseCtx -file $sourceItem

$presetsDir = Join-Path $RepoRoot "presets"
$presetFiles = Get-ChildItem -LiteralPath $presetsDir -Filter "*.pp3" -File -ErrorAction SilentlyContinue | Sort-Object Name

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# See the file header for why: -f + this explicit resize override, stacked last so no preset can
# touch it, is what actually measured faster - a plain resize alone barely helped. Missing file
# degrades gracefully (renders full quality/speed, same as before this change existed) rather
# than failing the whole preview - this is a speed optimization, not a correctness requirement.
$fastResizePp3 = Join-Path $RepoRoot "profiles\preview_fast_resize.pp3"
$fastResizeAvailable = Test-Path -LiteralPath $fastResizePp3
if (-not $fastResizeAvailable) {
    Write-Host "NOTE: profiles\preview_fast_resize.pp3 not found - rendering at full quality/speed instead of the fast preview path." -ForegroundColor Yellow
}

function Build-RTArgs($label, $presetPath) {
    $outFile = Join-Path $OutputDir "$label.jpg"
    $rtArgs = @()
    if ($fastResizeAvailable) { $rtArgs += "-f" }
    $rtArgs += @("-p", $base.ProfilePath)
    if ($base.FormatOverlayPath) { $rtArgs += @("-p", $base.FormatOverlayPath) }
    if ($presetPath) { $rtArgs += @("-p", $presetPath) }
    if ($fastResizeAvailable) { $rtArgs += @("-p", $fastResizePp3) }
    $rtArgs += @("-o", $outFile, "-j$Quality", "-Y", "-q", "-c", $sourceItem.FullName)
    return [pscustomobject]@{ Label = $label; OutFile = $outFile; Args = $rtArgs }
}

$renderItems = New-Object System.Collections.Generic.List[object]
$renderItems.Add((Build-RTArgs "00_base_only" $null))
foreach ($p in $presetFiles) {
    $label = [System.IO.Path]::GetFileNameWithoutExtension($p.Name)
    $renderItems.Add((Build-RTArgs $label $p.FullName))
}

# Runs up to $MaxConcurrency RawTherapee processes at once instead of one at a time - see the
# file header for the measured speedup. Each process's stdout is captured to a temp file (rather
# than piped synchronously, which only works for one process at a time) so the same "Usage:"
# failure-detection the sequential version used still works per-process.
$stdoutDir = Join-Path $OutputDir "_stdout"
New-Item -ItemType Directory -Force -Path $stdoutDir | Out-Null

$queue = New-Object System.Collections.Generic.Queue[object]
foreach ($item in $renderItems) { $queue.Enqueue($item) }
$active = New-Object System.Collections.Generic.List[object]
$results = New-Object System.Collections.Generic.List[object]

while ($queue.Count -gt 0 -or $active.Count -gt 0) {
    while ($active.Count -lt $MaxConcurrency -and $queue.Count -gt 0) {
        $item = $queue.Dequeue()
        $stdoutFile = Join-Path $stdoutDir "$($item.Label).out.txt"
        $stderrFile = Join-Path $stdoutDir "$($item.Label).err.txt"
        Write-Host "Rendering $($item.Label)..."
        $proc = Start-Process -FilePath $RTPath -ArgumentList (ConvertTo-ArgLine $item.Args) -NoNewWindow -PassThru `
            -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        $active.Add([pscustomobject]@{ Process = $proc; Item = $item; StdoutFile = $stdoutFile; StderrFile = $stderrFile })
    }

    Start-Sleep -Milliseconds 150
    $stillRunning = New-Object System.Collections.Generic.List[object]
    foreach ($a in $active) {
        if ($a.Process.HasExited) {
            $a.Process.WaitForExit() # ensures redirected output is fully flushed before reading it
            # Deliberately does NOT check .ExitCode: measured unreliable here (returned $null even
            # for confirmed-successful renders - file existed, content valid - when polled via
            # -PassThru/HasExited across several concurrent redirected processes; a .NET/PowerShell
            # quirk in this specific pattern, not worth chasing further). Falls back to the same
            # two signals auto_enhance.ps1 already treats as authoritative for this exact reason
            # (see the main README's "Known RawTherapee CLI gotchas": exit code alone isn't fully
            # trustworthy here) - output file exists, and stdout doesn't contain RawTherapee's
            # "Usage:" banner (its signature for "silently printed help instead of rendering").
            $stdout = if (Test-Path -LiteralPath $a.StdoutFile) { Get-Content -LiteralPath $a.StdoutFile -Raw -ErrorAction SilentlyContinue } else { "" }
            $outFileExists = Test-Path -LiteralPath $a.Item.OutFile
            $ok = $outFileExists -and ($stdout -notmatch "Usage:")
            if ($ok) {
                Write-Host "Rendered $($a.Item.Label)"
            } else {
                # The web UI's server.js parses this exact "FAILED rendering <label> (" shape
                # (see its onLine handler) - the parenthetical's content isn't parsed, only its
                # presence is required, so it's free to carry a real reason instead of an exit code.
                $reason = if (-not $outFileExists) { "no output file" } else { "RawTherapee printed its usage/help text instead of rendering" }
                Write-Host "FAILED rendering $($a.Item.Label) ($reason)" -ForegroundColor Red
                # The per-process stdout/stderr files are deleted below, so echo what RawTherapee
                # actually said into this script's own stdout now - otherwise a caller (the web UI
                # server, or someone reading the console) sees "no output file" with zero clue why.
                # First failure only, to avoid 33 identical dumps when the cause is shared (e.g. a
                # bad source path) - every later tile prints just its one-line FAILED reason above.
                $stderr = if (Test-Path -LiteralPath $a.StderrFile) { Get-Content -LiteralPath $a.StderrFile -Raw -ErrorAction SilentlyContinue } else { "" }
                if (-not $script:diagShown) {
                    $script:diagShown = $true
                    Write-Host "  rt cmd: `"$RTPath`" $(ConvertTo-ArgLine $a.Item.Args)" -ForegroundColor DarkGray
                    $diag = (@($stdout, $stderr) -join "`n").Trim()
                    if ($diag) {
                        foreach ($l in (($diag -split "`r?`n") | Where-Object { $_ } | Select-Object -Last 10)) {
                            Write-Host "  rt> $l" -ForegroundColor DarkGray
                        }
                    } else {
                        Write-Host "  rt> (RawTherapee produced no stdout/stderr at all)" -ForegroundColor DarkGray
                    }
                }
            }
            $results.Add([pscustomobject]@{ Label = $a.Item.Label; OutFile = "$($a.Item.Label).jpg"; Ok = $ok })
        } else {
            $stillRunning.Add($a)
        }
    }
    $active = $stillRunning
}
Remove-Item -LiteralPath $stdoutDir -Recurse -Force -ErrorAction SilentlyContinue

$galleryItems = ($results | Where-Object { $_.Ok } | ForEach-Object {
    "<figure><img src=`"$($_.OutFile)`" alt=`"$($_.Label)`"><figcaption>$($_.Label)</figcaption></figure>"
}) -join "`n"

$html = @"
<!doctype html>
<html><head><meta charset="utf-8"><title>Preset preview - $($sourceItem.Name)</title>
<style>
  body { font-family: sans-serif; background:#111; color:#eee; margin:0; padding:24px; }
  h1 { font-size:16px; font-weight:normal; color:#aaa; }
  .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap:16px; }
  figure { margin:0; background:#1a1a1a; border-radius:6px; overflow:hidden; }
  img { width:100%; display:block; }
  figcaption { padding:8px; text-align:center; font-size:14px; }
</style>
</head><body>
<h1>Preset preview for $($sourceItem.Name) (base profile: $([System.IO.Path]::GetFileNameWithoutExtension($base.ProfilePath)))</h1>
<div class="grid">
$galleryItems
</div>
</body></html>
"@
$indexPath = Join-Path $OutputDir "index.html"
Set-Content -LiteralPath $indexPath -Value $html -Encoding UTF8

$okCount = ($results | Where-Object { $_.Ok }).Count
Write-Host ""
Write-Host "====================================="
Write-Host "Rendered: $okCount / $($results.Count)"
Write-Host "Gallery: $indexPath"
Write-Host "====================================="

if ($okCount -lt $results.Count) { exit 1 } else { exit 0 }
