<#
  V7_PLAN.md Phase 3, task 3: a selected preset adds a second -p arg (the preset path) after
  the base profile's -p; no preset selected produces the exact pre-preset rtArgs shape.
  Uses the real presets/teal_orange.pp3 (see TestHelpers.ps1's design note - -Preset is always
  resolved by name against the real repo root, no override param).
#>
BeforeAll {
    . "$PSScriptRoot/TestHelpers.ps1"
    . "$PSScriptRoot/../lib_common.ps1"
    $script:RealRepoRoot = Get-RealRepoRoot
    $script:AutoEnhancePath = Join-Path $RealRepoRoot "scripts\auto_enhance.ps1"
    $script:TealOrangePresetPath = Join-Path $RealRepoRoot "presets\teal_orange.pp3"
}

Describe "auto_enhance.ps1 - preset stacking" {
    It "no preset selected: rtArgs carries exactly one -p pair (the base profile)" {
        $fixture = New-EnhanceFixture -ArwNames @("photo1.ARW")
        Set-SuccessfulRawTherapeeMock

        . $AutoEnhancePath `
            -InputDir $fixture.InputDir `
            -OutputDir $fixture.OutputDir `
            -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath `
            -ConfigPath $fixture.NonExistentConfig

        $script:EnhanceMockCalls.Count | Should -Be 1
        $rtArgs = $script:EnhanceMockCalls[0].RTArgs
        # -p <profile> -o <out> -j<quality> -Y -q -c <input> = 9 elements, one "-p".
        $rtArgs.Count | Should -Be 9
        ($rtArgs | Where-Object { $_ -eq "-p" }).Count | Should -Be 1
        $rtArgs[0] | Should -Be "-p"
        $rtArgs[1] | Should -Be $fixture.DummyProfilePath
    }

    It "preset selected: rtArgs carries a second -p pair for the preset, after the base profile's" {
        $fixture = New-EnhanceFixture -ArwNames @("photo1.ARW")
        Set-SuccessfulRawTherapeeMock

        . $AutoEnhancePath `
            -InputDir $fixture.InputDir `
            -OutputDir $fixture.OutputDir `
            -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath `
            -Preset "teal_orange" `
            -ConfigPath $fixture.NonExistentConfig

        $script:EnhanceMockCalls.Count | Should -Be 1
        $rtArgs = $script:EnhanceMockCalls[0].RTArgs
        # -p <profile> -p <preset> -o <out> -j<quality> -Y -q -c <input> = 11 elements, two "-p".
        $rtArgs.Count | Should -Be 11
        ($rtArgs | Where-Object { $_ -eq "-p" }).Count | Should -Be 2
        $rtArgs[0] | Should -Be "-p"
        $rtArgs[1] | Should -Be $fixture.DummyProfilePath
        $rtArgs[2] | Should -Be "-p"
        $rtArgs[3] | Should -Be $TealOrangePresetPath
    }
}
