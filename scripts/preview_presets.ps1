<#
  Renders one example raw photo through the base color-correction profile alone, then through
  each preset in presets/ stacked on top, so you can compare "looks" side by side before
  picking one for a whole shoot. Writes JPEGs + an index.html gallery to -OutputDir.

  Prints "Rendering <label>..." before each render so a caller (e.g. the web UI backend) can
  parse stdout to show incremental progress across the ~30 renders instead of one long wait.

  Uses RawTherapee's -q (quick-start) flag, which skips loading cached files at startup for a
  small (~3-5%), zero-quality-cost time saving. -f (fast-export) was tried and measured here:
  it bypasses sharpening/denoise/defringe/wavelet and forces the fastest demosaic algorithm,
  but on this machine/file it gave no measurable speedup (its resize step also didn't apply,
  matching a known RawTherapee CLI bug - output stayed full resolution either way) while still
  degrading quality, so it was NOT used. If a future RT version fixes that, it's worth
  re-measuring: -f only belongs here (throwaway comparison renders), never in the production
  run in auto_enhance.ps1.
#>
[CmdletBinding()]
param(
    [string]$SourceFile,
    [string]$OutputDir,
    [string]$RTPath,
    [string]$ProfilePath,
    [string]$Profile,
    [Nullable[int]]$Quality,
    [string]$ConfigPath
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

if (-not $RTPath) { $RTPath = $config.rtPath }
$RTPath = Resolve-RTPath $RTPath
if (-not $Quality) { $Quality = if ($config.quality) { $config.quality } else { 95 } }
if (-not $OutputDir) { $OutputDir = Join-Path $RepoRoot "preview" }

if (-not (Test-Path -LiteralPath $RTPath)) { Fail "RawTherapee CLI not found: $RTPath" }

if (-not $SourceFile) {
    $first = Get-ChildItem -LiteralPath $RepoRoot -Filter "*.arw" -File | Select-Object -First 1
    if (-not $first) { Fail "No .arw file found to preview. Pass -SourceFile <path>." }
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

function Invoke-RT($label, $presetPath) {
    $outFile = Join-Path $OutputDir "$label.jpg"
    $rtArgs = @("-p", $base.ProfilePath)
    if ($presetPath) { $rtArgs += @("-p", $presetPath) }
    $rtArgs += @("-o", $outFile, "-j$Quality", "-Y", "-q", "-c", $sourceItem.FullName)
    Write-Host "Rendering $label..."
    $stdout = & $RTPath @rtArgs | Out-String
    $exitCode = $LASTEXITCODE
    $ok = ($exitCode -eq 0) -and (Test-Path -LiteralPath $outFile) -and ($stdout -notmatch "Usage:")
    if ($ok) {
        Write-Host "Rendered $label"
    } else {
        Write-Host "FAILED rendering $label (exit $exitCode)" -ForegroundColor Red
    }
    return [pscustomobject]@{ Label = $label; OutFile = "$label.jpg"; Ok = $ok }
}

$results = New-Object System.Collections.Generic.List[object]
$results.Add((Invoke-RT "00_base_only" $null))
foreach ($p in $presetFiles) {
    $label = [System.IO.Path]::GetFileNameWithoutExtension($p.Name)
    $results.Add((Invoke-RT $label $p.FullName))
}

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
