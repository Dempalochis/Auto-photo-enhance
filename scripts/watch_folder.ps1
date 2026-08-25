<#
  Polls a folder for new raw photos (.arw/.nef/.dng/.raf - see lib_common.ps1's
  $SupportedRawExtensions) and runs auto_enhance.ps1 once all currently-present files have a
  stable size (i.e. finished copying), instead of processing on every event. This deliberately
  waits for the WHOLE batch to be stable before running - a file still being copied in the same
  folder blocks that cycle so it can never be grabbed half-written.
#>
[CmdletBinding()]
param(
    [string]$WatchDir,
    [string]$ConfigPath,
    [int]$PollIntervalSec = 30,
    [int]$StableSeconds = 10,
    [int]$MaxCycles = 0   # 0 = run forever; >0 = stop after N poll cycles (used by tests)
)

. (Join-Path $PSScriptRoot "lib_common.ps1")
$RepoRoot = Get-RepoRoot
if (-not $WatchDir) { $WatchDir = Join-Path $RepoRoot "incoming" }
New-Item -ItemType Directory -Force -Path $WatchDir | Out-Null

Write-Host "Watching $WatchDir every ${PollIntervalSec}s (files must be stable for ${StableSeconds}s before processing)."

$cycle = 0
while ($true) {
    $cycle++
    $files = Get-ChildItem -LiteralPath $WatchDir -File -ErrorAction SilentlyContinue | Where-Object { Test-IsRawFile $_ }

    if ($files.Count -gt 0) {
        $sizesBefore = @{}
        foreach ($f in $files) { $sizesBefore[$f.FullName] = $f.Length }

        Start-Sleep -Seconds $StableSeconds

        $filesAfter = Get-ChildItem -LiteralPath $WatchDir -File -ErrorAction SilentlyContinue | Where-Object { Test-IsRawFile $_ }
        $allStable = ($filesAfter.Count -eq $files.Count)
        if ($allStable) {
            foreach ($f in $filesAfter) {
                if (-not $sizesBefore.ContainsKey($f.FullName) -or $sizesBefore[$f.FullName] -ne $f.Length) {
                    $allStable = $false
                    break
                }
            }
        }

        if ($allStable) {
            Write-Host "$(Get-Date -Format o) All $($filesAfter.Count) file(s) stable - running pipeline"
            $psArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "auto_enhance.ps1"), "-InputDir", $WatchDir)
            if ($ConfigPath) { $psArgs += @("-ConfigPath", $ConfigPath) }
            & powershell @psArgs
        } else {
            Write-Host "$(Get-Date -Format o) Files still changing - waiting for next cycle"
        }
    }

    if ($MaxCycles -gt 0 -and $cycle -ge $MaxCycles) {
        Write-Host "Reached MaxCycles ($MaxCycles), stopping."
        break
    }

    Start-Sleep -Seconds $PollIntervalSec
}
