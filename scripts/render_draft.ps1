<#
  Version 2 Phase 4: draft renders for the AI analysis (and the Phase 5/6 review and refine
  images). Uses the same argument builder as every other render (lib_common.ps1 Build-RTArgs
  -Mode draft): base profile (ISO-branched) -> format overlay -> optional AI overlay ->
  draft_override.pp3, with -f.

  -JobsJson <file>: JSON array of { "source": "<raw>", "out": "<jpg>", "aiOverlay": "<pp3>"|null }.
  Renders them one after another (one RawTherapee process at a time: the analyze lane's render
  limit), printing, per job:
    Draft <n>/<N> <name> ok|FAILED (...)
    @@EVENT {"event":"draft_completed"|"draft_failed","index":i,"out":"...","note":"..."}   (with -EmitEvents)
  An existing output is reused (skipped) unless -Force.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$JobsJson,
    [string]$RTPath,
    [string]$ConfigPath,
    [Nullable[int]]$Quality,
    [switch]$EmitEvents,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib_common.ps1")
$RepoRoot = Get-RepoRoot
Enable-PipelineEvents $EmitEvents.IsPresent

function Fail($message) { Write-Host "ERROR: $message" -ForegroundColor Red; exit 1 }

if (-not $ConfigPath) { $ConfigPath = Join-Path $RepoRoot "config\config.json" }
$config = Read-EnhanceConfig $ConfigPath
if (-not $RTPath) { $RTPath = $config.rtPath }
$RTPath = Resolve-RTPath $RTPath
if (-not (Test-Path -LiteralPath $RTPath)) { Fail "RawTherapee CLI not found: $RTPath" }
if (-not $Quality) { $Quality = 90 }
if (-not (Test-Path -LiteralPath $JobsJson)) { Fail "Jobs file not found: $JobsJson" }
try { $jobs = @(Get-Content -LiteralPath $JobsJson -Raw | ConvertFrom-Json) } catch { Fail "Failed to parse -JobsJson: $_" }

$baseCtx = Initialize-BaseProfileContext -RepoRoot $RepoRoot -config $config -ProfilePath $null -Profile $null -ExplicitProfileOverride $false
$draftOverride = Get-DraftOverridePath $RepoRoot

$ok = 0
for ($i = 0; $i -lt $jobs.Count; $i++) {
    $j = $jobs[$i]
    $label = "Draft $($i + 1)/$($jobs.Count) $([System.IO.Path]::GetFileName($j.source))"
    if (-not $Force -and (Test-Path -LiteralPath $j.out)) {
        Write-Host "$label ok (cached)"
        Write-PipelineEvent "draft_completed" @{ index = $i; out = $j.out; cached = $true }
        $ok++
        continue
    }
    if (-not (Test-Path -LiteralPath $j.source)) {
        Write-Host "$label FAILED (source not found)" -ForegroundColor Red
        Write-PipelineEvent "draft_failed" @{ index = $i; note = "source not found" }
        continue
    }
    $item = Get-Item -LiteralPath $j.source
    $base = Get-BaseProfileForFile -ctx $baseCtx -file $item
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $j.out) | Out-Null
    $tmpOut = "$($j.out).part.jpg"
    $rtArgs = Build-RTArgs -Mode draft -Base $base.ProfilePath -FormatOverlay $base.FormatOverlayPath -AiOverlay $j.aiOverlay `
        -DraftOverride $draftOverride -Inputs @($item.FullName) -Out $tmpOut -Quality $Quality
    $r = Invoke-RawTherapee -RTPath $RTPath -RTArgs $rtArgs
    if ($r.ExitCode -eq 0 -and $r.Stdout -notmatch "Usage:" -and (Test-Path -LiteralPath $tmpOut)) {
        Move-Item -LiteralPath $tmpOut -Destination $j.out -Force
        Write-Host "$label ok"
        Write-PipelineEvent "draft_completed" @{ index = $i; out = $j.out; iso = $base.ISO; profile = [System.IO.Path]::GetFileNameWithoutExtension($base.ProfilePath) }
        $ok++
    } else {
        Remove-Item -LiteralPath $tmpOut -Force -ErrorAction SilentlyContinue
        $note = if ($r.Stdout -match "Usage:") { "RawTherapee printed its help text" } else { "rawtherapee-cli exited with code $($r.ExitCode)" }
        Write-Host "$label FAILED ($note)" -ForegroundColor Red
        Write-PipelineEvent "draft_failed" @{ index = $i; note = $note }
    }
}
Write-Host "Drafts rendered: $ok / $($jobs.Count)"
if ($ok -lt $jobs.Count) { exit 1 } else { exit 0 }
