<#
  V7_PLAN.md Phase 3, task 4: no preset -> base name unchanged; preset selected -> "_<preset>"
  suffix. The PowerShell-side counterpart to the JS outputFileFor tests in
  webapp/server/tests/pathSafety.test.js.
#>
BeforeAll {
    . "$PSScriptRoot/TestHelpers.ps1"
    . "$PSScriptRoot/../lib_common.ps1"
    $script:RealRepoRoot = Get-RealRepoRoot
    $script:AutoEnhancePath = Join-Path $RealRepoRoot "scripts\auto_enhance.ps1"
}

Describe "auto_enhance.ps1 - output naming" {
    It "no preset selected: output keeps the source base name" {
        $fixture = New-EnhanceFixture -ArwNames @("vacation_001.ARW")
        Set-SuccessfulRawTherapeeMock

        . $AutoEnhancePath `
            -InputDir $fixture.InputDir `
            -OutputDir $fixture.OutputDir `
            -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath `
            -ConfigPath $fixture.NonExistentConfig

        $expected = Join-Path $fixture.OutputDir "vacation_001.jpg"
        Test-Path -LiteralPath $expected | Should -BeTrue
    }

    It "preset selected: output gets a preset-name suffix" {
        $fixture = New-EnhanceFixture -ArwNames @("vacation_001.ARW")
        Set-SuccessfulRawTherapeeMock

        . $AutoEnhancePath `
            -InputDir $fixture.InputDir `
            -OutputDir $fixture.OutputDir `
            -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath `
            -Preset "teal_orange" `
            -ConfigPath $fixture.NonExistentConfig

        $expected = Join-Path $fixture.OutputDir "vacation_001_teal_orange.jpg"
        Test-Path -LiteralPath $expected | Should -BeTrue
        # And the plain (no-suffix) name must NOT exist - re-running with a different preset
        # must never collide with/overwrite a previous look's output.
        Test-Path -LiteralPath (Join-Path $fixture.OutputDir "vacation_001.jpg") | Should -BeFalse
    }
}
