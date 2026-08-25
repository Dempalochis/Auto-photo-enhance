<#
  V7_PLAN.md Phase 3, task 5: quarantine-after-N-failures. Simulates quarantineAfterFailures
  consecutive failed invocations via the mocked Invoke-RawTherapee returning a non-zero exit
  code, asserts the file lands in failed/ and the .attempts marker is cleared. Each "invocation"
  is a separate dot-sourced run of the whole script, matching how this happens for real (each
  run of auto_enhance.ps1 is a separate process/session; the .attempts sidecar file on disk is
  what carries the failure count between them).
#>
BeforeAll {
    . "$PSScriptRoot/TestHelpers.ps1"
    . "$PSScriptRoot/../lib_common.ps1"
    $script:RealRepoRoot = Get-RealRepoRoot
    $script:AutoEnhancePath = Join-Path $RealRepoRoot "scripts\auto_enhance.ps1"
}

Describe "auto_enhance.ps1 - quarantine after repeated failures" {
    It "keeps retrying under the threshold, then quarantines to failed/ and clears the marker" {
        $fixture = New-EnhanceFixture -ArwNames @("bad_file.ARW")
        New-EnhanceConfigFile -Path (Join-Path $TestDrive "config.json") -Config @{
            quarantineAfterFailures = 2
        }
        Set-FailingRawTherapeeMock

        $arwPath = Join-Path $fixture.InputDir "bad_file.ARW"
        $attemptsMarker = "$arwPath.attempts"
        $failedPath = Join-Path $fixture.InputDir "failed\bad_file.ARW"

        # Attempt 1 of 2: not yet quarantined - stays in place, marker records one failure.
        . $AutoEnhancePath `
            -InputDir $fixture.InputDir `
            -OutputDir $fixture.OutputDir `
            -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath `
            -ConfigPath (Join-Path $TestDrive "config.json")

        Test-Path -LiteralPath $arwPath | Should -BeTrue
        Test-Path -LiteralPath $failedPath | Should -BeFalse
        Test-Path -LiteralPath $attemptsMarker | Should -BeTrue
        (Get-Content -LiteralPath $attemptsMarker -Raw).Trim() | Should -Be "1"

        # Attempt 2 of 2: hits the threshold - quarantined, marker cleared.
        . $AutoEnhancePath `
            -InputDir $fixture.InputDir `
            -OutputDir $fixture.OutputDir `
            -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath `
            -ConfigPath (Join-Path $TestDrive "config.json")

        Test-Path -LiteralPath $arwPath | Should -BeFalse
        Test-Path -LiteralPath $failedPath | Should -BeTrue
        Test-Path -LiteralPath $attemptsMarker | Should -BeFalse

        $script:EnhanceMockCalls.Count | Should -Be 2
    }
}
