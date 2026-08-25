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
  Resolves the rawtherapee-cli.exe to use: the configured path if it still exists, otherwise
  scans "C:\Program Files\RawTherapee\<version>\" for the newest installed version (proper
  numeric version comparison, not a lexicographic string sort - "5.9" must not outrank "5.12").
  Falls back to returning whatever was configured (possibly empty) so the caller's own
  "RawTherapee CLI not found" check still fires with a sensible path in the error message.
#>
function Resolve-RTPath([string]$ConfiguredPath) {
    if ($ConfiguredPath -and (Test-Path -LiteralPath $ConfiguredPath)) {
        return $ConfiguredPath
    }
    if ($ConfiguredPath) {
        Write-Host "NOTE: configured rtPath not found ($ConfiguredPath) - looking for another RawTherapee install..."
    }

    $installRoot = "C:\Program Files\RawTherapee"
    if (Test-Path -LiteralPath $installRoot) {
        $candidates = @(Get-ChildItem -LiteralPath $installRoot -Directory | ForEach-Object {
            $parsed = $null
            if ([System.Version]::TryParse($_.Name, [ref]$parsed)) {
                $exePath = Join-Path $_.FullName "rawtherapee-cli.exe"
                if (Test-Path -LiteralPath $exePath) {
                    [pscustomobject]@{ Version = $parsed; Path = $exePath }
                }
            }
        } | Sort-Object Version -Descending)

        if ($candidates.Count -gt 0) {
            Write-Host "Using RawTherapee $($candidates[0].Version) at $($candidates[0].Path)"
            return $candidates[0].Path
        }
    }

    return $ConfiguredPath
}

<#
  Returns the subfolder of $FileDir relative to $Root (e.g. "Ceremony"), or "" if $FileDir IS
  $Root or $Root is not set. Used to mirror an input subfolder structure into the output
  folder when scanning recursively, instead of flattening everything into one directory.
#>
function Get-RelativeSubfolder([string]$Root, [string]$FileDir) {
    if (-not $Root) { return "" }
    try {
        $rootFull = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
        $dirFull = (Resolve-Path -LiteralPath $FileDir).Path.TrimEnd('\')
    } catch {
        return ""
    }
    if ($dirFull -ieq $rootFull) { return "" }
    if ($dirFull.StartsWith("$rootFull\", [System.StringComparison]::OrdinalIgnoreCase)) {
        return $dirFull.Substring($rootFull.Length + 1)
    }
    return ""
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
        $isoRaw = Invoke-ExifTool -ExiftoolPath $ctx.ExiftoolPath -FilePath $file.FullName
        $isoInt = 0
        if ([int]::TryParse($isoRaw, [ref]$isoInt)) {
            $isoValue = $isoInt
            $profilePath = if ($isoInt -ge $ctx.IsoThreshold) { $ctx.HighIsoProfilePath } else { $ctx.LowIsoProfilePath }
        }
    }

    return @{ ProfilePath = $profilePath; ISO = $isoValue }
}

<#
  Thin, named wrapper around the actual ExifTool invocation (just the ISO read used by
  Get-BaseProfileForFile above) - exists purely so Pester's `Mock` has a command name to
  intercept. `& $ExiftoolPath ...` is a call to a resolved .exe *path*, not a named command,
  and Mock cannot intercept that directly. Returns the trimmed raw ISO string (or "" if
  exiftool printed nothing usable); callers still do their own [int]::TryParse.
#>
function Invoke-ExifTool([string]$ExiftoolPath, [string]$FilePath) {
    return (& $ExiftoolPath "-ISO" "-s" "-s" "-s" $FilePath | Out-String).Trim()
}

<#
  Thin, named wrapper around the actual rawtherapee-cli invocation used by auto_enhance.ps1 -
  same reasoning as Invoke-ExifTool above (Mock needs a named command, not a `& $RTPath` call).
  Returns Stdout/ExitCode explicitly rather than leaving the caller to read $LASTEXITCODE after
  the fact, so a Pester mock can fully control both without fighting a global variable across
  the mock boundary. Not used by preview_presets.ps1, which invokes RawTherapee via
  Start-Process for concurrent preview renders - a deliberately different pattern (see
  V7_PLAN.md Phase 3) left out of scope here.
#>
function Invoke-RawTherapee([string]$RTPath, [string[]]$RTArgs) {
    $stdout = & $RTPath @RTArgs | Out-String
    return [pscustomobject]@{ Stdout = $stdout; ExitCode = $LASTEXITCODE }
}
