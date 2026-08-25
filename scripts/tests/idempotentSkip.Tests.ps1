<#
  V7_PLAN.md Phase 3, task 1: a file whose output already exists is skipped, not reprocessed.
#>
BeforeAll {
    . "$PSScriptRoot/TestHelpers.ps1"
    . "$PSScriptRoot/../lib_common.ps1"
    $script:RealRepoRoot = Get-RealRepoRoot
    $script:AutoEnhancePath = Join-Path $RealRepoRoot "scripts\auto_enhance.ps1"
}

Describe "auto_enhance.ps1 - idempotent skip" {
    It "does not call Invoke-RawTherapee and logs Skipped when the output file already exists" {
        $fixture = New-EnhanceFixture -ArwNames @("photo1.ARW")
        # Pre-create the exact output the no-preset naming rule would produce.
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

        $logFile = Get-ChildItem -LiteralPath $fixture.LogDir -Filter "run_*.csv" | Select-Object -First 1
        $rows = Import-Csv -LiteralPath $logFile.FullName
        $rows.Count | Should -Be 1
        $rows[0].File | Should -Be "photo1.ARW"
        $rows[0].Status | Should -Be "Skipped"
    }
}
