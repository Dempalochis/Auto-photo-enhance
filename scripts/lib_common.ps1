<#
  Shared helpers dot-sourced by auto_enhance.ps1 and preview_presets.ps1:
  config loading and per-file base-profile (color-correction) resolution.
#>

function Get-RepoRoot {
    Split-Path -Parent $PSScriptRoot
}

function Read-EnhanceConfig([string]$ConfigPath) {
    $config = [pscustomobject]@{}
    if (Test-Path -LiteralPath $ConfigPath) {
        try {
            $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
        } catch {
            Write-Host "ERROR: Failed to parse config file (invalid JSON): $ConfigPath`n$_" -ForegroundColor Red
            exit 1
        }
    }
    return $config
}

function Resolve-RepoPath([string]$RepoRoot, [string]$path) {
    if ([System.IO.Path]::IsPathRooted($path)) { return $path }
    return (Join-Path $RepoRoot $path)
}

<#
  Sets up everything needed to pick a base (color-correction) profile per file:
  static fallback profile, and - if exiftool is configured and available - ISO-based
  branching between config.autoProfile.lowIsoProfile / highIsoProfile.
  Returns a hashtable consumed by Get-BaseProfileForFile.
#>
function Initialize-BaseProfileContext([string]$RepoRoot, $config, [string]$ProfilePath, [string]$Profile, [bool]$ExplicitProfileOverride) {
    if (-not $ProfilePath) {
        if (-not $Profile) {
            $Profile = if ($config.defaultProfile) { $config.defaultProfile } else { "default" }
        }
        $ProfilePath = Join-Path $RepoRoot "profiles\$Profile.pp3"
    }

    if (-not (Test-Path -LiteralPath $ProfilePath)) {
        Write-Host "ERROR: Missing profile: $ProfilePath" -ForegroundColor Red
        exit 1
    }

    $ctx = [pscustomobject]@{
        StaticProfilePath = $ProfilePath
        AutoProfileEnabled = $false
        ExiftoolPath = $null
        ExiftoolAvailable = $false
        IsoThreshold = 800
        LowIsoProfilePath = $null
        HighIsoProfilePath = $null
    }

    $ctx.AutoProfileEnabled = (-not $ExplicitProfileOverride) -and $config.autoProfile -and $config.autoProfile.enabled
    $ctx.ExiftoolPath = $config.exiftoolPath
    $ctx.ExiftoolAvailable = $ctx.AutoProfileEnabled -and $ctx.ExiftoolPath -and (Test-Path -LiteralPath $ctx.ExiftoolPath)

    if ($ctx.AutoProfileEnabled -and -not $ctx.ExiftoolAvailable) {
        Write-Host "NOTE: autoProfile is enabled in config but exiftool was not found at '$($ctx.ExiftoolPath)' - using the static profile for all files."
    }

    if ($ctx.ExiftoolAvailable) {
        $ctx.IsoThreshold = if ($config.autoProfile.isoThreshold) { $config.autoProfile.isoThreshold } else { 800 }
        $ctx.LowIsoProfilePath = Join-Path $RepoRoot "profiles\$($config.autoProfile.lowIsoProfile).pp3"
        $ctx.HighIsoProfilePath = Join-Path $RepoRoot "profiles\$($config.autoProfile.highIsoProfile).pp3"
        if (-not (Test-Path -LiteralPath $ctx.LowIsoProfilePath)) { Write-Host "ERROR: Missing autoProfile.lowIsoProfile: $($ctx.LowIsoProfilePath)" -ForegroundColor Red; exit 1 }
        if (-not (Test-Path -LiteralPath $ctx.HighIsoProfilePath)) { Write-Host "ERROR: Missing autoProfile.highIsoProfile: $($ctx.HighIsoProfilePath)" -ForegroundColor Red; exit 1 }
    }

    return $ctx
}

<#
  Returns @{ ProfilePath = ...; ISO = "" or int } for a given raw file, using the context
  built by Initialize-BaseProfileContext.
#>
function Get-BaseProfileForFile($ctx, [System.IO.FileInfo]$file) {
    $profilePath = $ctx.StaticProfilePath
    $isoValue = ""

    if ($ctx.ExiftoolAvailable) {
        $isoRaw = (& $ctx.ExiftoolPath "-ISO" "-s" "-s" "-s" $file.FullName | Out-String).Trim()
        $isoInt = 0
        if ([int]::TryParse($isoRaw, [ref]$isoInt)) {
            $isoValue = $isoInt
            $profilePath = if ($isoInt -ge $ctx.IsoThreshold) { $ctx.HighIsoProfilePath } else { $ctx.LowIsoProfilePath }
        }
    }

    return @{ ProfilePath = $profilePath; ISO = $isoValue }
}
