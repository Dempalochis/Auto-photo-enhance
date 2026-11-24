<#
  Version 2 Phase 4: -CorrectionsJson. The AI overlay goes after base/format overlay and BEFORE the
  preset; AI runs are named <name>_ai[_<preset>].jpg; CSV gains AiCorrection/AiScene; files
  without a plan get no overlay. -WaitForCorrections waits for entries written later.
#>
BeforeAll {
    . "$PSScriptRoot/TestHelpers.ps1"
    . "$PSScriptRoot/../lib_common.ps1"
    $script:AutoEnhancePath = Join-Path (Get-RealRepoRoot) "scripts\auto_enhance.ps1"
    $script:TealOrange = Join-Path (Get-RealRepoRoot) "presets\teal_orange.pp3"

    function New-Corrections($fixture, [hashtable]$map) {
        $path = Join-Path (Split-Path $fixture.InputDir -Parent) ("corr_" + [guid]::NewGuid().ToString("N") + ".json")
        $obj = [ordered]@{}
        foreach ($k in $map.Keys) { $obj[(Join-Path $fixture.InputDir $k)] = $map[$k] }
        $obj | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path
        return $path
    }
    function New-Overlay($fixture, [string]$name) {
        $p = Join-Path (Split-Path $fixture.InputDir -Parent) $name
        Set-Content -LiteralPath $p -Value "[Exposure]`r`nCompensation=0.55"
        return $p
    }
}

Describe "auto_enhance.ps1 -CorrectionsJson" {
    It "stacks base -> AI overlay -> preset and names the output _ai_<preset>" {
        $fixture = New-EnhanceFixture -ArwNames @("a.ARW")
        $ov = New-Overlay $fixture "ov1.pp3"
        $corr = New-Corrections $fixture @{ "a.ARW" = @{ overlay = $ov; summary = "exp+1"; scene = "landscape"; note = "" } }
        Set-SuccessfulRawTherapeeMock
        . $AutoEnhancePath -InputDir $fixture.InputDir -OutputDir $fixture.OutputDir -LogDir $fixture.LogDir -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath -ConfigPath $fixture.NonExistentConfig -Preset teal_orange -CorrectionsJson $corr 6>&1 | Out-Null
        $a = $script:EnhanceMockCalls[0].RTArgs
        (Get-RTProfileStack $a) -join "," | Should -Be "$($fixture.DummyProfilePath),$ov,$TealOrange"
        $a[[Array]::IndexOf($a, "-o") + 1] | Should -Be (Join-Path $fixture.OutputDir "a_ai_teal_orange.jpg")
        $row = Import-Csv (Get-ChildItem $fixture.LogDir -Filter *.csv)[0].FullName
        $row.AiCorrection | Should -Be "exp+1"
        $row.AiScene | Should -Be "landscape"
    }

    It "accepts the plain string form and gives files without an entry no overlay (still _ai named, with a note)" {
        $fixture = New-EnhanceFixture -ArwNames @("a.ARW", "b.ARW")
        $ov = New-Overlay $fixture "ov2.pp3"
        $corr = New-Corrections $fixture @{ "a.ARW" = $ov }
        Set-SuccessfulRawTherapeeMock
        . $AutoEnhancePath -InputDir $fixture.InputDir -OutputDir $fixture.OutputDir -LogDir $fixture.LogDir -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath -ConfigPath $fixture.NonExistentConfig -CorrectionsJson $corr 6>&1 | Out-Null
        (Get-RTProfileStack $script:EnhanceMockCalls[0].RTArgs).Count | Should -Be 2
        (Get-RTProfileStack $script:EnhanceMockCalls[1].RTArgs).Count | Should -Be 1
        Test-Path (Join-Path $fixture.OutputDir "b_ai.jpg") | Should -BeTrue
        $rows = Import-Csv (Get-ChildItem $fixture.LogDir -Filter *.csv)[0].FullName
        $rows[1].Note | Should -Match "AI correction skipped"
    }

    It "an entry with a null overlay (all-zero / failed analysis) renders like Version 1 but named _ai, with the note in the log" {
        $fixture = New-EnhanceFixture -ArwNames @("a.ARW")
        $corr = New-Corrections $fixture @{ "a.ARW" = @{ overlay = $null; summary = "none"; scene = ""; note = "AI correction skipped: timed out" } }
        Set-SuccessfulRawTherapeeMock
        . $AutoEnhancePath -InputDir $fixture.InputDir -OutputDir $fixture.OutputDir -LogDir $fixture.LogDir -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath -ConfigPath $fixture.NonExistentConfig -CorrectionsJson $corr 6>&1 | Out-Null
        (Get-RTProfileStack $script:EnhanceMockCalls[0].RTArgs) -join "," | Should -Be $fixture.DummyProfilePath
        $row = Import-Csv (Get-ChildItem $fixture.LogDir -Filter *.csv)[0].FullName
        $row.Note | Should -Be "AI correction skipped: timed out"
        $row.AiCorrection | Should -Be "none"
    }

    It "without -CorrectionsJson: Version 1 names and CSV columns" {
        $fixture = New-EnhanceFixture -ArwNames @("a.ARW")
        Set-SuccessfulRawTherapeeMock
        . $AutoEnhancePath -InputDir $fixture.InputDir -OutputDir $fixture.OutputDir -LogDir $fixture.LogDir -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath -ConfigPath $fixture.NonExistentConfig 6>&1 | Out-Null
        Test-Path (Join-Path $fixture.OutputDir "a.jpg") | Should -BeTrue
        $header = (Get-Content (Get-ChildItem $fixture.LogDir -Filter *.csv)[0].FullName -TotalCount 1)
        $header | Should -Be '"Timestamp","File","Status","ExitCode","DurationSec","ISO","Profile","Preset","OutputPath","Note"'
    }

    It "-WaitForCorrections waits for an entry written later and announces it with waiting_for_plan" {
        $fixture = New-EnhanceFixture -ArwNames @("a.ARW")
        $ov = New-Overlay $fixture "ov3.pp3"
        $corr = Join-Path (Split-Path $fixture.InputDir -Parent) "late.json"
        Set-Content -LiteralPath $corr -Value "{}"
        $key = Join-Path $fixture.InputDir "a.ARW"
        $writer = Start-Job -ScriptBlock {
            param($path, $key, $ov)
            Start-Sleep -Milliseconds 1200
            @{ $key = @{ overlay = $ov; summary = "cla+1"; scene = ""; note = "" } } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path
        } -ArgumentList $corr, $key, $ov
        Set-SuccessfulRawTherapeeMock
        $out = . $AutoEnhancePath -InputDir $fixture.InputDir -OutputDir $fixture.OutputDir -LogDir $fixture.LogDir -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath -ConfigPath $fixture.NonExistentConfig -CorrectionsJson $corr -WaitForCorrections -EmitEvents 6>&1
        $writer | Wait-Job | Remove-Job
        @($out | ForEach-Object { "$_" } | Where-Object { $_ -like '@@EVENT {"event":"waiting_for_plan"*' }).Count | Should -Be 1
        (Get-RTProfileStack $script:EnhanceMockCalls[0].RTArgs) -contains $ov | Should -BeTrue
    }

    It "-WaitForCorrections gives up after -CorrectionsMaxWaitSec and renders without AI" {
        $fixture = New-EnhanceFixture -ArwNames @("a.ARW")
        $corr = Join-Path (Split-Path $fixture.InputDir -Parent) "never.json"
        Set-Content -LiteralPath $corr -Value "{}"
        Set-SuccessfulRawTherapeeMock
        . $AutoEnhancePath -InputDir $fixture.InputDir -OutputDir $fixture.OutputDir -LogDir $fixture.LogDir -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath -ConfigPath $fixture.NonExistentConfig -CorrectionsJson $corr -WaitForCorrections -CorrectionsMaxWaitSec 1 6>&1 | Out-Null
        $script:EnhanceMockCalls.Count | Should -Be 1
        (Import-Csv (Get-ChildItem $fixture.LogDir -Filter *.csv)[0].FullName).Note | Should -Match "no plan"
    }
}
