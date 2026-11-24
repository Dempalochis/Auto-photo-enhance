<#
  Version 2 Phase 2: batched rendering with per-file fault isolation. RawTherapee is mocked:
  Invoke-RawTherapeeBatch writes <stem>.jpg into the temp folder for every input except files
  whose name contains "bad", and reports each through -OnFileReady like the real poller does.
#>
BeforeAll {
    . "$PSScriptRoot/TestHelpers.ps1"
    . "$PSScriptRoot/../lib_common.ps1"
    $script:AutoEnhancePath = Join-Path (Get-RealRepoRoot) "scripts\auto_enhance.ps1"

    function Set-BatchMocks {
        $script:BatchCalls = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-RawTherapeeBatch -MockWith {
            param($RTPath, $RTArgs, $TempDir, $Stems, $ProgressSource, $OnFileReady)
            $script:BatchCalls.Add([pscustomobject]@{ RTArgs = $RTArgs; TempDir = $TempDir; Stems = $Stems })
            $c = [Array]::IndexOf($RTArgs, "-c")
            foreach ($in in $RTArgs[($c + 1)..($RTArgs.Count - 1)]) {
                if ($in -match "bad") { continue }
                $stem = [System.IO.Path]::GetFileNameWithoutExtension($in)
                Set-Content -LiteralPath (Join-Path $TempDir "$stem.jpg") -Value "fake batch jpg"
                & $OnFileReady $stem
            }
            return [pscustomobject]@{ ExitCode = 0; Stdout = "" }
        }
        # The per-file path (used for single-file batches and fault-isolation retries).
        $script:EnhanceMockCalls = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-RawTherapee -MockWith {
            param($RTPath, $RTArgs)
            $script:EnhanceMockCalls.Add([pscustomobject]@{ RTPath = $RTPath; RTArgs = $RTArgs })
            $o = [Array]::IndexOf($RTArgs, "-o")
            $c = [Array]::IndexOf($RTArgs, "-c")
            if ($RTArgs[$c + 1] -match "bad") { return [pscustomobject]@{ Stdout = ""; ExitCode = 1 } }
            Set-Content -LiteralPath $RTArgs[$o + 1] -Value "fake jpg"
            return [pscustomobject]@{ Stdout = ""; ExitCode = 0 }
        }
    }

    function Invoke-Batched($fixture, [string[]]$Extra) {
        $p = @{
            InputDir = $fixture.InputDir; OutputDir = $fixture.OutputDir; LogDir = $fixture.LogDir; RTPath = $fixture.RTPath
            ProfilePath = $fixture.DummyProfilePath; ConfigPath = $fixture.NonExistentConfig; BatchRender = "true"
        }
        . $AutoEnhancePath @p @Extra 6>&1 | Out-Null
    }

    function New-Job([string]$Name, [string]$Sig = "S", [string]$Dir = "out") {
        [pscustomobject]@{ Arw = [pscustomobject]@{ Name = $Name; FullName = "/in/$Name" }; Signature = $Sig; OutSubdir = $Dir }
    }
}

Describe "Split-IntoBatches" {
    It "groups by signature, keeping first-appearance order" {
        $b = Split-IntoBatches -Jobs @((New-Job "a.ARW" "X"), (New-Job "b.ARW" "Y"), (New-Job "c.ARW" "X"))
        $b.Count | Should -Be 2
        ($b[0] | ForEach-Object { $_.Arw.Name }) -join "," | Should -Be "a.ARW,c.ARW"
        ($b[1] | ForEach-Object { $_.Arw.Name }) -join "," | Should -Be "b.ARW"
    }

    It "puts duplicate stems (DSC001.ARW + DSC001.RAF, any case) into separate batches" {
        $b = Split-IntoBatches -Jobs @((New-Job "DSC001.ARW"), (New-Job "dsc001.RAF"), (New-Job "DSC002.ARW"))
        $b.Count | Should -Be 2
        ($b[0] | ForEach-Object { $_.Arw.Name }) -join "," | Should -Be "DSC001.ARW,DSC002.ARW"
        $b[1][0].Arw.Name | Should -Be "dsc001.RAF"
    }

    It "respects maxBatchSize" {
        $jobs = 1..5 | ForEach-Object { New-Job "f$_.ARW" }
        $b = Split-IntoBatches -Jobs $jobs -MaxBatchSize 2
        ($b | ForEach-Object { $_.Count }) -join "," | Should -Be "2,2,1"
    }

    It "splits a batch of long paths on the command-line character budget" {
        $long = "x" * 3000
        $jobs = 1..4 | ForEach-Object { [pscustomobject]@{ Arw = [pscustomobject]@{ Name = "f$_.ARW"; FullName = "/$long/f$_.ARW" }; Signature = "S"; OutSubdir = "o" } }
        $argsFor = { param($group, $tmp) Build-RTArgs -Mode final -Base "base.pp3" -Inputs @($group | ForEach-Object { $_.Arw.FullName }) -Out $tmp }
        $b = Split-IntoBatches -Jobs $jobs -MaxCommandChars 7000 -ArgsFor $argsFor
        ($b | ForEach-Object { $_.Count }) -join "," | Should -Be "2,2"
        foreach ($batch in $b) { (ConvertTo-RTArgLine (& $argsFor $batch "tmp")).Length | Should -BeLessThan 7000 }
    }

    It "two subfolders with the same filename end up in different signature groups" {
        $s1 = Get-BatchSignature -ProfileStack @("base.pp3") -OutSubdir "out/A" -Mode final
        $s2 = Get-BatchSignature -ProfileStack @("base.pp3") -OutSubdir "out/B" -Mode final
        $s1 | Should -Not -Be $s2
        $b = Split-IntoBatches -Jobs @((New-Job "DSC1.ARW" $s1 "out/A"), (New-Job "DSC1.ARW" $s2 "out/B"))
        $b.Count | Should -Be 2
    }

    It "the AI overlay and the preset are part of the signature" {
        $a = Get-BatchSignature -ProfileStack @("base", "ai1", "preset") -OutSubdir "o" -Mode final
        $b = Get-BatchSignature -ProfileStack @("base", "ai2", "preset") -OutSubdir "o" -Mode final
        $a | Should -Not -Be $b
    }
}

Describe "auto_enhance.ps1 -BatchRender true" {
    It "renders shared-signature files in ONE call, then moves each temp output to its final name" {
        $fixture = New-EnhanceFixture -ArwNames @("a.ARW", "b.ARW", "c.ARW")
        Set-BatchMocks
        Invoke-Batched $fixture @("-Preset", "teal_orange")
        $script:BatchCalls.Count | Should -Be 1
        $call = $script:BatchCalls[0]
        $call.RTArgs[[Array]::IndexOf($call.RTArgs, "-o") + 1] | Should -Be $call.TempDir
        foreach ($n in @("a", "b", "c")) { Test-Path (Join-Path $fixture.OutputDir "$($n)_teal_orange.jpg") | Should -BeTrue }
        Test-Path $call.TempDir | Should -BeFalse
        $script:EnhanceMockCalls.Count | Should -Be 0
    }

    It "keeps one CSV row per file, in input order" {
        $fixture = New-EnhanceFixture -ArwNames @("a.ARW", "b.ARW", "c.ARW")
        Set-Content -LiteralPath (Join-Path $fixture.OutputDir "b.jpg") -Value "already there"
        Set-BatchMocks
        Invoke-Batched $fixture @()
        $rows = Import-Csv (Get-ChildItem $fixture.LogDir -Filter *.csv | Select-Object -First 1).FullName
        ($rows | ForEach-Object { "$($_.File):$($_.Status)" }) -join "," | Should -Be "a.ARW:Processed,b.ARW:Skipped,c.ARW:Processed"
    }

    It "retries a file the batch didn't produce ALONE, and quarantines it after 2 attempts as before" {
        $fixture = New-EnhanceFixture -ArwNames @("a.ARW", "bad.ARW", "c.ARW")
        Set-BatchMocks
        Invoke-Batched $fixture @()
        $script:EnhanceMockCalls.Count | Should -Be 1
        $c = $script:EnhanceMockCalls[0].RTArgs
        $c[[Array]::IndexOf($c, "-c") + 1] | Should -Match "bad\.ARW$"
        Test-Path (Join-Path $fixture.InputDir "bad.ARW.attempts") | Should -BeTrue
        Test-Path (Join-Path $fixture.OutputDir "a.jpg") | Should -BeTrue
        Test-Path (Join-Path $fixture.OutputDir "c.jpg") | Should -BeTrue

        Set-BatchMocks
        Invoke-Batched $fixture @()
        Test-Path (Join-Path $fixture.InputDir "failed/bad.ARW") | Should -BeTrue
        $rows = Import-Csv (Get-ChildItem $fixture.LogDir -Filter *.csv | Sort-Object Name | Select-Object -Last 1).FullName
        @($rows | Where-Object { $_.Status -eq "Failed" }).Count | Should -Be 1
        @($rows | Where-Object { $_.Status -eq "Skipped" }).Count | Should -Be 2
    }

    It "a single remaining file uses the Version 1 per-file path" {
        $fixture = New-EnhanceFixture -ArwNames @("only.ARW")
        Set-BatchMocks
        Invoke-Batched $fixture @()
        $script:BatchCalls.Count | Should -Be 0
        $script:EnhanceMockCalls.Count | Should -Be 1
    }

    It "is off by default (no config switch, no parameter): Version 1 per-file calls" {
        $fixture = New-EnhanceFixture -ArwNames @("a.ARW", "b.ARW")
        Set-BatchMocks
        . $AutoEnhancePath -InputDir $fixture.InputDir -OutputDir $fixture.OutputDir -LogDir $fixture.LogDir -RTPath $fixture.RTPath `
            -ProfilePath $fixture.DummyProfilePath -ConfigPath $fixture.NonExistentConfig 6>&1 | Out-Null
        $script:BatchCalls.Count | Should -Be 0
        $script:EnhanceMockCalls.Count | Should -Be 2
    }
}

Describe "Get-ReadyBatchOutputs (output-folder progress source)" {
    It "does not report a file still being written (size changing) until it is stable" {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString("N")); New-Item -ItemType Directory -Path $dir | Out-Null
        $state = @{}
        Set-Content -LiteralPath (Join-Path $dir "a.jpg") -Value "part"
        (Get-ReadyBatchOutputs -TempDir $dir -Stems @("a") -State $state).Count | Should -Be 0
        Add-Content -LiteralPath (Join-Path $dir "a.jpg") -Value "more bytes"
        (Get-ReadyBatchOutputs -TempDir $dir -Stems @("a") -State $state).Count | Should -Be 0
        $r = Get-ReadyBatchOutputs -TempDir $dir -Stems @("a") -State $state
        $r -join "," | Should -Be "a"
        (Get-ReadyBatchOutputs -TempDir $dir -Stems @("a") -State $state).Count | Should -Be 0 # reported once
    }

    It "does not report a file that is still locked by its writer, even at the final pass" {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString("N")); New-Item -ItemType Directory -Path $dir | Out-Null
        $path = Join-Path $dir "b.jpg"
        $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
        try {
            $fs.Write([byte[]](1..10), 0, 10); $fs.Flush()
            $state = @{}
            (Get-ReadyBatchOutputs -TempDir $dir -Stems @("b") -State $state).Count | Should -Be 0
            (Get-ReadyBatchOutputs -TempDir $dir -Stems @("b") -State $state).Count | Should -Be 0
            (Get-ReadyBatchOutputs -TempDir $dir -Stems @("b") -State $state -Final).Count | Should -Be 0
        } finally { $fs.Close() }
        (Get-ReadyBatchOutputs -TempDir $dir -Stems @("b") -State $state -Final) -join "," | Should -Be "b"
    }

    It "ignores empty files and stems that never appear" {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString("N")); New-Item -ItemType Directory -Path $dir | Out-Null
        New-Item -ItemType File -Path (Join-Path $dir "e.jpg") | Out-Null
        (Get-ReadyBatchOutputs -TempDir $dir -Stems @("e", "missing") -State @{} -Final).Count | Should -Be 0
    }
}
