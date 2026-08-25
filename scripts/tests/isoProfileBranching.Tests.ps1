<#
  V7_PLAN.md Phase 3, task 2: low- vs. high-ISO files pick lowIsoProfile/highIsoProfile per
  isoThreshold. Uses the real profiles/default.pp3 and profiles/lowlight.pp3 (see
  TestHelpers.ps1's design note - autoProfile's low/high paths are resolved against the real
  repo root unconditionally, with no override param).
#>
BeforeAll {
    . "$PSScriptRoot/TestHelpers.ps1"
    . "$PSScriptRoot/../lib_common.ps1"
    $script:RealRepoRoot = Get-RealRepoRoot
    $script:AutoEnhancePath = Join-Path $RealRepoRoot "scripts\auto_enhance.ps1"
    $script:DefaultProfilePath = Join-Path $RealRepoRoot "profiles\default.pp3"
    $script:LowlightProfilePath = Join-Path $RealRepoRoot "profiles\lowlight.pp3"
}

Describe "auto_enhance.ps1 - ISO-based profile branching" {
    It "picks lowIsoProfile below the threshold and highIsoProfile at/above it" {
        $fixture = New-EnhanceFixture -ArwNames @("low_iso.ARW", "high_iso.ARW")
        New-EnhanceConfigFile -Path (Join-Path $TestDrive "config.json") -Config @{
            exiftoolPath = $fixture.ExiftoolPath
            autoProfile  = @{ enabled = $true; isoThreshold = 800; lowIsoProfile = "default"; highIsoProfile = "lowlight" }
        }

        Set-SuccessfulRawTherapeeMock
        Mock Invoke-ExifTool -MockWith {
            param($ExiftoolPath, $FilePath)
            if ($FilePath -like "*low_iso*") { return "100" } else { return "1600" }
        }

        . $AutoEnhancePath `
            -InputDir $fixture.InputDir `
            -OutputDir $fixture.OutputDir `
            -LogDir $fixture.LogDir `
            -RTPath $fixture.RTPath `
            -ConfigPath (Join-Path $TestDrive "config.json")

        Should -Invoke Invoke-ExifTool -Times 2

        # -c <input file> is always the last two rtArgs (see auto_enhance.ps1's rtArgs build),
        # so RTArgs[-1] is the source .arw's full path - a reliable way to tell the two calls apart.
        $lowCall = $script:EnhanceMockCalls | Where-Object { $_.RTArgs[-1] -like "*low_iso*" }
        $highCall = $script:EnhanceMockCalls | Where-Object { $_.RTArgs[-1] -like "*high_iso*" }

        $lowCall.RTArgs | Should -Contain $DefaultProfilePath
        $highCall.RTArgs | Should -Contain $LowlightProfilePath

        $logFile = Get-ChildItem -LiteralPath $fixture.LogDir -Filter "run_*.csv" | Select-Object -First 1
        $rows = Import-Csv -LiteralPath $logFile.FullName
        ($rows | Where-Object { $_.File -eq "low_iso.ARW" }).ISO | Should -Be "100"
        ($rows | Where-Object { $_.File -eq "high_iso.ARW" }).ISO | Should -Be "1600"
    }
}
