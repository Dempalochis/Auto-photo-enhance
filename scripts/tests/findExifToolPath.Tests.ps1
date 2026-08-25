<#
  V8 Phase 4: Find-ExifToolPath (lib_common.ps1), used by setup.ps1's ExifTool auto-discovery.
  Uses TestDrive: dummy files as fake "candidates" so this doesn't depend on this machine's real
  filesystem - the function accepts a $ScanCandidates param specifically to make this possible
  (see its own doc comment in lib_common.ps1).
#>
BeforeAll {
    . "$PSScriptRoot/../lib_common.ps1"
}

Describe "Find-ExifToolPath" {
    # Mocked regardless of this machine's real PATH, so these tests are deterministic whether or
    # not exiftool.exe actually happens to be on PATH wherever they run.
    BeforeEach {
        Mock Get-Command { $null } -ParameterFilter { $Name -eq "exiftool.exe" }
    }

    It "returns the configured path when it exists, without touching PATH or the scan list" {
        $configured = Join-Path $TestDrive "configured_exiftool.exe"
        Set-Content -LiteralPath $configured -Value "fake"
        $result = Find-ExifToolPath $configured @("should-not-be-used.exe")
        $result | Should -Be $configured
        Should -Invoke Get-Command -Times 0
    }

    It "falls through to the scan candidates when the configured path does not exist" {
        $candidate1 = Join-Path $TestDrive "candidate1\exiftool.exe"
        $candidate2 = Join-Path $TestDrive "candidate2\exiftool.exe"
        New-Item -ItemType Directory -Force -Path (Split-Path $candidate2) | Out-Null
        Set-Content -LiteralPath $candidate2 -Value "fake"

        $result = Find-ExifToolPath "C:\does\not\exist.exe" @($candidate1, $candidate2)
        $result | Should -Be $candidate2
    }

    It "returns the first matching candidate when several exist, preserving list order" {
        $first = Join-Path $TestDrive "first\exiftool.exe"
        $second = Join-Path $TestDrive "second\exiftool.exe"
        foreach ($p in @($first, $second)) {
            New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null
            Set-Content -LiteralPath $p -Value "fake"
        }
        $result = Find-ExifToolPath $null @($first, $second)
        $result | Should -Be $first
    }

    It "returns `$null when nothing is configured, on PATH, or in the scan candidates" {
        $result = Find-ExifToolPath $null @((Join-Path $TestDrive "nope1.exe"), (Join-Path $TestDrive "nope2.exe"))
        $result | Should -BeNullOrEmpty
    }

    It "ignores an empty/null configured path and still checks the scan candidates" {
        $candidate = Join-Path $TestDrive "found.exe"
        Set-Content -LiteralPath $candidate -Value "fake"
        $result = Find-ExifToolPath "" @($candidate)
        $result | Should -Be $candidate
    }

    It "prefers a real exiftool.exe already on PATH over the scan candidates" {
        $pathHit = Join-Path $TestDrive "on_path\exiftool.exe"
        New-Item -ItemType Directory -Force -Path (Split-Path $pathHit) | Out-Null
        Set-Content -LiteralPath $pathHit -Value "fake"
        Mock Get-Command { [pscustomobject]@{ Source = $pathHit } } -ParameterFilter { $Name -eq "exiftool.exe" }

        $scanOnly = Join-Path $TestDrive "scan_only\exiftool.exe"
        New-Item -ItemType Directory -Force -Path (Split-Path $scanOnly) | Out-Null
        Set-Content -LiteralPath $scanOnly -Value "fake"

        $result = Find-ExifToolPath $null @($scanOnly)
        $result | Should -Be $pathHit
    }
}
