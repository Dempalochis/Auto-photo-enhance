<#
  Shared fixture helpers for the Pester suite covering auto_enhance.ps1 - dot-sourced from each
  *.Tests.ps1 file's BeforeAll block. Mirrors webapp/server/tests' "tests live next to what they
  test" layout; this file plays the same shared-setup role webapp/server/tests' own test helpers
  play for the Node suite. Not itself named *.Tests.ps1, so Invoke-Pester's default discovery
  glob skips it.

  Design note: auto_enhance.ps1 resolves autoProfile's low/high-ISO profile paths and -Preset by
  name against the *real* repo root unconditionally (Join-Path (Get-RepoRoot) "profiles\..."/
  "presets\..." - no override param for either, unlike the single-profile -ProfilePath escape
  hatch). Rather than faking a second copy of the repo layout inside TestDrive:, tests that need
  those reference the real, already-committed profiles/default.pp3, profiles/lowlight.pp3, and
  an existing preset (teal_orange). Real RawTherapee/ExifTool are never actually invoked either
  way, since Invoke-RawTherapee/Invoke-ExifTool are mocked by every test in this suite.
#>

function Get-RealRepoRoot {
    Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

<#
  Creates an isolated TestDrive: fixture: an input dir with one or more fake .arw files, empty
  output/log dirs, and dummy (non-functional - just need to exist on disk) stand-ins for
  rtPath/exiftoolPath and a static profile. Returns a pscustomobject with every path a test
  typically needs to pass to auto_enhance.ps1.
#>
function New-EnhanceFixture {
    param(
        [string[]]$ArwNames = @("photo1.ARW"),
        [string]$Root = $TestDrive
    )
    # $TestDrive is shared across every It block in a Describe/file, not recreated per It - each
    # fixture gets its own GUID subfolder so two It blocks (or two New-EnhanceFixture calls in
    # the same It) never see each other's leftover input/output/logs dirs.
    $Root = Join-Path $Root ([System.Guid]::NewGuid().ToString("N"))
    $inputDir = Join-Path $Root "input"
    $outputDir = Join-Path $Root "output"
    $logDir = Join-Path $Root "logs"
    New-Item -ItemType Directory -Force -Path $inputDir | Out-Null
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null

    foreach ($name in $ArwNames) {
        Set-Content -LiteralPath (Join-Path $inputDir $name) -Value "fake raw content"
    }

    $rtPath = Join-Path $Root "fake_rawtherapee-cli.exe"
    Set-Content -LiteralPath $rtPath -Value "not a real executable - Invoke-RawTherapee is mocked"
    $exiftoolPath = Join-Path $Root "fake_exiftool.exe"
    Set-Content -LiteralPath $exiftoolPath -Value "not a real executable - Invoke-ExifTool is mocked"
    $dummyProfilePath = Join-Path $Root "dummy_profile.pp3"
    Set-Content -LiteralPath $dummyProfilePath -Value "[General]"

    return [pscustomobject]@{
        InputDir          = $inputDir
        OutputDir         = $outputDir
        LogDir            = $logDir
        RTPath            = $rtPath
        ExiftoolPath      = $exiftoolPath
        DummyProfilePath  = $dummyProfilePath
        NonExistentConfig = Join-Path $Root "no_such_config.json"
    }
}

<#
  Writes a config.json fixture for tests that need config-driven behavior (autoProfile,
  quarantineAfterFailures) rather than passing everything as explicit script params - there is
  no script param for exiftoolPath, for instance, so the ISO-branching test has no way to reach
  it except through a real config file.
#>
function New-EnhanceConfigFile {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [hashtable]$Config
    )
    $Config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Path
}

<#
  Mocks Invoke-RawTherapee to simulate a successful RawTherapee run: writes a dummy JPEG at
  whatever path follows "-o" in RTArgs (so auto_enhance.ps1's own "no output file was created"
  failure check doesn't trip on a mock that otherwise does nothing on disk) and returns
  ExitCode 0. Every call's RTPath/RTArgs is recorded to $script:EnhanceMockCalls for the test to
  inspect afterward - must be called from inside an It/Context/Describe block (Mock requires an
  active Pester scope on the call stack).
#>
function Set-SuccessfulRawTherapeeMock {
    $script:EnhanceMockCalls = [System.Collections.Generic.List[object]]::new()
    Mock Invoke-RawTherapee -MockWith {
        param($RTPath, $RTArgs)
        $script:EnhanceMockCalls.Add([pscustomobject]@{ RTPath = $RTPath; RTArgs = $RTArgs })
        $oIndex = [Array]::IndexOf($RTArgs, "-o")
        if ($oIndex -ge 0) {
            Set-Content -LiteralPath $RTArgs[$oIndex + 1] -Value "fake jpg output"
        }
        return [pscustomobject]@{ Stdout = ""; ExitCode = 0 }
    }
}

<#
  Mocks Invoke-RawTherapee to simulate every call failing (non-zero exit, no output file
  written) - for the quarantine test, which needs repeated failures rather than a success.
#>
function Set-FailingRawTherapeeMock {
    $script:EnhanceMockCalls = [System.Collections.Generic.List[object]]::new()
    Mock Invoke-RawTherapee -MockWith {
        param($RTPath, $RTArgs)
        $script:EnhanceMockCalls.Add([pscustomobject]@{ RTPath = $RTPath; RTArgs = $RTArgs })
        return [pscustomobject]@{ Stdout = ""; ExitCode = 1 }
    }
}
