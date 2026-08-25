<#
  V9: auto_enhance.ps1 actually processes non-.arw raw formats end-to-end, not just discovers
  them - the other new tests (testIsRawFile.Tests.ps1, rawFormats.test.js) cover the
  discovery/filtering logic in isolation; this proves the real conversion loop (idempotent-skip,
  output naming, the whole per-file flow) works identically regardless of which supported
  extension the source file has.
#>
BeforeAll {
    . "$PSScriptRoot/TestHelpers.ps1"
    . "$PSScriptRoot/../lib_common.ps1"
    $script:RealRepoRoot = Get-RealRepoRoot
    $script:AutoEnhancePath = Join-Path $RealRepoRoot "scripts\auto_enhance.ps1"
}

Describe "auto_enhance.ps1 - multi-format raw support" {
    It "processes a .NEF, .DNG, and .RAF file in the same batch as a .ARW file" {
        $fixture = New-EnhanceFixture -ArwNames @("sony.ARW", "nikon.NEF", "adobe.dng", "fuji.RAF")
        Set-SuccessfulRawTherapeeMock

        . $AutoEnhancePath `
            -InputDir $fixture.InputDir `
            -OutputDir $fixture.OutputDir `
            -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath `
            -ConfigPath $fixture.NonExistentConfig

        $script:EnhanceMockCalls.Count | Should -Be 4
        Test-Path -LiteralPath (Join-Path $fixture.OutputDir "sony.jpg") | Should -BeTrue
        Test-Path -LiteralPath (Join-Path $fixture.OutputDir "nikon.jpg") | Should -BeTrue
        Test-Path -LiteralPath (Join-Path $fixture.OutputDir "adobe.jpg") | Should -BeTrue
        Test-Path -LiteralPath (Join-Path $fixture.OutputDir "fuji.jpg") | Should -BeTrue
    }

    It "ignores a non-raw file sitting in the same input folder" {
        $fixture = New-EnhanceFixture -ArwNames @("photo1.NEF")
        Set-Content -LiteralPath (Join-Path $fixture.InputDir "readme.txt") -Value "not a photo"
        Set-SuccessfulRawTherapeeMock

        . $AutoEnhancePath `
            -InputDir $fixture.InputDir `
            -OutputDir $fixture.OutputDir `
            -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath `
            -ConfigPath $fixture.NonExistentConfig

        $script:EnhanceMockCalls.Count | Should -Be 1 # only photo1.NEF, not readme.txt
    }

    It "idempotent-skip works the same for a .DNG file as it already does for .ARW" {
        $fixture = New-EnhanceFixture -ArwNames @("photo1.DNG")
        Set-Content -LiteralPath (Join-Path $fixture.OutputDir "photo1.jpg") -Value "already converted"
        Set-SuccessfulRawTherapeeMock

        . $AutoEnhancePath `
            -InputDir $fixture.InputDir `
            -OutputDir $fixture.OutputDir `
            -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath `
            -ConfigPath $fixture.NonExistentConfig

        Should -Invoke Invoke-RawTherapee -Times 0
    }
}
