<#
  V9: Test-IsRawFile / $SupportedRawExtensions (lib_common.ps1), used by auto_enhance.ps1,
  preview_presets.ps1, and watch_folder.ps1's file-discovery Where-Object filters. Mirrors
  webapp/server/tests/rawFormats.test.js on the JS side - the two lists must be kept in sync by
  hand (no shared code across JS/PowerShell), so both get their own explicit coverage.
#>
BeforeAll {
    . "$PSScriptRoot/../lib_common.ps1"
}

Describe "Test-IsRawFile / SupportedRawExtensions" {
    It "lists exactly the four V9 formats, lowercase, with a leading dot" {
        $SupportedRawExtensions | Should -Be @(".arw", ".nef", ".dng", ".raf")
    }

    It "accepts every supported extension, case-insensitively" {
        foreach ($name in @("photo.ARW", "photo.arw", "photo.NEF", "photo.nef", "photo.DNG", "photo.dng", "photo.RAF", "photo.raf")) {
            $file = [System.IO.FileInfo]::new((Join-Path $TestDrive $name))
            Test-IsRawFile $file | Should -BeTrue -Because "$name should be recognized as a raw file"
        }
    }

    It "rejects non-raw extensions and the deliberately-unsupported bare .raw" {
        foreach ($name in @("photo.jpg", "photo.raw", "photo.txt", "profile.pp3")) {
            $file = [System.IO.FileInfo]::new((Join-Path $TestDrive $name))
            Test-IsRawFile $file | Should -BeFalse -Because "$name should not be recognized as a raw file"
        }
    }

    It "a real Get-ChildItem | Where-Object Test-IsRawFile scan finds only the raw files in a mixed folder" {
        $dir = Join-Path $TestDrive "mixed"
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        foreach ($name in @("a.ARW", "b.NEF", "c.dng", "d.RAF", "e.jpg", "notes.txt")) {
            Set-Content -LiteralPath (Join-Path $dir $name) -Value "fake raw bytes"
        }

        $found = Get-ChildItem -LiteralPath $dir -File | Where-Object { Test-IsRawFile $_ } | Select-Object -ExpandProperty Name | Sort-Object
        $found | Should -Be @("a.ARW", "b.NEF", "c.dng", "d.RAF")
    }
}
