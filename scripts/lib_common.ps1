<#
  Shared helpers dot-sourced by auto_enhance.ps1, preview_presets.ps1, and watch_folder.ps1:
  config loading, per-file base-profile (color-correction) resolution, and the supported raw
  file extensions.
#>

# Single source of truth for which raw file extensions this app accepts - mirrors
# webapp/server/rawFormats.js (the two can't literally share code across JS/PowerShell, but must
# be kept in sync by hand). V9: expanded beyond the original Sony .ARW-only restriction, which
# was never a RawTherapee limitation - see V9_PLAN.md (local-only, not shipped) for the full
# reasoning. Plain extensions (no wildcard/dot) so callers can use them either with
# Get-ChildItem's -Include (needs a "*." prefix) or a plain .Extension -in comparison
# ([System.IO.FileInfo].Extension already includes the leading dot, lowercase-normalized below).
$SupportedRawExtensions = @(".arw", ".nef", ".dng", ".raf")

# True if $File's extension is one of $SupportedRawExtensions (case-insensitive).
function Test-IsRawFile([System.IO.FileInfo]$File) {
    return $SupportedRawExtensions -contains $File.Extension.ToLowerInvariant()
}

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
  Best-effort ExifTool discovery for setup.ps1 (V8 Phase 4): the configured path if it exists,
  else exiftool.exe on PATH, else a scan of common install locations. Unlike Resolve-RTPath, this
  can't be as precise - real ExifTool-for-Windows has no single standard install path (the
  classic distribution is just a renamed .exe dropped anywhere by hand; winget/MSI builds vary
  too) - a miss here just means setup.ps1's "download and set exiftoolPath manually" fallback
  message applies. Takes the candidate list as a param (rather than reading $env: directly)
  purely so Pester can test the scan/precedence logic against fake candidates without depending
  on this machine's real filesystem.
#>
function Find-ExifToolPath([string]$ConfiguredPath, [string[]]$ScanCandidates) {
    if ($ConfiguredPath -and (Test-Path -LiteralPath $ConfiguredPath)) {
        return $ConfiguredPath
    }
    $onPath = Get-Command "exiftool.exe" -ErrorAction SilentlyContinue
    if ($onPath) {
        return $onPath.Source
    }
    if (-not $ScanCandidates) {
        $ScanCandidates = @(
            (Join-Path $env:LOCALAPPDATA "Programs\ExifTool\ExifTool.exe"),
            (Join-Path $env:LOCALAPPDATA "Programs\ExifTool\exiftool.exe"),
            (Join-Path $env:ProgramFiles "ExifTool\exiftool.exe"),
            (Join-Path ${env:ProgramFiles(x86)} "ExifTool\exiftool.exe")
        )
    }
    foreach ($candidate in $ScanCandidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }
    return $null
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
        ProfilesDir = Join-Path $RepoRoot "profiles"
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
  Returns @{ ProfilePath = ...; FormatOverlayPath = ... or $null; ISO = "" or int } for a given
  raw file, using the context built by Initialize-BaseProfileContext.

  FormatOverlayPath: a thin per-format pp3 (e.g. profiles/raf.pp3 for .raf files) meant to be
  stacked ON TOP of ProfilePath - for sensor-specific corrections the Sony-tuned base profiles
  don't cover (currently: X-Trans white balance). $null when no profiles/<ext>.pp3 exists, which
  is the case for most formats.
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

    $formatOverlay = $null
    $ext = $file.Extension.TrimStart('.').ToLowerInvariant()
    if ($ext -and $ctx.ProfilesDir) {
        $candidate = Join-Path $ctx.ProfilesDir "$ext.pp3"
        if (Test-Path -LiteralPath $candidate) { $formatOverlay = $candidate }
    }

    return @{ ProfilePath = $profilePath; FormatOverlayPath = $formatOverlay; ISO = $isoValue }
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
function Invoke-RawTherapee([string]$RTPath, [string[]]$RTArgs, [scriptblock]$OnLine) {
    # Version 2 Phase 1: stdout is read line by line (not buffered with Out-String) so a caller can
    # react to each line as it arrives (-OnLine). The return shape is unchanged, so the Pester mocks
    # keep working.
    $sb = New-Object System.Text.StringBuilder
    & $RTPath @RTArgs | ForEach-Object {
        $line = "$_"
        [void]$sb.AppendLine($line)
        if ($OnLine) { & $OnLine $line }
    }
    return [pscustomobject]@{ Stdout = $sb.ToString(); ExitCode = $LASTEXITCODE }
}

<#
  Version 2 Phase 1: the ONE place rawtherapee-cli arguments are built (plan principle 4), so final,
  draft, preview and AI renders can't drift apart. The -p order is always:
      base -> format overlay -> AI overlay -> preset -> (draft only) draft override
  Draft mode adds -f (first, as preview_presets.ps1 always did) and the draft override last, so no
  preset can override it. If no -DraftOverride is given (file missing), draft mode degrades to the
  plain stack without -f, the same graceful fallback preview_presets.ps1 had in Version 1.
  -Out is a file for single renders, or a folder for a multi-file batch (Phase 2).
#>
function Build-RTArgs {
    param(
        [ValidateSet("final", "draft")][string]$Mode = "final",
        [Parameter(Mandatory = $true)][string]$Base,
        [string]$FormatOverlay,
        [string]$AiOverlay,
        [string]$Preset,
        [string]$DraftOverride,
        [Parameter(Mandatory = $true)][string[]]$Inputs,
        [Parameter(Mandatory = $true)][string]$Out,
        [int]$Quality = 95
    )
    $isDraft = ($Mode -eq "draft") -and $DraftOverride
    $a = @()
    if ($isDraft) { $a += "-f" }
    $a += @("-p", $Base)
    if ($FormatOverlay) { $a += @("-p", $FormatOverlay) }
    if ($AiOverlay) { $a += @("-p", $AiOverlay) }
    if ($Preset) { $a += @("-p", $Preset) }
    if ($isDraft) { $a += @("-p", $DraftOverride) }
    $a += @("-o", $Out, "-j$Quality", "-Y", "-q", "-c")
    $a += $Inputs
    return , $a
}

# The ordered -p list of an argument array (used for batch signatures, Phase 2).
function Get-RTProfileStack([string[]]$RTArgs) {
    $stack = @()
    for ($i = 0; $i -lt $RTArgs.Count - 1; $i++) { if ($RTArgs[$i] -eq "-p") { $stack += $RTArgs[$i + 1] } }
    return , $stack
}

# Draft override profile (Phase 1 rename of preview_fast_resize.pp3), or $null when missing.
function Get-DraftOverridePath([string]$RepoRoot) {
    $p = Join-Path $RepoRoot "profiles\draft_override.pp3"
    if (Test-Path -LiteralPath $p) { return $p }
    return $null
}

<#
  Version 2 Phase 1: structured progress line, printed NEXT TO the human-readable output (never
  instead of it) and only when the caller asked for events (-EmitEvents; the web UI does, the .bat
  CLI doesn't, so its console output stays exactly as in Version 1). Shape:
    @@EVENT {"event":"file_started","file":"C:\\x.ARW","index":0,"total":3,"note":""}
#>
$script:PipelineEventsEnabled = $false
function Enable-PipelineEvents([bool]$Enabled) { $script:PipelineEventsEnabled = $Enabled }
function Write-PipelineEvent([string]$Event, [hashtable]$Fields) {
    if (-not $script:PipelineEventsEnabled) { return }
    $o = [ordered]@{ event = $Event }
    if ($Fields) { foreach ($k in $Fields.Keys) { $o[$k] = $Fields[$k] } }
    Write-Host ("@@EVENT " + (ConvertTo-Json -InputObject $o -Compress -Depth 4))
}

# ======================= Version 2 Phase 2: batched rendering =======================

# One correctly quoted command-line string (same rule as preview_presets.ps1's ConvertTo-ArgLine;
# none of our arguments end in a backslash, so a plain wrapping quote is sufficient).
function ConvertTo-RTArgLine([string[]]$Argv) {
    ($Argv | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
}

# Files can share one rawtherapee-cli call only if everything except the inputs is identical:
# the ordered -p list, the output subfolder and the render mode.
function Get-BatchSignature([string[]]$ProfileStack, [string]$OutSubdir, [string]$Mode) {
    return (@($Mode, $OutSubdir.ToLowerInvariant()) + @($ProfileStack | ForEach-Object { $_.ToLowerInvariant() })) -join "|"
}

<#
  Groups jobs by .Signature (first-appearance order kept), then closes a batch and starts a new
  one for the same signature as soon as any limit is reached:
    - unique stems: at most one file per GetFileNameWithoutExtension (case-insensitive), since
      RawTherapee names temp outputs <stem>.jpg; a duplicate moves to the next batch;
    - file count: -MaxBatchSize;
    - command-line length: the full quoted argument string (what CreateProcess sees) must stay
      under -MaxCommandChars.
  -ArgsFor { param($jobsInBatch, $tempDir) -> string[] } builds the real arguments.
  Returns a list of batches (each an array of jobs).
#>
function Split-IntoBatches {
    param($Jobs, [int]$MaxBatchSize = 20, [int]$MaxCommandChars = 16000, [string]$RTPath = "rawtherapee-cli",
        [scriptblock]$ArgsFor, [scriptblock]$TempDirFor)
    $groups = New-Object System.Collections.Specialized.OrderedDictionary
    foreach ($j in $Jobs) {
        if (-not $groups.Contains($j.Signature)) { $groups[$j.Signature] = New-Object System.Collections.Generic.List[object] }
        $groups[$j.Signature].Add($j)
    }
    $result = New-Object System.Collections.Generic.List[object]
    foreach ($sig in $groups.Keys) {
        $pending = New-Object System.Collections.Generic.List[object]
        foreach ($j in $groups[$sig]) { $pending.Add($j) }
        while ($pending.Count -gt 0) {
            $batch = New-Object System.Collections.Generic.List[object]
            $stems = @{}
            $rest = New-Object System.Collections.Generic.List[object]
            foreach ($j in $pending) {
                $stem = [System.IO.Path]::GetFileNameWithoutExtension($j.Arw.Name).ToLowerInvariant()
                if ($batch.Count -ge $MaxBatchSize -or $stems.ContainsKey($stem)) { $rest.Add($j); continue }
                if ($batch.Count -gt 0 -and $ArgsFor) {
                    $tmp = if ($TempDirFor) { & $TempDirFor $batch[0] } else { "tmp" }
                    $candidate = [object[]]($batch.ToArray()) + @($j)
                    $len = $RTPath.Length + 3 + (ConvertTo-RTArgLine (& $ArgsFor $candidate $tmp)).Length
                    if ($len -gt $MaxCommandChars) { $rest.Add($j); continue }
                }
                $batch.Add($j)
                $stems[$stem] = $true
            }
            $result.Add($batch.ToArray())
            $pending = $rest
        }
    }
    return , $result.ToArray()
}

<#
  Which of -Stems have a finished <stem>.jpg in -TempDir. A file counts as finished when its size
  is > 0 and unchanged since the previous poll (-State remembers sizes) AND it can be opened for
  exclusive access (RawTherapee's write handle is closed). -Final (the process has exited) skips
  the size-stable wait, so nothing is lost if polling missed a file. -MinStableSeen lets the
  caller require more consecutive unchanged polls. Returns the newly finished stems, input order.
#>
function Get-ReadyBatchOutputs([string]$TempDir, [string[]]$Stems, [hashtable]$State, [switch]$Final, [int]$MinStableSeen = 1) {
    $ready = @()
    foreach ($stem in $Stems) {
        $key = $stem.ToLowerInvariant()
        if ($State.ContainsKey("done:$key")) { continue }
        $path = Join-Path $TempDir "$stem.jpg"
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $size = (Get-Item -LiteralPath $path).Length
        if ($size -le 0) { continue }
        $prev = $State["size:$key"]
        $seen = if ($null -ne $prev -and $prev -eq $size) { [int]$State["seen:$key"] + 1 } else { 0 }
        $State["size:$key"] = $size
        $State["seen:$key"] = $seen
        if (-not $Final -and $seen -lt $MinStableSeen) { continue }
        if (-not (Test-FileUnlocked $path)) { continue }
        $State["done:$key"] = $true
        $ready += $stem
    }
    return , $ready
}

function Test-FileUnlocked([string]$Path) {
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
        $fs.Close()
        return $true
    } catch {
        return $false
    }
}

<#
  Runs ONE rawtherapee-cli call for a whole batch (-Out = -TempDir) and calls -OnFileReady <stem>
  as each output finishes. Progress source (Phase 0 decision, config.progressSource):
    outputFolder (default): poll -TempDir every -PollMs; see Get-ReadyBatchOutputs.
    stdout: a "Processing: <next file>" line means the previous files are written; the lock check
            still applies. Falls back to the folder rule at exit.
  stdout/stderr go to files next to the temp folder (no pipe that could fill up and block).
  Returns { ExitCode, Stdout }. The exit code is informational only: per-file success is decided
  by which outputs exist (fault isolation in auto_enhance.ps1).
#>
# Reads a text file another process is still writing (Windows: a plain ReadAllText can hit a
# sharing violation; this opens it with FileShare.ReadWrite). Returns "" if it can't be read.
function Read-SharedText([string]$Path) {
    try {
        $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try { $sr = New-Object System.IO.StreamReader($fs); return $sr.ReadToEnd() } finally { $fs.Dispose() }
    } catch {
        return ""
    }
}

function Invoke-RawTherapeeBatch {
    param([string]$RTPath, [string[]]$RTArgs, [string]$TempDir, [string[]]$Stems,
        [string]$ProgressSource = "outputFolder", [scriptblock]$OnFileReady, [int]$PollMs = 250)
    $stdoutFile = "$TempDir.stdout.txt"
    $stderrFile = "$TempDir.stderr.txt"
    $proc = Start-Process -FilePath $RTPath -ArgumentList (ConvertTo-RTArgLine $RTArgs) -NoNewWindow -PassThru `
        -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
    $state = @{}
    $processingSeen = 0
    while (-not $proc.HasExited) {
        Start-Sleep -Milliseconds $PollMs
        if ($ProgressSource -eq "stdout") {
            $text = Read-SharedText $stdoutFile
            $n = ([regex]::Matches($text, '(?m)^Processing: ')).Count
            if ($n -gt $processingSeen) {
                $processingSeen = $n
                # Files before the one now "Processing" are written: accept them without the
                # size-stable wait (still lock-checked).
                $upTo = [math]::Min($Stems.Count, $n - 1)
                if ($upTo -gt 0) {
                    foreach ($stem in (Get-ReadyBatchOutputs -TempDir $TempDir -Stems $Stems[0..($upTo - 1)] -State $state -Final)) { & $OnFileReady $stem }
                }
            }
        } else {
            foreach ($stem in (Get-ReadyBatchOutputs -TempDir $TempDir -Stems $Stems -State $state)) { & $OnFileReady $stem }
        }
    }
    $proc.WaitForExit()
    foreach ($stem in (Get-ReadyBatchOutputs -TempDir $TempDir -Stems $Stems -State $state -Final)) { & $OnFileReady $stem }
    $out = Read-SharedText $stdoutFile
    return [pscustomobject]@{ ExitCode = $proc.ExitCode; Stdout = $out }
}
