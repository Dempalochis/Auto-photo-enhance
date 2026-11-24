<#
  Version 2 Phase 1: structured @@EVENT lines from auto_enhance.ps1. Printed only with
  -EmitEvents (the web UI); without it the console output is Version 1's.
#>
BeforeAll {
    . "$PSScriptRoot/TestHelpers.ps1"
    . "$PSScriptRoot/../lib_common.ps1"
    $script:AutoEnhancePath = Join-Path (Get-RealRepoRoot) "scripts\auto_enhance.ps1"

    function Get-Events($lines) {
        @($lines | ForEach-Object { "$_" } | Where-Object { $_.StartsWith("@@EVENT ") } | ForEach-Object { $_.Substring(8) | ConvertFrom-Json })
    }
}

Describe "auto_enhance.ps1 - @@EVENT lines" {
    It "emits started/completed per file and a summary, in order, with -EmitEvents" {
        $fixture = New-EnhanceFixture -ArwNames @("a.ARW", "b.ARW")
        Set-SuccessfulRawTherapeeMock
        $out = . $AutoEnhancePath -InputDir $fixture.InputDir -OutputDir $fixture.OutputDir -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath -ProfilePath $fixture.DummyProfilePath -ConfigPath $fixture.NonExistentConfig -EmitEvents 6>&1
        $events = Get-Events $out
        ($events | ForEach-Object { $_.event }) -join "," | Should -Be "file_started,file_completed,file_started,file_completed,summary"
        $events[0].index | Should -Be 0
        $events[2].index | Should -Be 1
        $events[0].total | Should -Be 2
        $events[0].file | Should -Match "a\.ARW$"
        $events[4].processed | Should -Be 2
        # The human-readable lines are still there, next to the events.
        (@($out | ForEach-Object { "$_" } | Where-Object { $_ -like "Enhancing *" })).Count | Should -Be 2
    }

    It "emits file_skipped for an existing output and file_failed for a failure" {
        $fixture = New-EnhanceFixture -ArwNames @("a.ARW")
        Set-Content -LiteralPath (Join-Path $fixture.OutputDir "a.jpg") -Value "exists"
        Set-SuccessfulRawTherapeeMock
        $out = . $AutoEnhancePath -InputDir $fixture.InputDir -OutputDir $fixture.OutputDir -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath -ProfilePath $fixture.DummyProfilePath -ConfigPath $fixture.NonExistentConfig -EmitEvents 6>&1
        (Get-Events $out)[0].event | Should -Be "file_skipped"

        $fixture2 = New-EnhanceFixture -ArwNames @("bad.ARW")
        Set-FailingRawTherapeeMock
        $out2 = . $AutoEnhancePath -InputDir $fixture2.InputDir -OutputDir $fixture2.OutputDir -LogDir $fixture2.LogDir `
            -RTPath $fixture2.RTPath -ProfilePath $fixture2.DummyProfilePath -ConfigPath $fixture2.NonExistentConfig -EmitEvents 6>&1
        $e = Get-Events $out2
        $e[1].event | Should -Be "file_failed"
        $e[1].note | Should -Match "exited with code 1"
        $e[2].failed | Should -Be 1
    }

    It "prints no @@EVENT lines without -EmitEvents (Version 1 console output)" {
        $fixture = New-EnhanceFixture -ArwNames @("a.ARW")
        Set-SuccessfulRawTherapeeMock
        $out = . $AutoEnhancePath -InputDir $fixture.InputDir -OutputDir $fixture.OutputDir -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath -ProfilePath $fixture.DummyProfilePath -ConfigPath $fixture.NonExistentConfig 6>&1
        (Get-Events $out).Count | Should -Be 0
    }
}
