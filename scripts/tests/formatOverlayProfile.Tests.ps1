<#
  V9 Phase 3: a per-format profile overlay (profiles/<ext>.pp3) is stacked on top of the base
  colour-correction profile for files of that extension - currently profiles/raf.pp3, a white-
  balance correction for Fujifilm X-Trans. Formats with no profiles/<ext>.pp3 (.arw, .nef, .dng)
  are unaffected. This proves the routing in lib_common.ps1's Get-BaseProfileForFile and the
  -p stacking order in auto_enhance.ps1.
#>
BeforeAll {
    . "$PSScriptRoot/TestHelpers.ps1"
    . "$PSScriptRoot/../lib_common.ps1"
    $script:RealRepoRoot = Get-RealRepoRoot
    $script:AutoEnhancePath = Join-Path $RealRepoRoot "scripts\auto_enhance.ps1"
    $script:RafOverlayPath  = Join-Path $RealRepoRoot "profiles\raf.pp3"
}

Describe "Get-BaseProfileForFile - per-format overlay routing" {
    It "returns profiles/raf.pp3 as FormatOverlayPath for a .raf file" {
        $ctx = Initialize-BaseProfileContext -RepoRoot $RealRepoRoot -config ([pscustomobject]@{}) `
            -ProfilePath (Join-Path $RealRepoRoot "profiles\default.pp3") -Profile "" -ExplicitProfileOverride $true
        $file = [System.IO.FileInfo](Join-Path $TestDrive "DSCF1234.RAF")
        $result = Get-BaseProfileForFile -ctx $ctx -file $file
        $result.FormatOverlayPath | Should -Be $RafOverlayPath
    }

    It "returns no overlay for .arw / .nef / .dng (no matching per-extension pp3 exists)" {
        $ctx = Initialize-BaseProfileContext -RepoRoot $RealRepoRoot -config ([pscustomobject]@{}) `
            -ProfilePath (Join-Path $RealRepoRoot "profiles\default.pp3") -Profile "" -ExplicitProfileOverride $true
        foreach ($name in @("a.ARW", "b.nef", "c.DNG")) {
            $file = [System.IO.FileInfo](Join-Path $TestDrive $name)
            (Get-BaseProfileForFile -ctx $ctx -file $file).FormatOverlayPath | Should -BeNullOrEmpty
        }
    }
}

Describe "auto_enhance.ps1 - format overlay stacking" {
    It "passes the base profile then profiles/raf.pp3 for a .RAF file, in that order, and nothing extra for a .ARW" {
        $fixture = New-EnhanceFixture -ArwNames @("sony.ARW", "fuji.RAF")
        Set-SuccessfulRawTherapeeMock

        . $AutoEnhancePath `
            -InputDir $fixture.InputDir `
            -OutputDir $fixture.OutputDir `
            -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath `
            -ConfigPath $fixture.NonExistentConfig

        $rafCall = $script:EnhanceMockCalls | Where-Object { $_.RTArgs[-1] -like "*fuji.RAF" }
        $arwCall = $script:EnhanceMockCalls | Where-Object { $_.RTArgs[-1] -like "*sony.ARW" }

        $rafCall.RTArgs | Should -Contain $RafOverlayPath
        $arwCall.RTArgs | Should -Not -Contain $RafOverlayPath

        # base profile -p must be stacked before the overlay -p (RawTherapee applies -p left to right)
        $pIdxBase    = [Array]::IndexOf($rafCall.RTArgs, $fixture.DummyProfilePath)
        $pIdxOverlay = [Array]::IndexOf($rafCall.RTArgs, $RafOverlayPath)
        $pIdxOverlay | Should -BeGreaterThan $pIdxBase

        # .ARW call has exactly one -p (the base profile), no overlay
        (@($arwCall.RTArgs | Where-Object { $_ -eq "-p" })).Count | Should -Be 1
        (@($rafCall.RTArgs | Where-Object { $_ -eq "-p" })).Count | Should -Be 2
    }

    It "stacks base -> overlay -> preset in order for a .RAF with a preset selected" {
        $fixture = New-EnhanceFixture -ArwNames @("fuji.RAF")
        Set-SuccessfulRawTherapeeMock

        . $AutoEnhancePath `
            -InputDir $fixture.InputDir `
            -OutputDir $fixture.OutputDir `
            -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath `
            -Preset "teal_orange" `
            -ConfigPath $fixture.NonExistentConfig

        $call = $script:EnhanceMockCalls | Where-Object { $_.RTArgs[-1] -like "*fuji.RAF" }
        $presetPath = Join-Path $RealRepoRoot "presets\teal_orange.pp3"

        $iBase   = [Array]::IndexOf($call.RTArgs, $fixture.DummyProfilePath)
        $iOverlay = [Array]::IndexOf($call.RTArgs, $RafOverlayPath)
        $iPreset = [Array]::IndexOf($call.RTArgs, $presetPath)
        ($iBase -lt $iOverlay) | Should -BeTrue
        ($iOverlay -lt $iPreset) | Should -BeTrue
    }
}
